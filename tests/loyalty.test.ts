// Konto punktowe (karta A) — CONTRACT.md §0a D13, D14, D17, D18, D20, §2, §3, Z39–Z44, Z49, Z51, Z52, Z54.
// Voucherify: atrapa przez fetch (tests/fake-voucherify.ts), Stripe zmockowany, podpisy webhooka prawdziwe.
import { ObjectId } from "mongodb";
import Stripe from "stripe";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { GET as cronRoute } from "@/app/api/cron/settle/route";
import { GET as loyaltyRoute } from "@/app/api/loyalty/route";
import { POST as webhookRoute } from "@/app/api/webhooks/stripe/route";
import { closeDb, getDb, LOYALTY_MEMBERS_COLLECTION } from "@/lib/db";
import {
  acquireSpendLock,
  applyPoints,
  ensureMember,
  getFreshBalance,
  releaseSpendLock,
  runLoyaltyRetries,
  settleLoyalty,
} from "@/lib/loyalty";
import {
  claimPointsSpend,
  createReservation,
  finishPointsSpend,
  getTicketByCode,
  saveCheckoutSession,
} from "@/lib/reservations";
import { getStripe } from "@/lib/stripe";
import type { LoyaltyMember } from "@/lib/types";
import { FAKE_ENV, FakeVoucherify } from "./fake-voucherify";
import { apiGetReservation, FUTURE_EVENT, paidSession, reservationsCollection, resetTestData, setTtl, TEST_PRICE } from "./helpers";

vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  return { ...actual, getStripe: vi.fn() };
});

