// Atak na API wg kryteriów CEO (etapy I i II) i zagrożeń CONTRACT.md §7 — Etap III (punkty Voucherify, mail Resend).
// Użycie: node scripts/attack.mjs [BASE_URL] [--slow] [--webhook-secret whsec_...] [--skip-b5] [--skip-loyalty]
//   BASE_URL          domyślnie http://localhost:3000
//   --slow            dodatkowo A2, B4, C2, C4: czeka, aż rezerwacje wygasną (TTL serwera + ok. 20 s)
//   --webhook-secret  TYLKO lokalnie: podpisuje własne zdarzenia Stripe tym sekretem (jak `stripe listen`)
//                     i sprawdza przyjęcie płatności, powtórki, złą kwotę, C2 i C4 na płatnościach
//   --skip-b5         bez zalewania API (B5) — zużywa do 40 miejsc na czas TTL
//   --skip-loyalty    bez scenariuszy punktów — zero wywołań Voucherify (sandbox: 100 na godzinę na projekt)
// Czysty Node 20+, bez zależności. Exit code 1, jeśli cokolwiek padło.
import { createHmac } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const VALUE_FLAGS = new Set(["--webhook-secret", "--ttl"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]));
const BASE = (positional[0] ?? "http://localhost:3000").replace(/\/$/, "");
const SLOW = flag("--slow");
const SKIP_B5 = flag("--skip-b5");
const SKIP_LOYALTY = flag("--skip-loyalty");
const WEBHOOK_SECRET = option("--webhook-secret");
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(BASE);

if (WEBHOOK_SECRET && !IS_LOCAL) {
  console.error("--webhook-secret wolno używać tylko z lokalnym serwerem (localhost) — nigdy na produkcji.");
  process.exit(2);
}

