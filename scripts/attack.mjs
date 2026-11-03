// Atak na API wg CONTRACT.md §7 — lider sprawdza system tak, jak zrobi to CEO.
// Użycie: node scripts/attack.mjs [BASE_URL] [--slow] [--ttl 120]
//   BASE_URL  domyślnie http://localhost:3000
//   --slow    dodatkowo czeka TTL + 1 s i sprawdza wygasanie (Z2, Z3)
//   --ttl N   RESERVATION_TTL_SECONDS serwera (domyślnie 120)
// Czysty Node 20+, bez zależności. Exit code 1, jeśli cokolwiek padło.

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--ttl");
const BASE = (positional[0] ?? "http://localhost:3000").replace(/\/$/, "");
const SLOW = flag("--slow");
const TTL = Number(option("--ttl", "120"));

const CODE_REGEX = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const LEAK_PATTERNS = [/\bat [\w.<>]+ \(/, /Error:/, /Mongo/i, /\/Users\//, /node_modules/, /\.tsx?:\d+/];
const EVENT_FIELDS = ["_id", "title", "startsAt", "seats", "trainNumber", "from", "to", "arrivesAt", "wagons"];

// --- Wyniki ---

const results = [];
const errorResponses = [];
// Zerwane połączenia keep-alive (ECONNRESET) — ponawiamy raz i raportujemy osobno.
const connectionResets = [];

function check(id, name, pass, detail = "") {
  results.push({ id, name, pass: Boolean(pass), detail });
  console.log(`${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${id.padEnd(5)} ${name}${detail ? `  — ${detail}` : ""}`);
}

function countBy(values) {
  return values.reduce((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});
}

// --- HTTP ---

async function request(method, path, { json, raw, headers = {}, duplex } = {}) {
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
    // Po odpowiedzi 400 na ogromne body serwer zamyka gniazdo bez doczytania body, a klient
    // może trafić następnym żądaniem w to zamknięte gniazdo. Ponawiamy raz (tylko bez body).
    if (init.body !== undefined) throw err;
    connectionResets.push(`${method} ${path.slice(0, 50)} (${err.cause?.code ?? err.message})`);
    res = await fetch(BASE + path, init);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const result = { status: res.status, body, text, headers: res.headers };
  if (res.status >= 400) errorResponses.push({ method, path, ...result });
  return result;
}

const get = (path) => request("GET", path);
const reserve = (body) => request("POST", "/api/reservations", { json: body });
const purchase = (id) => request("POST", `/api/reservations/${id}/purchase`, { json: {} });

const isApiError = (r, code) =>
  r.body && typeof r.body.error === "string" && typeof r.body.message === "string" && (!code || r.body.error === code);

// --- Przygotowanie: kurs i wolne miejsca ---

const ATTACK_EMAIL = `atak-${Date.now()}@example.com`;
let customerCounter = 0;
const customer = () => ({ customerName: `Atak Testowy ${++customerCounter}`, email: ATTACK_EMAIL });

async function pickEvent() {
  const list = await get("/api/events");
  if (list.status !== 200 || !Array.isArray(list.body)) throw new Error(`GET /api/events → ${list.status}`);
  for (const event of list.body) {
    if (new Date(event.startsAt).getTime() <= Date.now() + 10 * 60 * 1000) continue;
    const details = await get(`/api/events/${encodeURIComponent(event._id)}`);
    const taken = new Set(details.body?.takenSeats ?? []);
    const free = event.seats.filter((s) => !taken.has(s));
    if (free.length >= 4) return { event, free, list, details };
  }
  throw new Error("Brak kursu z co najmniej 4 wolnymi miejscami — zrób npm run reset.");
}

function takeRandom(free, n) {
  const pool = [...free];
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return out;
}

// Z21: każda udana rezerwacja trzyma miejsce najdłużej do odjazdu.
const successfulReservations = [];
function remember(res, event) {
  if (res.status === 201 && res.body?.expiresAt) successfulReservations.push({ expiresAt: res.body.expiresAt, event });
}

// --- Scenariusze ---

async function main() {
  console.log(`Atak na ${BASE}${SLOW ? ` (z --slow, TTL ${TTL} s)` : ""}\n`);
  const { event, free, list, details } = await pickEvent();
  const [seatRace, seatSlow, seatSpare] = takeRandom(free, 3);
  const eventPath = `/api/events/${encodeURIComponent(event._id)}`;
  console.log(`Kurs: ${event._id} (${event.title})`);
  console.log(`Miejsca zużyte przez atak: ${seatRace} (kupione na stałe)${SLOW ? `, ${seatSlow} (wygasa i wraca)` : ""}\n`);

  // Kontrakt
  check(
    "API",
    "GET /api/events → 200, tablica kursów z polami z §2",
    list.status === 200 && list.body.every((e) => EVENT_FIELDS.every((f) => f in e)),
    `${list.body.length} kursów`,
  );
  check(
    "API",
    "GET /api/events/:id → { event, takenSeats }",
    details.status === 200 && details.body?.event?._id === event._id && Array.isArray(details.body?.takenSeats),
  );
  check("Z13", "API kursów ma Cache-Control: no-store", /no-store/.test(details.headers.get("cache-control") ?? ""));

  // Z1: 50 równoległych rezerwacji jednego miejsca
  const race = await Promise.all(
    Array.from({ length: 50 }, () => reserve({ eventId: event._id, seatId: seatRace, ...customer() })),
  );
  const raceCounts = countBy(race.map((r) => r.status));
  const winner = race.find((r) => r.status === 201);
  race.forEach((r) => remember(r, event));
  check(
    "Z1",
    "50 równoległych rezerwacji tego samego miejsca → 1×201, 49×409 SEAT_TAKEN",
    raceCounts[201] === 1 && raceCounts[409] === 49 && race.filter((r) => r.status === 409).every((r) => isApiError(r, "SEAT_TAKEN")),
    JSON.stringify(raceCounts),
  );
  if (!winner) throw new Error("Żadna rezerwacja nie przeszła — dalsze scenariusze nie mają sensu.");
  const reservationId = winner.body.reservationId;
  check(
    "API",
    "201 { reservationId, expiresAt }",
    /^[0-9a-f]{24}$/.test(reservationId) && !Number.isNaN(Date.parse(winner.body.expiresAt)),
  );
  check("Z1", "zarezerwowane miejsce jest w takenSeats", (await get(eventPath)).body?.takenSeats?.includes(seatRace));

  const held = await get(`/api/reservations/${reservationId}`);
  check(
    "API",
    "GET /api/reservations/:id → held z serverNow, bez code",
    held.status === 200 && held.body?.status === "held" && held.body?.serverNow && !("code" in held.body),
  );
  check("Z11", "GET rezerwacji nie zawiera e-maila", held.status === 200 && !held.text.includes(ATTACK_EMAIL) && !("email" in (held.body ?? {})));

  // Z4: 10 równoległych zakupów
  const buys = await Promise.all(Array.from({ length: 10 }, () => purchase(reservationId)));
  const codes = new Set(buys.map((r) => r.body?.code));
  const code = [...codes][0];
  check(
    "Z4",
    "10 równoległych zakupów → 10×200 i jeden kod XXXX-XXXX",
    buys.every((r) => r.status === 200) && codes.size === 1 && CODE_REGEX.test(code ?? ""),
    `${JSON.stringify(countBy(buys.map((r) => r.status)))} kod ${code}`,
  );
  const again = await purchase(reservationId);
  check("Z4", "ponowny zakup → ten sam kod", again.status === 200 && again.body?.code === code);

  const ticket = await get(`/api/tickets/${code.toLowerCase()}`);
  check(
    "API",
    "GET /api/tickets/:code (małymi literami) → bilet",
    ticket.status === 200 && ticket.body?.code === code && ticket.body?.seatId === seatRace && ticket.body?.event?._id === event._id,
  );
  check("Z11", "bilet nie zawiera e-maila", ticket.status === 200 && !ticket.text.includes(ATTACK_EMAIL));
  const purchased = await get(`/api/reservations/${reservationId}`);
  check("API", "GET rezerwacji po zakupie → paid i ten sam code", purchased.body?.status === "paid" && purchased.body?.code === code);

  // Z5: kupione miejsce zostaje zajęte
  check("Z5", "kupione miejsce dalej w takenSeats", (await get(eventPath)).body?.takenSeats?.includes(seatRace));
  const rebook = await reserve({ eventId: event._id, seatId: seatRace, ...customer() });
  check("Z5", "rezerwacja kupionego miejsca → 409 SEAT_TAKEN", rebook.status === 409 && isApiError(rebook, "SEAT_TAKEN"));

  // Z6: śmieciowe body — zawsze 400 VALIDATION_ERROR
  const valid = { eventId: event._id, seatId: seatSpare, customerName: "Jan Kowalski", email: "jan@example.com" };
  const garbage = [
    ["brak body", { raw: undefined }],
    ['"nie-json"', { raw: "nie-json" }],
    ["[]", { raw: "[]" }],
    ["null", { raw: "null" }],
    ["123", { raw: "123" }],
    ["{}", { raw: "{}" }],
    ["seatId jako liczba", { json: { ...valid, seatId: 7 } }],
    ["email jako tablica", { json: { ...valid, email: ["a@b.pl"] } }],
    ["customerName jako obiekt", { json: { ...valid, customerName: { a: 1 } } }],
    ['{"eventId":{"$ne":null}}', { json: { ...valid, eventId: { $ne: null } } }],
    ['{"seatId":{"$gt":""}}', { json: { ...valid, seatId: { $gt: "" } } }],
    ["customerName 10 000 znaków", { json: { ...valid, customerName: "x".repeat(10_000) } }],
    ["customerName ze znakiem \\n", { json: { ...valid, customerName: "Jan\nKowalski" } }],
    ["customerName same spacje", { json: { ...valid, customerName: "   " } }],
    ['email "jan@localhost"', { json: { ...valid, email: "jan@localhost" } }],
    ['email "zly"', { json: { ...valid, email: "zly" } }],
    ["pusty eventId", { json: { ...valid, eventId: "  " } }],
    ["niepoprawne UTF-8", { raw: new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]) }],
    ["body 1 MB", { raw: "x".repeat(1024 * 1024) }],
    [
      "body 1 MB bez Content-Length (chunked)",
      {
        raw: new ReadableStream({
          start(controller) {
            for (let i = 0; i < 16; i++) controller.enqueue(new TextEncoder().encode("y".repeat(64 * 1024)));
            controller.close();
          },
        }),
        duplex: "half",
      },
    ],
  ];
  for (const [label, opts] of garbage) {
    const r = await request("POST", "/api/reservations", opts);
    check("Z6", `śmieciowe body: ${label} → 400`, r.status === 400 && isApiError(r, "VALIDATION_ERROR"), `${r.status}`);
  }
  check("Z6", "żadne śmieci nie zajęły miejsca", !(await get(eventPath)).body?.takenSeats?.includes(seatSpare));
  const alive = await Promise.all([get("/api/events"), get(eventPath), get("/api/events")]);
  check("Z6", "serwer odpowiada normalnie po ogromnych body", alive.every((r) => r.status === 200));

  // Z7: złe identyfikatory — 404 JSON, nigdy 500
  const badIds = [
    ["GET", "/api/events/nie-ma", "EVENT_NOT_FOUND"],
    ["GET", "/api/events/%7B%7D", "EVENT_NOT_FOUND"],
    ["GET", `/api/events/${"x".repeat(5000)}`, "EVENT_NOT_FOUND"],
    ["POST", "/api/reservations/abc/purchase", "RESERVATION_NOT_FOUND"],
    ["POST", "/api/reservations/aaaaaaaaaaaa/purchase", "RESERVATION_NOT_FOUND"],
    ["POST", `/api/reservations/${"0".repeat(24)}/purchase`, "RESERVATION_NOT_FOUND"],
    ["POST", `/api/reservations/${reservationId.toUpperCase()}/purchase`, "RESERVATION_NOT_FOUND"],
    ["GET", "/api/reservations/%7B%7D", "RESERVATION_NOT_FOUND"],
    ["GET", `/api/reservations/${"f".repeat(5000)}`, "RESERVATION_NOT_FOUND"],
    ["GET", "/api/tickets/ABCD-EFGH", "TICKET_NOT_FOUND"],
    ["GET", "/api/tickets/nie-kod", "TICKET_NOT_FOUND"],
    ["GET", `/api/tickets/${"Z".repeat(5000)}`, "TICKET_NOT_FOUND"],
  ];
  for (const [method, path, code404] of badIds) {
    const r = await request(method, path);
    check("Z7", `${method} ${path.slice(0, 50)}${path.length > 50 ? "…" : ""} → 404`, r.status === 404 && isApiError(r, code404), `${r.status}`);
  }
  // Świadoma decyzja (CONTRACT.md §3): zepsute %-kodowanie odrzuca Next.js — 400 HTML, ważne że nie 500.
  const broken = await request("POST", "/api/reservations/%E0%A4%A/purchase");
  check("Z7", "zepsute %-kodowanie w URL → 4xx, nie 500 (JSON niewymagany)", broken.status >= 400 && broken.status < 500, `${broken.status}`);

  // Z8: miejsce i kurs, których nie ma
  const noSeat = await reserve({ ...valid, seatId: "9-99" });
  check("Z8", 'seatId "9-99" → 400 INVALID_SEAT', noSeat.status === 400 && isApiError(noSeat, "INVALID_SEAT"));
  const noEvent = await reserve({ ...valid, eventId: "nie-ma-takiego-kursu" });
  check("Z8", "nieistniejący kurs → 404 EVENT_NOT_FOUND", noEvent.status === 404 && isApiError(noEvent, "EVENT_NOT_FOUND"));

  // Z2 + Z3: wygasanie (--slow)
  if (SLOW) {
    const slow = await reserve({ eventId: event._id, seatId: seatSlow, ...customer() });
    remember(slow, event);
    check("Z2", `rezerwacja ${seatSlow} do testu wygasania → 201`, slow.status === 201);
    if (slow.status === 201) {
      const waitMs = Math.max(0, Date.parse(slow.body.expiresAt) - Date.now()) + 1000;
      console.log(`      … czekam ${Math.round(waitMs / 1000)} s na wygaśnięcie rezerwacji`);
      await new Promise((r) => setTimeout(r, waitMs));
      check("Z2", "po TTL miejsce zniknęło z takenSeats", !(await get(eventPath)).body?.takenSeats?.includes(seatSlow));
      const late = await purchase(slow.body.reservationId);
      check("Z3", "zakup po TTL → 410 RESERVATION_EXPIRED", late.status === 410 && isApiError(late, "RESERVATION_EXPIRED"));
      const expired = await get(`/api/reservations/${slow.body.reservationId}`);
      check("Z3", "GET rezerwacji po TTL → status expired, bez code", expired.body?.status === "expired" && !("code" in expired.body));
      const again2 = await reserve({ eventId: event._id, seatId: seatSlow, ...customer() });
      remember(again2, event);
      check("Z2", "ponowna rezerwacja wygasłego miejsca → 201", again2.status === 201);
    }
  } else {
    console.log("      (pomijam Z2/Z3 — uruchom z --slow, żeby sprawdzić wygasanie)");
  }

  // Z21: rezerwacja nigdy nie trwa dłużej niż do odjazdu
  check(
    "Z21",
    "expiresAt każdej udanej rezerwacji ≤ startsAt kursu",
    successfulReservations.length > 0 &&
      successfulReservations.every((r) => Date.parse(r.expiresAt) <= Date.parse(r.event.startsAt)),
    `${successfulReservations.length} rezerwacji`,
  );

  // Format błędów i brak wycieków (wszystkie odpowiedzi 4xx/5xx z tego ataku)
  const jsonErrors = errorResponses.filter((r) => r.body !== undefined);
  check(
    "§4",
    "każdy błąd JSON ma { error, message } jako stringi",
    jsonErrors.every((r) => isApiError(r)),
    `${jsonErrors.length} odpowiedzi`,
  );
  const leaks = errorResponses.filter((r) => LEAK_PATTERNS.some((p) => p.test(r.text)));
  check("Z12", "żaden błąd nie zdradza stack trace, Mongo ani ścieżek plików", leaks.length === 0, leaks.map((l) => l.path.slice(0, 40)).join(", "));
  check("Z12", "żadna odpowiedź nie była 500", !errorResponses.some((r) => r.status >= 500), `${errorResponses.filter((r) => r.status >= 500).length}×5xx`);
}

try {
  await main();
} catch (err) {
  check("!!!", "atak przerwany", false, err instanceof Error ? err.message : String(err));
}

if (connectionResets.length) {
  console.log(`\n\x1b[33mUWAGA\x1b[0m  ${connectionResets.length}× zerwane połączenie keep-alive po ogromnym body (ponowione):`);
  for (const r of connectionResets) console.log(`       ${r}`);
  console.log("       Serwer odpowiada 400 bez doczytania body i zamyka gniazdo bez nagłówka Connection: close.");
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} PASS${failed.length ? `, ${failed.length} FAIL:` : ""}`);
for (const f of failed) console.log(`  ✗ ${f.id} ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
process.exit(failed.length ? 1 : 0);