const WEBHOOK_SECRET = "whsec_unit_only_not_real";
const LEAK = /\bat .+\(|Error:|Mongo|Stripe|Voucherify|node_modules|\/src\/|\.ts:\d|lmbr_|lcrd_|lctx_/;
const realStripe = new Stripe("sk_test_unit_only_not_real");
const refundsCreate = vi.fn();

let fake: FakeVoucherify;
let consoleError: MockInstance<typeof console.error>;
let seat = 0;
let eventSeq = 0;

// --- pomocnicze ---

function nextSeat(): string {
  seat = (seat % 40) + 1;
  return `${seat <= 20 ? 1 : 2}-${((seat - 1) % 20) + 1}`;
}

async function reserve(email: string): Promise<string> {
  const result = await createReservation({ eventId: FUTURE_EVENT._id, seatId: nextSeat(), customerName: "Anna Punktowa", email });
  if (!result.ok) throw new Error(`rezerwacja: ${result.error}`);
  return result.reservationId;
}

async function doc(id: string) {
  return (await reservationsCollection()).findOne({ _id: new ObjectId(id) });
}

async function member(email: string): Promise<LoyaltyMember | null> {
  return (await getDb()).collection<LoyaltyMember>(LOYALTY_MEMBERS_COLLECTION).findOne({ _id: email });
}

async function setExpiresAt(id: string, msFromNow: number): Promise<void> {
  await (await reservationsCollection()).updateOne({ _id: new ObjectId(id) }, { $set: { expiresAt: new Date(Date.now() + msFromNow) } });
}

/** „Zapłać” tak, jak robi to karta B: zajęcie, pobranie z czekaniem na APPROVED, zapis sesji. */
async function payWithPoints(id: string, email: string, points: number): Promise<void> {
  const claim = await claimPointsSpend(id, points);
  if (!claim.ok) throw new Error(`claim: ${claim.error}`);
  expect(await applyPoints(email, -points, `spend-${id}`, { waitForApproval: true })).toBe("done");
  await finishPointsSpend(id, "done");
  await saveCheckoutSession(id, { sessionId: `cs_test_${id}`, url: "https://checkout.stripe.com/x", pointsUsed: points, cardAmount: TEST_PRICE - points });
}

async function checkoutWithoutPoints(id: string): Promise<void> {
  await saveCheckoutSession(id, { sessionId: `cs_test_${id}`, url: "https://checkout.stripe.com/x", pointsUsed: 0, cardAmount: TEST_PRICE });
}

function stripeEvent(session: Stripe.Checkout.Session, created = Math.floor(Date.now() / 1000)) {
  return { id: `evt_loyalty_${Date.now()}_${++eventSeq}`, object: "event", type: "checkout.session.completed", created, data: { object: session } };
}

async function postEvent(event: ReturnType<typeof stripeEvent>) {
  const payload = JSON.stringify(event);
  const signature = realStripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const res = await webhookRoute(
    new Request("http://localhost:3000/api/webhooks/stripe", { method: "POST", body: payload, headers: { "stripe-signature": signature } }),
  );
  expect(res.status, await res.clone().text()).toBe(200);
}

async function apiLoyalty(query: string) {
  const res = await loyaltyRoute(new Request(`http://localhost:3000/api/loyalty${query}`));
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

async function apiCron(authorization?: string) {
  const headers = authorization === undefined ? undefined : { authorization };
  const res = await cronRoute(new Request("http://localhost:3000/api/cron/settle", { headers }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  await resetTestData();
  fake = new FakeVoucherify();
  vi.stubGlobal("fetch", fake.fetch);
  for (const [name, value] of Object.entries(FAKE_ENV)) vi.stubEnv(name, value);
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET);
  setTtl(120);
  refundsCreate.mockReset().mockImplementation(async (params: { payment_intent: string }) => ({ id: `re_${params.payment_intent}` }));
  vi.mocked(getStripe).mockReset().mockReturnValue({
    webhooks: realStripe.webhooks,
    refunds: { create: refundsCreate },
    checkout: { sessions: { retrieve: vi.fn().mockRejectedValue(new Error("sync niepotrzebny w tych testach")) } },
  } as unknown as Stripe);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  expect(JSON.stringify(consoleError.mock.calls)).not.toContain(FAKE_ENV.VOUCHERIFY_SECRET_KEY);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(async () => {
  setTtl(undefined);
  await closeDb();
});

// --- GET /api/loyalty ---

describe("GET /api/loyalty (D13, D14, D20, Z49, Z52)", () => {
  it("nowy e-mail → 1000, karta NIE zakładana, jedno wywołanie; drugi odczyt przez 10 min z pamięci", async () => {
    const res = await apiLoyalty("?email=nowy%40example.com");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: "nowy@example.com", points: 1000 });
    expect(fake.calls.map((c) => c.op)).toEqual(["findMember"]);
    expect(fake.members.size).toBe(0);
    expect(await member("nowy@example.com")).toMatchObject({ status: "absent", memberId: null });

    expect((await apiLoyalty("?email=nowy%40example.com")).body).toEqual({ email: "nowy@example.com", points: 1000 });
    expect(fake.calls).toHaveLength(1);
  });

  it("JAN@Example.com i jan@example.com to ten sam klient (bez drugiego wywołania)", async () => {
    expect((await apiLoyalty("?email=%20JAN%40Example.com%20")).body).toEqual({ email: "jan@example.com", points: 1000 });
    expect((await apiLoyalty("?email=jan%40example.com")).body).toEqual({ email: "jan@example.com", points: 1000 });
    expect(fake.calls).toHaveLength(1);
  });

  it.each(["", "?email=", "?email=nie-email", "?email=%7B%22%24ne%22%3Anull%7D", `?email=${"a".repeat(300)}%40x.pl`])(
    "zły e-mail %j → 400 VALIDATION_ERROR bez wołania Voucherify",
    async (query) => {
      const res = await apiLoyalty(query);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "VALIDATION_ERROR", message: expect.any(String) });
      expect(fake.calls).toHaveLength(0);
    },
  );

  it("klient z kartą: saldo z Voucherify, przez 30 s z pamięci, potem znów jedno wywołanie", async () => {
    fake.addMemberFromPanel("panel@example.com", 777);
    expect((await apiLoyalty("?email=panel%40example.com")).body).toEqual({ email: "panel@example.com", points: 777 });
    await apiLoyalty("?email=panel%40example.com");
    expect(fake.count()).toBe(1);

    await (await getDb())
      .collection<LoyaltyMember>(LOYALTY_MEMBERS_COLLECTION)
      .updateOne({ _id: "panel@example.com" }, { $set: { balanceAt: new Date(Date.now() - 31_000) } });
    fake.members.get("panel@example.com")!.balance = 800;
    expect((await apiLoyalty("?email=panel%40example.com")).body).toMatchObject({ points: 800 });
    expect(fake.count()).toBe(2);
  });

  it("Voucherify 429 → saldo z pamięci podręcznej; bez niej 503 bez szczegółów; potem zero wywołań do końca blokady", async () => {
    fake.addMemberFromPanel("znany@example.com", 500);
    await apiLoyalty("?email=znany%40example.com");
    await (await getDb())
      .collection<LoyaltyMember>(LOYALTY_MEMBERS_COLLECTION)
      .updateOne({ _id: "znany@example.com" }, { $set: { balanceAt: new Date(Date.now() - 60_000) } });

    fake.fail("findMember", "429", { retryAfter: "600" });
    expect((await apiLoyalty("?email=znany%40example.com")).body).toEqual({ email: "znany@example.com", points: 500 });

    const unknown = await apiLoyalty("?email=obcy%40example.com");
    expect(unknown.status).toBe(503);
    expect(unknown.body).toEqual({ error: "LOYALTY_UNAVAILABLE", message: "Punkty chwilowo nie działają. Możesz zapłacić bez punktów." });
    expect(unknown.text).not.toMatch(LEAK);
    expect(fake.count()).toBe(2); // tylko pierwszy odczyt i ten, który dostał 429
  });

  it("odpowiedź tylko { email, points } — bez memberId, karty i niczego z bazy (Z49)", async () => {
    fake.addMemberFromPanel("pola@example.com", 10);
    const res = await apiLoyalty("?email=pola%40example.com");
    expect(Object.keys(res.body).sort()).toEqual(["email", "points"]);
    expect(res.text).not.toMatch(/lmbr_|lcrd_/);
  });
});