const CODE_REGEX = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const LEAK_PATTERNS = [/\bat [\w.<>]+ \(/, /Error:/, /Mongo/i, /\/Users\//, /node_modules/, /\.tsx?:\d+/, /sk_(test|live)_/, /whsec_/];
const EVENT_FIELDS = ["_id", "title", "startsAt", "seats", "price", "trainNumber", "from", "to", "arrivesAt", "wagons"];

/** Szacunek wywołań Voucherify, które wywołał atak (CONTRACT.md §3 „Budżet wywołań”). */
let voucherifyCalls = 0;
const VOUCHERIFY_BUDGET = 25;

// --- Wyniki ---

const results = [];
const notes = [];
const errorResponses = [];
let rateLimitWaits = 0;

function check(id, name, pass, detail = "") {
  results.push({ id, name, pass: Boolean(pass), detail });
  console.log(`${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${id.padEnd(4)} ${name}${detail ? `  — ${detail}` : ""}`);
}

function note(text) {
  notes.push(text);
  console.log(`\x1b[33mUWAGA\x1b[0m ${text}`);
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

const countBy = (values) => values.reduce((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- HTTP ---

/**
 * Jedno żądanie. Domyślnie 429 (limit 40 / 10 s z naszego IP) czeka Retry-After i ponawia —
 * limit nie może psuć scenariuszy, które go nie badają. `expect429: true` zwraca 429 bez ponawiania.
 */
async function request(method, path, { json, raw, headers = {}, duplex, expect429 = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const init = { method, headers: { ...headers } };
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      init.headers["content-type"] = "application/json";
    } else if (raw !== undefined) {
      init.body = raw;
    }
    if (duplex) init.duplex = duplex;

    let res;
    try {
      res = await fetch(BASE + path, init);
    } catch (err) {
      // Po 400 na ogromne body serwer zamyka gniazdo; kolejne żądanie może trafić w zamknięte (znane).
      if (attempt > 0) throw err;
      note(`zerwane połączenie keep-alive przy ${method} ${path.slice(0, 40)} (${err.cause?.code ?? err.message}) — ponawiam`);
      continue;
    }
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (res.status === 429 && !expect429 && attempt < 4) {
      const wait = Number(res.headers.get("retry-after")) || 10;
      rateLimitWaits++;
      await sleep(wait * 1000 + 300);
      continue;
    }
    const result = { status: res.status, body, text, headers: res.headers };
    if (res.status >= 400) errorResponses.push({ method, path, ...result });
    return result;
  }
}

const get = (path) => request("GET", path);
const reserve = (body, opts = {}) => request("POST", "/api/reservations", { json: body, ...opts });
const checkout = (id, opts = {}) => request("POST", `/api/reservations/${id}/checkout`, { json: {}, ...opts });
const isApiError = (r, code) =>
  r.body && typeof r.body.error === "string" && typeof r.body.message === "string" && (!code || r.body.error === code);
const is4xx = (r) => r.status >= 400 && r.status < 500;

// --- Klienci i miejsca ---

const RUN = Date.now().toString(36);
let clientCounter = 0;
const client = (label = "Atak") => {
  clientCounter++;
  return { customerName: `${label} ${clientCounter}`, email: `atak-${RUN}-${clientCounter}@example.com` };
};

/** Klient punktów: testowy adres Resend (mail z biletem dojdzie), nowy w każdym przebiegu — nowe konto z 1000 pkt. */
const loyaltyClient = (label = "Punkty") => {
  clientCounter++;
  return { customerName: `${label} ${clientCounter}`, email: `delivered+atk-${RUN}-${clientCounter}@resend.dev` };
};
const loyalty = (email) => get(`/api/loyalty?email=${encodeURIComponent(email)}`);
const checkoutPoints = (id, body, opts = {}) => checkout(id, { json: body, ...opts });

/** after() na serwerze nalicza punkty po odpowiedzi — odpytujemy saldo, aż dojdzie do oczekiwanego (≤ 10 s). */
async function waitForPoints(email, expected) {
  let last;
  for (let i = 0; i < 10; i++) {
    last = await loyalty(email);
    if (last.body?.points === expected) return last;
    await sleep(1000);
  }
  return last;
}

/** Kursy z wolnymi miejscami; miejsca wydajemy losowo i każde tylko raz. */
async function loadEvents() {
  const list = await get("/api/events");
  if (list.status !== 200 || !Array.isArray(list.body)) throw new Error(`GET /api/events → ${list.status}`);
  const pools = [];
  for (const event of list.body) {
    if (new Date(event.startsAt).getTime() <= Date.now() + 10 * 60 * 1000) continue;
    const details = await get(`/api/events/${encodeURIComponent(event._id)}`);
    const taken = new Set(details.body?.takenSeats ?? []);
    const free = event.seats.filter((s) => !taken.has(s));
    for (let i = free.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [free[i], free[j]] = [free[j], free[i]];
    }
    pools.push({ event, free, details });
  }
  pools.sort((a, b) => b.free.length - a.free.length);
  return { list, pools };
}

function seatFrom(pool) {
  const seat = pool.free.pop();
  if (!seat) throw new Error(`Brak wolnych miejsc w ${pool.event._id} — zrób npm run reset.`);
  return seat;
}

const takenSeats = async (eventId) => (await get(`/api/events/${encodeURIComponent(eventId)}`)).body?.takenSeats ?? [];

// --- Podpisane zdarzenia Stripe (tylko lokalnie) ---

function signedEvent(reservationId, { amount, created = Math.floor(Date.now() / 1000), currency = "pln" }) {
  const id = `evt_attack_${RUN}_${++clientCounter}`;
  const payload = JSON.stringify({
    id,
    object: "event",
    type: "checkout.session.completed",
    created,
    livemode: false,
    data: {
      object: {
        id: `cs_test_attack_${RUN}_${clientCounter}`,
        object: "checkout.session",
        payment_status: "paid",
        status: "complete",
        client_reference_id: reservationId,
        metadata: { reservationId },
        amount_total: amount,
        currency,
        payment_intent: null, // bez prawdziwej płatności — ewentualny zwrot zostaje tylko wpisem w bazie
      },
    },
  });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${payload}`).digest("hex");
  return { payload, signature: `t=${t},v1=${v1}` };
}

const sendWebhook = ({ payload, signature }) =>
  request("POST", "/api/webhooks/stripe", { raw: payload, headers: { "stripe-signature": signature } });

// --- Scenariusze ---

async function main() {
  console.log(`Atak na ${BASE}${SLOW ? " (z --slow)" : ""}${WEBHOOK_SECRET ? " (z podpisanymi webhookami)" : ""}`);
  const { list, pools } = await loadEvents();
  if (pools.length === 0) throw new Error("Brak kursów z wolnymi miejscami.");
  const main = pools[0];
  const E = main.event;
  console.log(`Kurs główny: ${E._id} (${E.title}), wolnych miejsc: ${main.free.length}`);

  section("Kontrakt i karta A");
  check(
    "API",
    "GET /api/events → 200, kursy z polami z §2 (z price)",
    list.status === 200 && list.body.every((e) => EVENT_FIELDS.every((f) => f in e) && Number.isInteger(e.price) && e.price > 0),
    `${list.body.length} kursów`,
  );
  check("API", "GET /api/events/:id → { event, takenSeats }", main.details.status === 200 && Array.isArray(main.details.body?.takenSeats));
  check("Z13", "API kursów ma Cache-Control: no-store", /no-store/.test(main.details.headers.get("cache-control") ?? ""));
  const a1 = await get("/api/events/nie-ma-takiego");
  check("A1", "GET /api/events/nie-ma-takiego → 4xx", is4xx(a1) && isApiError(a1, "EVENT_NOT_FOUND"), `${a1.status}`);

  section("Karta B — rezerwacja");
  // B1: identyczny POST 2× po kolei i 2× równolegle → ta sama rezerwacja (D6).
  const b1Seq = { eventId: E._id, seatId: seatFrom(main), ...client("B1") };
  const b1a = await reserve(b1Seq);
  const b1b = await reserve(b1Seq);
  check(
    "B1",
    "identyczny POST 2× po kolei → ta sama rezerwacja",
    b1a.status === 201 && b1b.status === 200 && b1a.body?.reservationId === b1b.body?.reservationId,
    `${b1a.status}/${b1b.status}`,
  );
  check("API", "201 { reservationId, expiresAt, amount = cena kursu }", /^[0-9a-f]{24}$/.test(b1a.body?.reservationId ?? "") && b1a.body?.amount === E.price);
  const b1Par = { eventId: E._id, seatId: seatFrom(main), ...client("B1") };
  const b1p = await Promise.all([reserve(b1Par), reserve(b1Par)]);
  check(
    "B1",
    "identyczny POST 2× równolegle → jedna rezerwacja, druga odpowiedź to ta sama",
    b1p.every((r) => r.status === 200 || r.status === 201) &&
      b1p.filter((r) => r.status === 201).length === 1 &&
      b1p[0].body?.reservationId === b1p[1].body?.reservationId,
    JSON.stringify(b1p.map((r) => r.status)),
  );

  // B2: 20 równoczesnych rezerwacji jednego miejsca od różnych klientów.
  const b2Seat = seatFrom(main);
  const b2 = await Promise.all(Array.from({ length: 20 }, () => reserve({ eventId: E._id, seatId: b2Seat, ...client("B2") }, { expect429: true })));
  const b2Counts = countBy(b2.map((r) => r.status));
  check(
    "B2",
    "20 równoczesnych rezerwacji jednego miejsca → dokładnie 1×2xx, reszta 4xx",
    b2.filter((r) => r.status >= 200 && r.status < 300).length === 1 && b2.every((r) => r.status < 300 || is4xx(r)),
    JSON.stringify(b2Counts),
  );
  check("B2", "miejsce z B2 jest w takenSeats", (await takenSeats(E._id)).includes(b2Seat));

  // B3: zły request → 4xx i nic nie zapisane.
  const b3Seat = seatFrom(main);
  const b3Cases = [
    ["nieistniejące wydarzenie", { eventId: "nie-ma-takiego-kursu", seatId: b3Seat, ...client("B3") }],
    ["nieistniejące miejsce", { eventId: E._id, seatId: "9-99", ...client("B3") }],
    ["puste imię", { eventId: E._id, seatId: b3Seat, customerName: "   ", email: `b3-${RUN}@example.com` }],
    ["pusty e-mail", { eventId: E._id, seatId: b3Seat, customerName: "B3 Pusty", email: "" }],
  ];
  for (const [label, body] of b3Cases) {
    const r = await reserve(body);
    check("B3", `${label} → 4xx`, is4xx(r) && isApiError(r), `${r.status} ${r.body?.error ?? ""}`);
  }
  check("B3", "żadne złe żądanie nic nie zapisało", !(await takenSeats(E._id)).includes(b3Seat));

  // Z6: śmieciowe body.
  const valid = { eventId: E._id, seatId: b3Seat, customerName: "Jan Kowalski", email: "jan@example.com" };
  const garbage = [
    ["brak body", { raw: "" }],
    ['"nie-json"', { raw: "nie-json" }],
    ["[]", { raw: "[]" }],
    ["null", { raw: "null" }],
    ['{"eventId":{"$ne":null}}', { json: { ...valid, eventId: { $ne: null } } }],
    ["seatId jako liczba", { json: { ...valid, seatId: 7 } }],
    ["customerName 10 000 znaków", { json: { ...valid, customerName: "x".repeat(10_000) } }],
    ["customerName ze znakiem \\n", { json: { ...valid, customerName: "Jan\nKowalski" } }],
    ['e-mail "jan@localhost"', { json: { ...valid, email: "jan@localhost" } }],
    ["niepoprawne UTF-8", { raw: new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]) }],
    ["body 1 MB", { raw: "x".repeat(1024 * 1024) }],
  ];
  for (const [label, opts] of garbage) {
    const r = await request("POST", "/api/reservations", opts);
    check("Z6", `śmieciowe body: ${label} → 400`, r.status === 400 && isApiError(r, "VALIDATION_ERROR"), `${r.status}`);
  }
  check("Z6", "żadne śmieci nie zajęły miejsca", !(await takenSeats(E._id)).includes(b3Seat));

  section("Karta C — płatność (checkout)");
  const c1Res = await reserve({ eventId: E._id, seatId: seatFrom(main), ...client("C1") });
  const c1Id = c1Res.body?.reservationId;
  const c1a = await checkout(c1Id);
  if (c1a.status === 503) {
    note("checkout → 503 PAYMENT_UNAVAILABLE: na serwerze brak STRIPE_SECRET_KEY (sk_test_) albo APP_URL — scenariusze C1 nie mają sensu.");
  }
  const c1b = await checkout(c1Id);
  check(
    "C1",
    "checkout 2× po kolei → 200 i ten sam url strony Stripe",
    c1a.status === 200 && c1b.status === 200 && c1a.body?.url === c1b.body?.url && /^https:\/\/checkout\.stripe\.com\//.test(c1a.body?.url ?? ""),
    `${c1a.status}/${c1b.status}`,
  );
  const c1ParRes = await reserve({ eventId: E._id, seatId: seatFrom(main), ...client("C1") });
  const c1Par = await Promise.all(Array.from({ length: 5 }, () => checkout(c1ParRes.body?.reservationId)));
  check(
    "C1",
    "checkout 5× równolegle → wszystkie 200 z jednym url",
    c1Par.every((r) => r.status === 200) && new Set(c1Par.map((r) => r.body?.url)).size === 1,
    JSON.stringify(countBy(c1Par.map((r) => r.status))),
  );
  for (const [label, id] of [
    ["nieistniejącej rezerwacji", "0123456789abcdef01234567"],
    ["z błędnym id abc", "abc"],
    ["z id 12 znaków", "aaaaaaaaaaaa"],
    ["z id 24 hex wielkimi literami", (c1Id ?? "").toUpperCase()],
  ]) {
    const r = await checkout(id);
    check("C3", `checkout ${label} → 4xx`, r.status === 404 && isApiError(r, "RESERVATION_NOT_FOUND"), `${r.status}`);
  }
  const legacy = await request("POST", `/api/reservations/${c1Id}/purchase`);
  check("D5", "stary /purchase na nieopłaconej → 402 PAYMENT_REQUIRED (bez biletu)", legacy.status === 402 && isApiError(legacy, "PAYMENT_REQUIRED"));
  const held = await get(`/api/reservations/${c1Id}`);
  check(
    "API",
    "GET /api/reservations/:id → held, amount, serverNow, bez code",
    held.status === 200 && held.body?.status === "held" && held.body?.amount === E.price && held.body?.serverNow && !("code" in held.body),
  );
  check("Z11", "GET rezerwacji nie zawiera e-maila", held.status === 200 && !held.text.includes("@example.com") && !("email" in (held.body ?? {})));
  const fakeReturn = await request("GET", `/payment/success?reservationId=${c1Id}`);
  check(
    "Z30",
    "/payment/success bez płatności → strona bez kodu biletu, rezerwacja dalej held",
    fakeReturn.status === 200 && !/[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/.test(fakeReturn.text) && (await get(`/api/reservations/${c1Id}`)).body?.status === "held",
  );

  section("Webhook Stripe");
  const unsigned = await request("POST", "/api/webhooks/stripe", { raw: JSON.stringify({ type: "checkout.session.completed" }) });
  check("Z27", "webhook bez podpisu → 400", unsigned.status === 400 && isApiError(unsigned, "INVALID_SIGNATURE"), `${unsigned.status}`);
  const forged = await request("POST", "/api/webhooks/stripe", {
    raw: JSON.stringify({ id: "evt_forged", type: "checkout.session.completed", data: { object: { client_reference_id: c1Id, payment_status: "paid" } } }),
    headers: { "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` },
  });
  check("Z27", "webhook ze sfałszowanym podpisem → 400, rezerwacja nietknięta", forged.status === 400 && (await get(`/api/reservations/${c1Id}`)).body?.status === "held", `${forged.status}`);

  let paidId;
  let paidCode;
  if (WEBHOOK_SECRET) {
    const payRes = await reserve({ eventId: E._id, seatId: seatFrom(main), ...client("Platnik") });
    paidId = payRes.body?.reservationId;
    const ev = signedEvent(paidId, { amount: E.price });
    const w1 = await sendWebhook(ev);
    const after = await get(`/api/reservations/${paidId}`);
    paidCode = after.body?.code;
    check("Z28", "podpisane checkout.session.completed → 200, status paid i kod", w1.status === 200 && after.body?.status === "paid" && CODE_REGEX.test(paidCode ?? ""), `${w1.status} ${after.body?.status}`);
    const w2 = await sendWebhook(ev);
    check("Z28", "to samo zdarzenie drugi raz → 200, ten sam kod", w2.status === 200 && (await get(`/api/reservations/${paidId}`)).body?.code === paidCode);
    const again = await checkout(paidId);
    check("C1", "checkout opłaconej → 409 ALREADY_PAID", again.status === 409 && isApiError(again, "ALREADY_PAID"));
    const ticket = await get(`/api/tickets/${(paidCode ?? "").toLowerCase()}`);
    check("API", "GET /api/tickets/:code (małymi literami) → bilet z amount, bez e-maila", ticket.status === 200 && ticket.body?.amount === E.price && !ticket.text.includes("@example.com"));
    const legacyPaid = await request("POST", `/api/reservations/${paidId}/purchase`);
    check("D5", "stary /purchase na opłaconej → 200 z tym samym kodem", legacyPaid.status === 200 && legacyPaid.body?.code === paidCode);

    const wrongRes = await reserve({ eventId: E._id, seatId: seatFrom(main), ...client("ZlaKwota") });
    const wrong = await sendWebhook(signedEvent(wrongRes.body?.reservationId, { amount: 1 }));
    check("Z29", "płatność na złą kwotę → 200, bez biletu (zwrot)", wrong.status === 200 && (await get(`/api/reservations/${wrongRes.body?.reservationId}`)).body?.status === "held");
    const missing = await sendWebhook(signedEvent("0123456789abcdef01234567", { amount: E.price }));
    check("Z28", "zdarzenie dla nieistniejącej rezerwacji → 200 i nic", missing.status === 200);
  } else {
    note("bez --webhook-secret: przyjęcie płatności, powtórki i zła kwota nie są sprawdzane (lokalnie dodaj sekret, na produkcji zapłać kartą 4242 ręcznie).");
  }

  let refundCase = null;
  if (!SKIP_LOYALTY) {
    section("Punkty — karta A (saldo)");
    const noEmail = await get("/api/loyalty");
    check("Z37", "GET /api/loyalty bez e-maila → 400", noEmail.status === 400 && isApiError(noEmail, "VALIDATION_ERROR"), `${noEmail.status}`);
    const badEmail = await loyalty("to-nie-email");
    check("Z37", "GET /api/loyalty ze złym e-mailem → 400", badEmail.status === 400 && isApiError(badEmail, "VALIDATION_ERROR"), `${badEmail.status}`);
    const injected = await get("/api/loyalty?email[$ne]=x");
    check("Z6", "GET /api/loyalty z email[$ne] → 400, nigdy 5xx", injected.status === 400, `${injected.status}`);

    const p = loyaltyClient("Punkty");
    const fresh = await loyalty(p.email);
    voucherifyCalls += 1; // jedno wyszukanie karty, potem 10 min z pamięci
    if (fresh.status === 503) note("GET /api/loyalty → 503 LOYALTY_UNAVAILABLE: Voucherify nie działa albo brak kluczy na serwerze.");
    check(
      "A",
      "nowy e-mail → 200 { email, points: 1000 }, nic więcej (Z49)",
      fresh.status === 200 && fresh.body?.points === 1000 && Object.keys(fresh.body ?? {}).sort().join() === "email,points",
      `${fresh.status} ${fresh.text.slice(0, 80)}`,
    );
    const upper = await loyalty(p.email.toUpperCase());
    check("Z52", "ten sam e-mail wielkimi literami → ten sam klient (e-mail małymi literami)", upper.status === 200 && upper.body?.email === p.email && upper.body?.points === 1000, `${upper.body?.email}`);

    section("Punkty — karta B (płatność punktami)");
    const maxPoints = Math.floor(E.price / 2);
    const pRes = await reserve({ eventId: E._id, seatId: seatFrom(main), ...p });
    const pId = pRes.body?.reservationId;
    const before = await get(`/api/reservations/${pId}`);
    check(
      "API",
      "GET rezerwacji przed „Zapłać” → pointsUsed 0, cardAmount = amount, pointsEarned null",
      before.body?.pointsUsed === 0 && before.body?.cardAmount === E.price && before.body?.pointsEarned === null,
    );
    const hint = await get(`/api/reservations/${pId}/points`);
    check(
      "B",
      `podpowiedź → balance 1000, maxPoints 1000, locked false, bez e-maila`,
      hint.status === 200 && hint.body?.balance === 1000 && hint.body?.maxPoints === Math.min(1000, maxPoints) && hint.body?.locked === false && !hint.text.includes("@"),
      `${hint.status} ${hint.text.slice(0, 80)}`,
    );
    for (const [label, body] of [
      ['"100" (tekst)', { points: "100" }],
      ["1.5", { points: 1.5 }],
      ["-1", { points: -1 }],
      ["null", { points: null }],
      ["{}", { points: {} }],
      ["1e300", { points: 1e300 }],
    ]) {
      const r = await checkoutPoints(pId, body);
      check("Z37", `checkout z points ${label} → 400 VALIDATION_ERROR`, r.status === 400 && isApiError(r, "VALIDATION_ERROR"), `${r.status}`);
    }
    const notJson = await checkout(pId, { json: undefined, raw: "{points:", headers: { "content-type": "application/json" } });
    check("Z37", "checkout z zepsutym JSON → 400", notJson.status === 400, `${notJson.status}`);
    const over = await checkoutPoints(pId, { points: maxPoints + 1 });
    check("Z37", `points ponad połowę ceny (${maxPoints + 1}) → 400 POINTS_OVER_LIMIT z maxPoints ${maxPoints}`, over.status === 400 && isApiError(over, "POINTS_OVER_LIMIT") && over.body?.maxPoints === maxPoints, `${over.status}`);
    if (maxPoints > 1000) {
      const tooMany = await checkoutPoints(pId, { points: 1001 });
      voucherifyCalls += 1; // świeże saldo przed pobraniem
      check("Z36", "więcej punktów niż saldo (1001 przy 1000) → 409 INSUFFICIENT_POINTS z balance", tooMany.status === 409 && isApiError(tooMany, "INSUFFICIENT_POINTS") && tooMany.body?.balance === 1000, `${tooMany.status} ${tooMany.body?.error}`);
    }
    check("Z43", "odmowy punktowe nie zakładają sesji płatności", (await get(`/api/reservations/${pId}`)).body?.pointsUsed === 0);

    const par = await Promise.all(Array.from({ length: 5 }, () => checkoutPoints(pId, { points: 1000 })));
    voucherifyCalls += 7; // klient, członek, +1000 i sprawdzenie, świeże saldo, pobranie i sprawdzenie
    const cardAmount = E.price - 1000;
    check(
      "Z38",
      "„Zapłać” z 1000 pkt 5× równolegle → 200, jeden url, pointsUsed 1000, cardAmount = cena − 1000",
      par.every((r) => r.status === 200 && r.body?.pointsUsed === 1000 && r.body?.cardAmount === cardAmount) && new Set(par.map((r) => r.body?.url)).size === 1,
      par.map((r) => `${r.status}${r.body?.error ? ` ${r.body.error}` : ""}`).join(", "),
    );
    const locked = await checkoutPoints(pId, { points: 500 });
    check("Z45", "inna liczba punktów po pierwszym „Zapłać” → 409 POINTS_LOCKED z pointsUsed 1000", locked.status === 409 && isApiError(locked, "POINTS_LOCKED") && locked.body?.pointsUsed === 1000, `${locked.status}`);
    const again = await checkout(pId);
    check("D16", "„Zapłać ponownie” bez points → ten sam url", again.status === 200 && again.body?.url === par[0].body?.url);
    const afterPay = await get(`/api/reservations/${pId}`);
    check("API", "GET rezerwacji → pointsUsed 1000, cardAmount, pointsEarned null", afterPay.body?.pointsUsed === 1000 && afterPay.body?.cardAmount === cardAmount && afterPay.body?.pointsEarned === null);
    const hintLocked = await get(`/api/reservations/${pId}/points`);
    check("D16", "podpowiedź po „Zapłać” → locked true, maxPoints = pointsUsed", hintLocked.body?.locked === true && hintLocked.body?.maxPoints === 1000 && hintLocked.body?.pointsUsed === 1000);
    const spentBalance = await loyalty(p.email);
    voucherifyCalls += 1;
    check("Z38", "saldo po pobraniu → 0 (punkty zeszły dokładnie raz)", spentBalance.body?.points === 0, `${spentBalance.body?.points}`);

    // II.A1 na Etapie III: kwota z body ignorowana także obok punktów.
    const a1Res = await reserve({ eventId: E._id, seatId: seatFrom(main), ...client("IIA1") });
    const a1 = await checkoutPoints(a1Res.body?.reservationId, { amount: 100 });
    check("Z53", "checkout z { amount: 100 } → sesja na pełną kwotę z bazy (II.A1)", a1.status === 200 && a1.body?.cardAmount === E.price && a1.body?.pointsUsed === 0, `${a1.status} ${a1.body?.cardAmount}`);

    if (WEBHOOK_SECRET) {
      const pay = signedEvent(pId, { amount: cardAmount });
      const w1 = await sendWebhook(pay);
      const earned = Math.floor(cardAmount / 100) * 10;
      const paid = await get(`/api/reservations/${pId}`);
      check("D18", `płatność ${cardAmount / 100} zł kartą → paid, pointsEarned ${earned}`, w1.status === 200 && paid.body?.status === "paid" && paid.body?.pointsEarned === earned, `${paid.body?.status} ${paid.body?.pointsEarned}`);
      const w2 = await sendWebhook(pay);
      const balance = await waitForPoints(p.email, earned);
      voucherifyCalls += 2; // naliczenie + odczyt salda
      check("Z41", `powtórzony webhook → 200, saldo ${earned} (punkty naliczone raz)`, w2.status === 200 && balance.body?.points === earned, `${balance.body?.points}`);
      const ticket = await get(`/api/tickets/${paid.body?.code}`);
      check("C", "bilet → pointsUsed 1000, cardAmount, pointsEarned", ticket.body?.pointsUsed === 1000 && ticket.body?.cardAmount === cardAmount && ticket.body?.pointsEarned === earned);
      note("mail z biletem: przy MAIL_PROVIDER=log sprawdź w logu serwera, że jest dokładnie jeden „[mail] (log)” dla " + p.email);
    } else {
      note("bez --webhook-secret: naliczenie punktów po płatności nie jest sprawdzane (na produkcji: zapłać kartą 4242 i sprawdź saldo).");
    }

    if (SLOW) {
      // Z39: punkty pobrane, a klient nie płaci — po wygaśnięciu wracają. Rezerwację zakładamy teraz, sprawdzamy w --slow.
      const r = loyaltyClient("Zwrot");
      const rRes = await reserve({ eventId: E._id, seatId: seatFrom(main), ...r });
      const spent = await checkoutPoints(rRes.body?.reservationId, { points: 500 });
      voucherifyCalls += 7;
      if (spent.status === 200) refundCase = { email: r.email, id: rRes.body?.reservationId };
      else check("Z39", "przygotowanie zwrotu: „Zapłać” z 500 pkt → 200", false, `${spent.status} ${spent.body?.error}`);
    }
  }

  if (SLOW) {
    section("--slow: wygasanie (A2, B4, C4) i wyścig w chwili wygaśnięcia (C2)");
    const slowPool = pools.find((p) => p !== main && p.free.length >= 8) ?? main;
    const SE = slowPool.event;
    const a2Seat = seatFrom(slowPool);
    const a2 = await reserve({ eventId: SE._id, seatId: a2Seat, ...client("A2") });
    const c4Late = await reserve({ eventId: SE._id, seatId: seatFrom(slowPool), ...client("C4") });
    const c2 = [];
    for (let i = 0; i < 5; i++) {
      const seat = seatFrom(slowPool);
      const x = await reserve({ eventId: SE._id, seatId: seat, ...client("C2-X") });
      c2.push({ seat, x });
    }
    if (paidId) note(`C4: opłacona rezerwacja ${paidId} — sprawdzę, że po czasie dalej jest opłacona.`);

    const expiresAt = Date.parse(a2.body?.expiresAt);
    const offset = Date.parse((await get(`/api/reservations/${a2.body?.reservationId}`)).body?.serverNow) - Date.now();
    const untilExpiry = expiresAt - (Date.now() + offset);
    console.log(`      … czekam ${Math.round(untilExpiry / 1000)} s do wygaśnięcia rezerwacji`);
    await sleep(Math.max(0, untilExpiry - 300));

    // C2 (5 razy naraz, na 5 miejscach): w chwili wygaśnięcia X płaci (albo klika „Zapłać”), a Y rezerwuje.
    const races = await Promise.all(
      c2.map(async ({ seat, x }) => {
        const xId = x.body?.reservationId;
        const xAction = WEBHOOK_SECRET
          ? sendWebhook(signedEvent(xId, { amount: SE.price, created: Math.floor(Date.parse(x.body?.expiresAt) / 1000) }))
          : checkout(xId);
        const [xr, yr] = await Promise.all([xAction, reserve({ eventId: SE._id, seatId: seat, ...client("C2-Y") })]);
        const xStatus = (await get(`/api/reservations/${xId}`)).body?.status;
        const xOwns = WEBHOOK_SECRET ? xStatus === "paid" : xStatus === "held";
        const yOwns = yr.status === 201;
        return { xr: xr.status, yr: yr.status, xStatus, owners: Number(xOwns) + Number(yOwns) };
      }),
    );
    check(
      "C2",
      `5× w chwili wygaśnięcia: ${WEBHOOK_SECRET ? "płatność X" : "„Zapłać” X"} i rezerwacja Y → zawsze jeden właściciel`,
      races.every((r) => r.owners <= 1 && r.xr < 500 && r.yr < 500),
      races.map((r) => `X:${r.xr}/${r.xStatus} Y:${r.yr}`).join(", "),
    );

    // A2: miejsce znika z takenSeats najpóźniej 15 s po expiresAt.
    let goneAfter = null;
    for (let i = 0; i < 16; i++) {
      if (!(await takenSeats(SE._id)).includes(a2Seat)) {
        goneAfter = Math.max(0, Date.now() + offset - expiresAt);
        break;
      }
      await sleep(1000);
    }
    check("A2", "po expiresAt miejsca nie ma w takenSeats najpóźniej po 15 s", goneAfter !== null && goneAfter <= 15_000, goneAfter === null ? "nie zniknęło" : `${(goneAfter / 1000).toFixed(1)} s`);

    // B4: inna osoba rezerwuje to samo miejsce najpóźniej 15 s po expiresAt.
    const b4 = await reserve({ eventId: SE._id, seatId: a2Seat, ...client("B4") });
    const b4At = Date.now() + offset - expiresAt;
    check("B4", "po wygaśnięciu inna osoba rezerwuje to samo miejsce (≤ 15 s)", b4.status === 201 && b4At <= 15_000, `${b4.status} po ${(b4At / 1000).toFixed(1)} s`);

    // C4: płatność po czasie → odmowa 4xx; opłacone miejsce dalej zajęte.
    const late = await checkout(c4Late.body?.reservationId);
    check("C4", "checkout po upływie czasu → 410 RESERVATION_EXPIRED", late.status === 410 && isApiError(late, "RESERVATION_EXPIRED"), `${late.status}`);
    if (paidId) {
      check("C4", "opłacona rezerwacja po czasie dalej paid (miejsce zajęte)", (await get(`/api/reservations/${paidId}`)).body?.status === "paid");
    }

    if (refundCase) {
      // D17: zwrot punktów rusza 30 s po expiresAt (zapas na płatność w ostatniej chwili, D8).
      const rExp = Date.parse((await get(`/api/reservations/${refundCase.id}`)).body?.expiresAt ?? "");
      const wait = rExp + 31_000 - (Date.now() + offset);
      if (wait > 0) {
        console.log(`      … czekam ${Math.round(wait / 1000)} s na zwrot punktów (30 s po wygaśnięciu)`);
        await sleep(wait);
      }
      const expired = await get(`/api/reservations/${refundCase.id}`);
      const back = await waitForPoints(refundCase.email, 1000);
      voucherifyCalls += 2;
      check("Z39", "nieopłacona rezerwacja z 500 pkt wygasła → punkty wróciły (saldo 1000)", expired.body?.status === "expired" && back.body?.points === 1000, `${expired.body?.status} ${back.body?.points}`);
      const late = await checkout(refundCase.id);
      check("Z40", "po zwrocie punktów „Zapłać” → 410 (bez biletu za darmo)", late.status === 410, `${late.status}`);
    }
  }

  if (!SKIP_B5) {
    section("B5 — nadmiar ruchu");
    // Miejsce „drugiego klienta” odkładamy przed zalewem, żeby zalew go nie zajął.
    const secondClientSeat = seatFrom(main);
    // Świeże okno limitu, żeby wynik nie zależał od poprzednich scenariuszy.
    await sleep(10_500);
    const flood = [];
    const seats = pools.flatMap((p) => p.free.map((seat) => ({ eventId: p.event._id, seat })));
    const started = Date.now();
    for (let i = 0; i < 100; i++) {
      const s = seats[i % Math.max(1, seats.length)];
      flood.push(reserve({ eventId: s.eventId, seatId: s.seat, ...client("B5") }, { expect429: true }));
      if (i % 10 === 9) await sleep(50);
    }
    const floodRes = await Promise.all(flood);
    const tookMs = Date.now() - started;
    const limited = floodRes.filter((r) => r.status === 429);
    const retryAfterOk = limited.length > 0 && limited.every((r) => Number(r.headers.get("retry-after")) >= 1 && isApiError(r, "RATE_LIMITED"));
    check(
      "B5",
      "100 rezerwacji z jednego klienta w 10 s → po limicie 429 z Retry-After, bez 5xx",
      retryAfterOk && floodRes.every((r) => r.status < 500),
      `${JSON.stringify(countBy(floodRes.map((r) => r.status)))} w ${tookMs} ms`,
    );
    if (IS_LOCAL) {
      const spoofed = await reserve(
        { eventId: E._id, seatId: secondClientSeat, ...client("B5-spoof") },
        { expect429: true, headers: { "x-forwarded-for": "198.51.100.23", "x-real-ip": "198.51.100.23" } },
      );
      check("B5", "drugi klient (lokalnie: inny x-forwarded-for) rezerwuje bez problemu", spoofed.status === 201, `${spoofed.status}`);
      note("lokalnie nagłówki IP są zaufane — na produkcji skrypt sprawdza, że podrobione NIE omijają limitu.");
    } else {
      // Kubełek checkout i nieistniejąca rezerwacja: nic nie zajmujemy. Żądanie kontrolne (bez podrabiania)
      // pokazuje, czy jesteśmy nadal w tym samym oknie — inaczej wynik nic nie mówi i powtarzamy.
      let verdict = null;
      for (let attempt = 0; attempt < 3 && !verdict; attempt++) {
        await sleep(10_500);
        await Promise.all(Array.from({ length: 45 }, () => checkout("abc", { expect429: true })));
        const [spoof, control] = await Promise.all([
          checkout("abc", { expect429: true, headers: { "x-forwarded-for": "198.51.100.23", "x-real-ip": "198.51.100.23" } }),
          checkout("abc", { expect429: true }),
        ]);
        if (control.status === 429) verdict = { spoof: spoof.status };
      }
      check(
        "B5",
        "podrobiony x-forwarded-for / x-real-ip nie omija limitu (Vercel ustawia je sam)",
        verdict !== null && verdict.spoof === 429,
        verdict ? `podrobione → ${verdict.spoof}` : "okno limitu przełączało się w trakcie — brak wyniku",
      );
      note("B5 „drugi klient z innej sieci” sprawdź ręcznie: zarezerwuj z telefonu na LTE w trakcie zalewania.");
    }
  } else {
    note("pominięto B5 (--skip-b5).");
  }

  section("Format błędów i wycieki");
  const jsonErrors = errorResponses.filter((r) => r.body !== undefined);
  check("§4", "każdy błąd JSON ma { error, message } jako stringi", jsonErrors.every((r) => isApiError(r)), `${jsonErrors.length} odpowiedzi`);
  const leaks = errorResponses.filter((r) => LEAK_PATTERNS.some((p) => p.test(r.text)));
  check("Z12", "żaden błąd nie zdradza stack trace, Mongo, ścieżek ani kluczy", leaks.length === 0, leaks.map((l) => l.path.slice(0, 40)).join(", "));
  const fiveXX = errorResponses.filter((r) => r.status >= 500);
  check("Z12", "żadna odpowiedź nie była 5xx", fiveXX.length === 0, fiveXX.map((r) => `${r.method} ${r.path.slice(0, 40)} → ${r.status}`).join(", "));
}

try {
  await main();
} catch (err) {
  check("!!!", "atak przerwany", false, err instanceof Error ? err.message : String(err));
}

if (rateLimitWaits) note(`${rateLimitWaits}× czekałem na Retry-After (limit 40 / 10 s działa także na moje scenariusze).`);
if (!SKIP_LOYALTY) {
  note(`szacowane wywołania Voucherify: ~${voucherifyCalls} (budżet ataku ${VOUCHERIFY_BUDGET}, limit sandboxa 100 na godzinę na projekt).`);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} PASS${failed.length ? `, ${failed.length} FAIL:` : ""}`);
for (const f of failed) console.log(`  ✗ ${f.id} ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
process.exit(failed.length ? 1 : 0);