// --- Karta i punkty powitalne ---

describe("ensureMember i punkty powitalne (D14, Z51)", () => {
  it("5 równoległych pierwszych operacji → jeden członek, 1000 powitalnych dokładnie raz", async () => {
    const email = "pierwszy@example.com";
    const results = await Promise.all(
      Array.from({ length: 5 }, () => applyPoints(email, 10, `earn-${new ObjectId().toHexString()}`, { waitForApproval: false })),
    );
    expect(results).toEqual(Array(5).fill("done"));
    expect(fake.count("createMember")).toBe(1);
    expect(fake.transactionsOf(email, `welcome-${email}`)).toHaveLength(1);
    expect(fake.balanceOf(email)).toBe(1050);
    expect(await member(email)).toMatchObject({ status: "ready", welcome: "done" });
  });

  it("członek z panelu marketingu (409) → bez punktów powitalnych", async () => {
    fake.addMemberFromPanel("marketing@example.com", 0);
    await ensureMember("marketing@example.com");
    expect(fake.transactionsOf("marketing@example.com")).toHaveLength(0);
    expect(await member("marketing@example.com")).toMatchObject({ status: "ready" });
  });

  it("punkty powitalne długo PENDING → 503 teraz, później dokończone bez drugiego wysłania", async () => {
    const email = "wolny@example.com";
    fake.pendingReads = 10;
    await expect(ensureMember(email)).rejects.toThrow("niepotwierdzone");
    expect(await member(email)).toMatchObject({ status: "creating", welcome: "pending" });
    // Saldo zawsze takie, jak w Voucherify (D12) — punkty powitalne liczą się po APPROVED.
    expect(await getFreshBalance(email)).toBe(0);

    fake.transactionsOf(email)[0].pendingReads = 0;
    await ensureMember(email);
    expect(fake.transactionsOf(email, `welcome-${email}`)).toHaveLength(1);
    expect(fake.balanceOf(email)).toBe(1000);
    expect(await member(email)).toMatchObject({ status: "ready", welcome: "done" });
  });

  it("timeout przy zakładaniu członka (doszło) → następna próba dostaje 409, a punkty powitalne i tak raz", async () => {
    const email = "timeout@example.com";
    fake.fail("createMember", "timeout-after");
    await expect(ensureMember(email)).rejects.toThrow();
    await ensureMember(email);
    expect(fake.transactionsOf(email, `welcome-${email}`)).toHaveLength(1);
    expect(fake.balanceOf(email)).toBe(1000);
  });

  it("getFreshBalance dla e-maila bez karty → 1000 i nie zakłada karty", async () => {
    expect(await getFreshBalance("bez-karty@example.com")).toBe(1000);
    expect(fake.count("createMember")).toBe(0);
  });
});

// --- Zakupy ---

describe("punkty za zakup (D18, Z41, Z42)", () => {
  it("8900 bez punktów, nowy klient → +890 po 1000 powitalnych = 1890; ~5 wywołań Voucherify", async () => {
    const email = "kupujacy@example.com";
    const id = await reserve(email);
    await checkoutWithoutPoints(id);
    expect(fake.count()).toBe(0); // „Zapłać” bez punktów nie woła Voucherify (D20)

    await postEvent(stripeEvent(paidSession(id)));

    const paid = await doc(id);
    expect(paid).toMatchObject({ status: "paid", pointsEarned: 890, loyalty: { earn: { status: "done", points: 890 } } });
    expect(fake.balanceOf(email)).toBe(1890);
    expect(fake.count()).toBe(5); // klient, członek, +1000, sprawdzenie +1000, +890
    expect((await apiGetReservation(id)).body).toMatchObject({ status: "paid", pointsUsed: 0, cardAmount: 8900, pointsEarned: 890 });
    expect((await apiLoyalty(`?email=${encodeURIComponent(email)}`)).body).toEqual({ email, points: 1890 });
  });

  it("z 1000 punktami → 7900 kartą, +790, saldo 790; bilet z pointsUsed i cardAmount", async () => {
    const email = "punkty@example.com";
    const id = await reserve(email);
    expect(await getFreshBalance(email)).toBe(1000); // karta B sprawdza saldo przed pobraniem
    await payWithPoints(id, email, 1000);
    expect(fake.balanceOf(email)).toBe(0);

    await postEvent(stripeEvent(paidSession(id, { amount_total: 7900 })));

    const paid = await doc(id);
    expect(paid).toMatchObject({ status: "paid", pointsUsed: 1000, cardAmount: 7900, pointsEarned: 790 });
    expect(fake.balanceOf(email)).toBe(790);
    // Budżet (§3): saldo 1 + klient, członek, +1000, sprawdzenie 4 + pobranie i sprawdzenie 2 + naliczenie 1.
    expect(fake.count()).toBe(8);
    expect(await getTicketByCode(paid!.code!)).toMatchObject({ pointsUsed: 1000, cardAmount: 7900, pointsEarned: 790 });
    expect((await apiLoyalty(`?email=${encodeURIComponent(email)}`)).body).toEqual({ email, points: 790 });
  });

  it("budżet dla znanego klienta: zakup bez punktów 1 wywołanie, z punktami 4", async () => {
    const email = "staly@example.com";
    fake.addMemberFromPanel(email, 2000);
    await ensureMember(email);
    fake.calls.length = 0;

    const withoutPoints = await reserve(email);
    await checkoutWithoutPoints(withoutPoints);
    await postEvent(stripeEvent(paidSession(withoutPoints)));
    expect(fake.calls.map((c) => c.op)).toEqual(["addPoints"]);

    fake.calls.length = 0;
    const withPoints = await reserve(email);
    expect(await getFreshBalance(email)).toBe(2890);
    await payWithPoints(withPoints, email, 1000);
    await postEvent(stripeEvent(paidSession(withPoints, { amount_total: 7900 })));
    expect(fake.calls.map((c) => c.op)).toEqual(["findMember", "addPoints", "getTransaction", "addPoints"]);
    expect(fake.balanceOf(email)).toBe(2890 - 1000 + 790);
  });

  it("Z41: ten sam webhook 2×, drugie zdarzenie sesji i 5× GET → punkty naliczone raz", async () => {
    const email = "raz@example.com";
    const id = await reserve(email);
    await checkoutWithoutPoints(id);
    const event = stripeEvent(paidSession(id));
    await postEvent(event);
    await postEvent(event);
    await postEvent({ ...stripeEvent(paidSession(id)), type: "checkout.session.async_payment_succeeded" });
    await Promise.all(Array.from({ length: 5 }, () => apiGetReservation(id)));

    expect(fake.transactionsOf(email, `earn-${id}`)).toHaveLength(1);
    expect(fake.balanceOf(email)).toBe(1890);
  });

  it("Z41: webhook i GET równolegle → jedno naliczenie", async () => {
    const email = "rownolegle@example.com";
    const id = await reserve(email);
    await checkoutWithoutPoints(id);
    await Promise.all([postEvent(stripeEvent(paidSession(id))), apiGetReservation(id), apiGetReservation(id)]);
    await Promise.all([apiGetReservation(id), apiGetReservation(id)]);
    expect(fake.transactionsOf(email, `earn-${id}`)).toHaveLength(1);
  });

  it("Z43: Voucherify nie działa przy naliczeniu → bilet jest, earn: retry; cron dolicza", async () => {
    const email = "awaria@example.com";
    const id = await reserve(email);
    await checkoutWithoutPoints(id);
    fake.fail("createCustomer", "500");

    await postEvent(stripeEvent(paidSession(id)));
    const res = await apiGetReservation(id);
    expect(res.body).toMatchObject({ status: "paid", code: expect.any(String), pointsEarned: 890 });
    expect(await doc(id)).toMatchObject({ loyalty: { earn: { status: "retry" } } });
    // GET nie ponawia częściej niż co minutę (budżet 100/h) — zero nowych wywołań.
    const before = fake.count();
    await apiGetReservation(id);
    expect(fake.count()).toBe(before);

    vi.stubEnv("CRON_SECRET", "s".repeat(40));
    expect((await apiCron(`Bearer ${"s".repeat(40)}`)).body).toMatchObject({ earned: 1 });
    expect(fake.balanceOf(email)).toBe(1890);
    expect(await doc(id)).toMatchObject({ loyalty: { earn: { status: "done" } } });
  });

  it("pointsEarned 0 (kwota poniżej złotówki kartą) → earn: done bez wołania Voucherify", async () => {
    const email = "grosze@example.com";
    const id = await reserve(email);
    // Kwota sesji poniżej złotówki — pointsEarnedFor(99) = 0 (Z42).
    await (await reservationsCollection()).updateOne({ _id: new ObjectId(id) }, { $set: { cardAmount: 99 } });
    await postEvent(stripeEvent(paidSession(id, { amount_total: 99 })));
    expect(await doc(id)).toMatchObject({ status: "paid", pointsEarned: 0, loyalty: { earn: { status: "done" } } });
    expect(fake.count()).toBe(0);
  });
});

// --- Zwroty punktów ---

describe("zwrot punktów za nieopłacone rezerwacje (D17, Z39, Z40)", () => {
  it("Z39: rezerwacja z pobranymi punktami wygasa → GET rezerwacji zamyka ją i oddaje punkty raz", async () => {
    const email = "zwrot@example.com";
    const id = await reserve(email);
    await payWithPoints(id, email, 1000);

    // W ciągu 30 s po expiresAt jeszcze nie — D8 przyjmuje płatność do 10 s po czasie.
    await setExpiresAt(id, -5_000);
    expect((await apiGetReservation(id)).body).toMatchObject({ status: "expired" });
    expect(await doc(id)).toMatchObject({ status: "held", active: true });
    expect(fake.transactionsOf(email, `refund-${id}`)).toHaveLength(0);

    await setExpiresAt(id, -31_000);
    expect((await apiGetReservation(id)).body).toMatchObject({ status: "expired", pointsUsed: 1000 });
    expect(await doc(id)).toMatchObject({ status: "expired", active: false, loyalty: { refund: { status: "done", points: 1000 } } });
    expect(fake.balanceOf(email)).toBe(1000);

    await apiGetReservation(id);
    await apiLoyalty(`?email=${encodeURIComponent(email)}`);
    expect(fake.transactionsOf(email, `refund-${id}`)).toHaveLength(1);
  });

  it("Z39: GET /api/loyalty sam oddaje punkty wygasłych rezerwacji tego e-maila, zanim pokaże saldo", async () => {
    const email = "saldo-zwrot@example.com";
    const a = await reserve(email);
    await payWithPoints(a, email, 400);
    const b = await reserve(email);
    await payWithPoints(b, email, 600);
    await setExpiresAt(a, -31_000);
    await setExpiresAt(b, -31_000);

    expect((await apiLoyalty(`?email=${encodeURIComponent(email)}`)).body).toEqual({ email, points: 1000 });
    expect(fake.transactionsOf(email).filter((t) => t.reason.startsWith("refund-"))).toHaveLength(2);
  });

  it("Z40: spóźniona płatność kartą rezerwacji z punktami → zwrot pieniędzy i punktów, brak biletu", async () => {
    const email = "spozniony@example.com";
    const id = await reserve(email);
    await payWithPoints(id, email, 1000);
    await setExpiresAt(id, -60_000);

    await postEvent(stripeEvent(paidSession(id, { amount_total: 7900 })));

    expect(refundsCreate).toHaveBeenCalledTimes(1);
    expect(await doc(id)).toMatchObject({ status: "expired", active: false, code: null, loyalty: { refund: { status: "done" } } });
    expect(fake.transactionsOf(email, `refund-${id}`)).toHaveLength(1);
    expect(fake.balanceOf(email)).toBe(1000);
    expect((await apiGetReservation(id)).body).not.toHaveProperty("code");
  });

  it("wyścig w chwili wygaśnięcia (5×): albo opłacona i punkty zostają, albo wygasła ze zwrotem pieniędzy i punktów — nigdy oba", async () => {
    for (let round = 0; round < 5; round++) {
      const email = `wyscig${round}@example.com`;
      const id = await reserve(email);
      await payWithPoints(id, email, 1000);
      // Płatność potwierdzona na czas (5 s po expiresAt), webhook dochodzi, gdy zwrot już może ruszyć.
      await setExpiresAt(id, -31_000);
      const created = Math.floor((Date.now() - 26_000) / 1000);
      refundsCreate.mockClear();

      await Promise.all([
        postEvent(stripeEvent(paidSession(id, { amount_total: 7900 }), created)),
        settleLoyalty({ reservationId: id }),
        apiGetReservation(id),
      ]);

      const final = await doc(id);
      const pointsRefunds = fake.transactionsOf(email, `refund-${id}`).length;
      if (final?.status === "paid") {
        expect(final.code).toEqual(expect.any(String));
        expect(refundsCreate).not.toHaveBeenCalled();
        expect(pointsRefunds).toBe(0);
        expect(fake.balanceOf(email)).toBe(790);
      } else {
        expect(final).toMatchObject({ status: "expired", active: false, code: null });
        expect(refundsCreate).toHaveBeenCalledTimes(1);
        expect(pointsRefunds).toBe(1);
        expect(fake.balanceOf(email)).toBe(1000);
      }
    }
  });

  it("opłacona rezerwacja z punktami nigdy nie dostaje zwrotu punktów", async () => {
    const email = "oplacona@example.com";
    const id = await reserve(email);
    await payWithPoints(id, email, 500);
    await postEvent(stripeEvent(paidSession(id, { amount_total: TEST_PRICE - 500 })));
    await setExpiresAt(id, -3_600_000);
    await settleLoyalty({ reservationId: id });
    await settleLoyalty({ email });
    expect(await runLoyaltyRetries()).toMatchObject({ refunded: 0 });
    expect(fake.transactionsOf(email, `refund-${id}`)).toHaveLength(0);
  });

  it("Voucherify nie działa przy zwrocie → refund: retry, cron oddaje punkty", async () => {
    const email = "zwrot-awaria@example.com";
    const id = await reserve(email);
    await payWithPoints(id, email, 300);
    await setExpiresAt(id, -31_000);
    fake.fail("addPoints", "423");
    await apiGetReservation(id);
    expect(await doc(id)).toMatchObject({ status: "expired", loyalty: { refund: { status: "retry" } } });

    expect(await runLoyaltyRetries()).toMatchObject({ refunded: 1 });
    expect(fake.transactionsOf(email, `refund-${id}`)).toHaveLength(1);
    expect(fake.balanceOf(email)).toBe(1000);
  });

  it("Z54: przerwany zwrot (pending > 2 min, funkcja padła po wysłaniu) → cron sprawdza po reason i nie oddaje drugi raz", async () => {
    const email = "przerwany@example.com";
    const id = await reserve(email);
    await payWithPoints(id, email, 300);
    await setExpiresAt(id, -31_000);
    // Symulacja: zwrot zajęty i wysłany, ale wynik nie zdążył trafić do bazy.
    await applyPoints(email, 300, `refund-${id}`, { waitForApproval: false });
    await (await reservationsCollection()).updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "expired", active: false, "loyalty.refund": { status: "pending", points: 300, at: new Date(Date.now() - 3 * 60_000), attempts: 1 } } },
    );

    expect(await runLoyaltyRetries()).toMatchObject({ refunded: 1 });
    expect(fake.transactionsOf(email, `refund-${id}`)).toHaveLength(1);
    expect(fake.balanceOf(email)).toBe(1000);
  });
});

// --- Pewność operacji ---

describe("applyPoints: niepewność i asynchroniczność v2 (Z44, Z55)", () => {
  async function readyMember(email: string, balance: number) {
    fake.addMemberFromPanel(email, balance);
    await ensureMember(email);
    fake.calls.length = 0;
  }

  it("timeout po wysłaniu pobrania, transakcja jest → done bez drugiego wysłania", async () => {
    const email = "uncertain-ok@example.com";
    await readyMember(email, 1000);
    const id = await reserve(email);
    await claimPointsSpend(id, 400);
    fake.fail("addPoints", "timeout-after");

    expect(await applyPoints(email, -400, `spend-${id}`, { waitForApproval: true })).toBe("done");
    expect(fake.count("addPoints")).toBe(1);
    expect(fake.balanceOf(email)).toBe(600);
  });

  it("timeout przed wysłaniem, transakcji nie ma → retry; następne kliknięcie pobiera raz", async () => {
    const email = "uncertain-miss@example.com";
    await readyMember(email, 1000);
    const id = await reserve(email);
    await claimPointsSpend(id, 400);
    fake.fail("addPoints", "timeout-before");

    expect(await applyPoints(email, -400, `spend-${id}`, { waitForApproval: true })).toBe("retry");
    await finishPointsSpend(id, "retry");
    expect(fake.balanceOf(email)).toBe(1000);

    await claimPointsSpend(id, 400);
    expect(await applyPoints(email, -400, `spend-${id}`, { waitForApproval: true })).toBe("done");
    expect(fake.transactionsOf(email, `spend-${id}`)).toHaveLength(1);
    expect(fake.balanceOf(email)).toBe(600);
  });

  it("pobranie dłużej PENDING niż ~4 s → retry; następna próba (2. kliknięcie) czeka na wynik zamiast pobierać drugi raz", async () => {
    const email = "pending@example.com";
    await readyMember(email, 1000);
    const id = await reserve(email);
    await claimPointsSpend(id, 400);
    fake.pendingReads = 10;

    expect(await applyPoints(email, -400, `spend-${id}`, { waitForApproval: true })).toBe("retry");
    expect(fake.count("getTransaction")).toBe(3); // 0,5 / 1 / 1,5 s
    await finishPointsSpend(id, "retry");

    fake.transactionsOf(email, `spend-${id}`)[0].pendingReads = 0;
    await claimPointsSpend(id, 400);
    expect(await applyPoints(email, -400, `spend-${id}`, { waitForApproval: true })).toBe("done");
    expect(fake.transactionsOf(email, `spend-${id}`)).toHaveLength(1);
    expect(fake.count("addPoints")).toBe(1);
  });

  it("pobranie ponad saldo → REJECTED → rejected, saldo bez zmian", async () => {
    const email = "za-malo@example.com";
    await readyMember(email, 300);
    expect(await applyPoints(email, -400, `spend-${new ObjectId().toHexString()}`, { waitForApproval: true })).toBe("rejected");
    expect(fake.balanceOf(email)).toBe(300);
  });

  it("niepewne pobranie, po którym nikt nie wrócił (rezerwacja wygasła) → cron znajduje je po reason i oddaje punkty", async () => {
    const email = "sierota@example.com";
    await readyMember(email, 1000);
    const id = await reserve(email);
    await claimPointsSpend(id, 400);
    fake.fail("addPoints", "timeout-after").fail("listTransactions", "500");
    expect(await applyPoints(email, -400, `spend-${id}`, { waitForApproval: true })).toBe("retry");
    await finishPointsSpend(id, "retry");
    expect(fake.balanceOf(email)).toBe(600);

    await setExpiresAt(id, -31_000);
    expect(await runLoyaltyRetries()).toMatchObject({ refunded: 1 });
    expect(await doc(id)).toMatchObject({ pointsUsed: 400, loyalty: { spend: { status: "done" }, refund: { status: "done" } } });
    expect(fake.balanceOf(email)).toBe(1000);
  });

  it("niepewne pobranie, a klient zapłacił bez punktów → cron oddaje pobrane punkty, bilet zostaje", async () => {
    const email = "bez-punktow@example.com";
    await readyMember(email, 1000);
    const id = await reserve(email);
    await claimPointsSpend(id, 400);
    fake.fail("addPoints", "timeout-after").fail("listTransactions", "500");
    expect(await applyPoints(email, -400, `spend-${id}`, { waitForApproval: true })).toBe("retry");
    await finishPointsSpend(id, "retry");
    await checkoutWithoutPoints(id);
    await postEvent(stripeEvent(paidSession(id)));
    expect(fake.balanceOf(email)).toBe(600 + 890);

    expect(await runLoyaltyRetries()).toMatchObject({ refunded: 0 });
    expect(await doc(id)).toMatchObject({ status: "paid", loyalty: { spend: { status: "failed" }, refund: { status: "done", points: 400 } } });
    expect(fake.balanceOf(email)).toBe(1000 + 890);
  });
});

// --- Blokada wydawania i zajęcia kroków ---

describe("blokada wydawania (Z36) i zajęcie pobrania (Z38)", () => {
  it("drugi acquire → false; release zdejmuje; wygasła blokada da się wziąć", async () => {
    expect(await acquireSpendLock("Lock@Example.com")).toBe(true);
    expect(await acquireSpendLock("lock@example.com")).toBe(false);
    await releaseSpendLock("lock@example.com");
    expect(await acquireSpendLock("lock@example.com")).toBe(true);

    await (await getDb())
      .collection<LoyaltyMember>(LOYALTY_MEMBERS_COLLECTION)
      .updateOne({ _id: "lock@example.com" }, { $set: { spendLockUntil: new Date(Date.now() - 1) } });
    expect(await acquireSpendLock("lock@example.com")).toBe(true);
  });

  it("10 równoległych acquire → dokładnie jeden wygrywa", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => acquireSpendLock("tlok@example.com")));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("10 równoległych claimPointsSpend → jeden zajmuje; ta sama liczba → SPEND_IN_PROGRESS, inna → POINTS_LOCKED", async () => {
    const id = await reserve("claim@example.com");
    const results = await Promise.all(Array.from({ length: 10 }, () => claimPointsSpend(id, 500)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === "SPEND_IN_PROGRESS")).toHaveLength(9);
    expect(await claimPointsSpend(id, 700)).toEqual({ ok: false, error: "POINTS_LOCKED", pointsUsed: 500 });
    expect(await doc(id)).toMatchObject({ pointsUsed: 500, cardAmount: TEST_PRICE - 500, loyalty: { spend: { status: "pending", attempts: 1 } } });
  });

  it("przerwane pobranie (pending > 2 min) da się przejąć tą samą liczbą punktów", async () => {
    const id = await reserve("przejecie@example.com");
    await claimPointsSpend(id, 500);
    await (await reservationsCollection()).updateOne(
      { _id: new ObjectId(id) },
      { $set: { "loyalty.spend.at": new Date(Date.now() - 3 * 60_000) } },
    );
    expect(await claimPointsSpend(id, 700)).toEqual({ ok: false, error: "POINTS_LOCKED", pointsUsed: 500 });
    expect(await claimPointsSpend(id, 500)).toMatchObject({ ok: true, alreadySpent: false });
    expect(await doc(id)).toMatchObject({ loyalty: { spend: { status: "pending", attempts: 2 } } });
  });

  it("saveCheckoutSession z punktami tylko po spend: done z tą samą liczbą", async () => {
    const id = await reserve("sesja@example.com");
    await claimPointsSpend(id, 500);
    await saveCheckoutSession(id, { sessionId: "cs_test_x", url: "https://x", pointsUsed: 500, cardAmount: TEST_PRICE - 500 });
    expect((await doc(id))?.payment).toBeUndefined();
    await finishPointsSpend(id, "done");
    await saveCheckoutSession(id, { sessionId: "cs_test_x", url: "https://x", pointsUsed: 400, cardAmount: TEST_PRICE - 400 });
    expect((await doc(id))?.payment).toBeUndefined();
    await saveCheckoutSession(id, { sessionId: "cs_test_x", url: "https://x", pointsUsed: 500, cardAmount: TEST_PRICE - 500 });
    expect((await doc(id))?.payment?.sessionId).toBe("cs_test_x");
  });

  it("finishPointsSpend(retry|failed) czyści pointsUsed i cardAmount, done je zostawia", async () => {
    const id = await reserve("finish@example.com");
    await claimPointsSpend(id, 500);
    await finishPointsSpend(id, "failed");
    expect(await doc(id)).not.toHaveProperty("pointsUsed");
    await claimPointsSpend(id, 300);
    await finishPointsSpend(id, "done");
    expect(await doc(id)).toMatchObject({ pointsUsed: 300, cardAmount: TEST_PRICE - 300, loyalty: { spend: { status: "done" } } });
  });
});

// --- Cron ---

describe("GET /api/cron/settle", () => {
  it.each([
    ["brak sekretu w env, nagłówek dowolny", undefined, "Bearer cokolwiek"],
    ["brak sekretu w env, pusty Bearer", undefined, "Bearer "],
    ["zły sekret", "a".repeat(40), `Bearer ${"b".repeat(40)}`],
    ["sekret bez Bearer", "a".repeat(40), "a".repeat(40)],
    ["brak nagłówka", "a".repeat(40), undefined],
  ])("%s → 401", async (_name, secret, authorization) => {
    if (secret) vi.stubEnv("CRON_SECRET", secret);
    else vi.stubEnv("CRON_SECRET", "");
    const res = await apiCron(authorization);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "UNAUTHORIZED", message: expect.any(String) });
  });

  it("poprawny sekret → 200 { refunded, earned, emails }", async () => {
    vi.stubEnv("CRON_SECRET", "c".repeat(40));
    const res = await apiCron(`Bearer ${"c".repeat(40)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ refunded: 0, earned: 0, emails: 0 });
  });
});
