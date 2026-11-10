// Płatność punktami (karta B, Kamil) — CONTRACT.md §3 „Checkout z punktami”, D15, D16, D20, D22,
// Z36–Z38, Z43–Z45, Z53, Z55. LOYALTY_PROVIDER=memory (setup-env), Stripe zmockowany jak w checkout.test.ts.
import { ObjectId } from "mongodb";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as checkoutRoute } from "@/app/api/reservations/[id]/checkout/route";
import { GET as pointsRoute } from "@/app/api/reservations/[id]/points/route";
import { closeDb } from "@/lib/db";
import { acquireSpendLock, releaseSpendLock } from "@/lib/loyalty";
import { createReservation } from "@/lib/reservations";
import { getStripe } from "@/lib/stripe";
import { getLoyaltyClient, LoyaltyUnavailableError, resetMemoryLoyalty } from "@/lib/voucherify";
import { FUTURE_EVENT, reservationsCollection, resetTestData, TEST_PRICE } from "./helpers";

vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  return { ...actual, getStripe: vi.fn() };
});

// Blokada e-maila (Eryk) — prawdziwa implementacja, a w jednym teście wymuszamy „zajęta”.
vi.mock("@/lib/loyalty", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/loyalty")>();
  return { ...actual, acquireSpendLock: vi.fn(actual.acquireSpendLock), releaseSpendLock: vi.fn(actual.releaseSpendLock) };
});

const APP_URL = "https://konduktor.example";
const LEAK = /\bat .+\(|Error:|Mongo|Stripe|Voucherify|node_modules|\/src\/|\.ts:\d|sk_test/;
const MAX_POINTS = Math.floor(TEST_PRICE / 2); // 4450

type CreateFn = (
  params: Stripe.Checkout.SessionCreateParams,
  options?: Stripe.RequestOptions,
) => Promise<Pick<Stripe.Checkout.Session, "id" | "url">>;

/** sessions.create jak Stripe przy idempotencji: ten sam klucz → ta sama sesja; inne parametry → błąd. */
function fakeStripe() {
  const sessions = new Map<string, { id: string; url: string; params: string }>();
  let counter = 0;
  const create = vi.fn<CreateFn>(async (params, options) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const key = options?.idempotencyKey ?? `no-key-${counter}`;
    const serialized = JSON.stringify(params);
    let session = sessions.get(key);
    if (session && session.params !== serialized) throw new Error("StripeIdempotencyError: different parameters");
    if (!session) {
      counter++;
      const id = `cs_test_${counter}`;
      session = { id, url: `https://checkout.stripe.com/c/pay/${id}`, params: serialized };
      sessions.set(key, session);
    }
    return { id: session.id, url: session.url };
  });
  vi.mocked(getStripe).mockReturnValue({ checkout: { sessions: { create } } } as unknown as Stripe);
  return create;
}

let ipCounter = 0;

type Result = { status: number; body: Record<string, unknown>; text: string };

async function apiCheckout(id: string, body?: unknown, headers: Record<string, string> = {}): Promise<Result> {
  ipCounter++;
  const h = new Headers(headers);
  if (!h.has("x-real-ip")) h.set("x-real-ip", `203.0.113.${ipCounter % 250}`);
  const raw = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const res = await checkoutRoute(
    new Request(`http://localhost:3000/api/reservations/${id}/checkout`, { method: "POST", body: raw, headers: h }),
    { params: Promise.resolve({ id }) },
  );
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

async function apiPoints(id: string, query = ""): Promise<Result> {
  ipCounter++;
  const res = await pointsRoute(
    new Request(`http://localhost:3000/api/reservations/${id}/points${query}`, {
      headers: { "x-real-ip": `192.0.2.${ipCounter % 250}` },
    }),
    { params: Promise.resolve({ id }) },
  );
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

/** Liczniki limitu żyją w Mongo między uruchomieniami testów — każdy test limitu ma własne IP. */
function uniqueIp(): string {
  return `rl-${new ObjectId().toHexString()}`;
}

let seatCounter = 0;
let emailCounter = 0;

function newEmail(): string {
  emailCounter++;
  return `punkty${emailCounter}@example.com`;
}

async function reserve(email: string): Promise<string> {
  seatCounter = (seatCounter % 40) + 1;
  const seatId = `${seatCounter <= 20 ? 1 : 2}-${((seatCounter - 1) % 20) + 1}`;
  const result = await createReservation({ eventId: FUTURE_EVENT._id, seatId, customerName: "Piotr Punktowy", email });
  if (!result.ok) throw new Error(`Rezerwacja ${seatId} nie powiodła się: ${result.error}`);
  return result.reservationId;
}

async function findReservation(id: string) {
  return (await reservationsCollection()).findOne({ _id: new ObjectId(id) });
}

/** Saldo w memory; e-mail bez karty → null (dla API to 1000, D14). */
async function memoryBalance(email: string): Promise<number | null> {
  return (await getLoyaltyClient().findMember(email))?.balance ?? null;
}

/** Klient z kartą i zadanym saldem (bez punktów powitalnych — jak karta założona w panelu). */
async function seedBalance(email: string, points: number): Promise<void> {
  const client = getLoyaltyClient();
  const { memberId, cardId } = await client.createMember(email);
  if (points > 0) await client.addPoints(memberId, cardId, points, `seed-${email}`);
}

/** Śledzi wszystkie wywołania klienta Voucherify (memory) bez zmiany zachowania. */
function spyLoyalty() {
  const client = getLoyaltyClient();
  return {
    findMember: vi.spyOn(client, "findMember"),
    createMember: vi.spyOn(client, "createMember"),
    addPoints: vi.spyOn(client, "addPoints"),
    getTransaction: vi.spyOn(client, "getTransaction"),
    findTransactionByReason: vi.spyOn(client, "findTransactionByReason"),
  };
}

function totalCalls(spies: ReturnType<typeof spyLoyalty>): number {
  return Object.values(spies).reduce((sum, spy) => sum + spy.mock.calls.length, 0);
}

/** Ile razy z karty zeszły punkty (addPoints z ujemną liczbą). */
function spendCalls(spies: ReturnType<typeof spyLoyalty>): number {
  return spies.addPoints.mock.calls.filter(([, , points]) => points < 0).length;
}

/** Voucherify „nie działa”: każde wywołanie klienta rzuca LoyaltyUnavailableError. */
function breakLoyalty(spies: ReturnType<typeof spyLoyalty>): void {
  for (const spy of Object.values(spies)) {
    spy.mockRejectedValue(new LoyaltyUnavailableError("Voucherify 503 (test)"));
  }
}

beforeAll(resetTestData);
beforeEach(async () => {
  process.env.APP_URL = APP_URL;
  process.env.RATE_LIMIT_MAX = "100000";
  delete process.env.RATE_LIMIT_WINDOW_SECONDS;
  process.env.RESERVATION_TTL_SECONDS = "120";
  vi.mocked(getStripe).mockReset();
  resetMemoryLoyalty();
  await (await reservationsCollection()).deleteMany({});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(acquireSpendLock).mockClear();
  vi.mocked(releaseSpendLock).mockClear();
});
afterAll(async () => {
  delete process.env.APP_URL;
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.RATE_LIMIT_WINDOW_SECONDS;
  delete process.env.RESERVATION_TTL_SECONDS;
  await closeDb();
});

describe("POST /checkout — walidacja body (D22, Z37, Z53)", () => {
  it.each<[string, string]>([
    ["string „100”", '{"points":"100"}'],
    ["ułamek", '{"points":1.5}'],
    ["ujemna", '{"points":-1}'],
    ["NaN", '{"points":NaN}'],
    ["null", '{"points":null}'],
    ["obiekt", '{"points":{}}'],
    ["tablica", '{"points":[1000]}'],
    ["true", '{"points":true}'],
    ["poza safe integer", '{"points":1e300}'],
    ["2^53", '{"points":9007199254740992}'],
    ["body tablica", "[1000]"],
    ["body null", "null"],
    ["body liczba", "1000"],
    ["body string", '"points"'],
    ["zły JSON", "{points: 1000}"],
    ["body > 10 kB", JSON.stringify({ points: 1, pad: "x".repeat(11 * 1024) })],
  ])("%s → 400 VALIDATION_ERROR, bez Stripe i Voucherify", async (_label, raw) => {
    const create = fakeStripe();
    const spies = spyLoyalty();
    const id = await reserve(newEmail());

    const res = await apiCheckout(id, raw, { "content-type": "application/json" });

    expect(res.status, res.text).toBe(400);
    expect(res.body).toEqual({ error: "VALIDATION_ERROR", message: expect.any(String) });
    expect(create).not.toHaveBeenCalled();
    expect(totalCalls(spies)).toBe(0);
    expect((await findReservation(id))?.loyalty).toBeUndefined();
  });

  it(`${MAX_POINTS + 1} pkt przy cenie ${TEST_PRICE} → 400 POINTS_OVER_LIMIT z maxPoints, bez Voucherify`, async () => {
    const create = fakeStripe();
    const spies = spyLoyalty();
    const id = await reserve(newEmail());

    const res = await apiCheckout(id, { points: MAX_POINTS + 1 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "POINTS_OVER_LIMIT", message: expect.stringContaining("4450 pkt"), maxPoints: MAX_POINTS });
    expect(create).not.toHaveBeenCalled();
    expect(totalCalls(spies)).toBe(0);
  });

  it("1e9 pkt → POINTS_OVER_LIMIT (Z37)", async () => {
    fakeStripe();
    const id = await reserve(newEmail());
    const res = await apiCheckout(id, { points: 1e9 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("POINTS_OVER_LIMIT");
  });

  it.each<[string, string | undefined]>([
    ["brak body", undefined],
    ["puste body", ""],
    ["białe znaki", "  \n"],
    ["{}", "{}"],
    ["points 0", '{"points":0}'],
    ["-0", '{"points":-0}'],
  ])("%s → jak points 0: sesja na pełną kwotę, zero wywołań Voucherify", async (_label, raw) => {
    const create = fakeStripe();
    const spies = spyLoyalty();
    const id = await reserve(newEmail());

    const res = await apiCheckout(id, raw);

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ pointsUsed: 0, cardAmount: TEST_PRICE });
    expect(create.mock.calls[0][0].line_items?.[0].price_data?.unit_amount).toBe(TEST_PRICE);
    expect(create.mock.calls[0][0].metadata).toMatchObject({ pointsUsed: "0" });
    expect(totalCalls(spies)).toBe(0);
    expect(await findReservation(id)).toMatchObject({ pointsUsed: 0, cardAmount: TEST_PRICE });
  });

  it("{ amount: 100 } → sesja na pełną kwotę z bazy (Z53, II.A1)", async () => {
    const create = fakeStripe();
    const id = await reserve(newEmail());

    const res = await apiCheckout(id, { amount: 100, cardAmount: 1, pointsUsed: 8000 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pointsUsed: 0, cardAmount: TEST_PRICE });
    expect(create.mock.calls[0][0].line_items?.[0].price_data).toMatchObject({ currency: "pln", unit_amount: TEST_PRICE });
  });

  it("limit ruchu przed walidacją — złe body też się liczy (D7)", async () => {
    fakeStripe();
    process.env.RATE_LIMIT_MAX = "2";
    process.env.RATE_LIMIT_WINDOW_SECONDS = "3600"; // bez przejścia przez granicę okna w trakcie testu
    const id = await reserve(newEmail());
    const ip = { "x-real-ip": uniqueIp() };

    const first = await apiCheckout(id, '{"points":"x"}', ip);
    const second = await apiCheckout(id, '{"points":-5}', ip);
    const third = await apiCheckout(id, '{"points":"x"}', ip);

    expect([first.status, second.status, third.status]).toEqual([400, 400, 429]);
    expect(third.body.error).toBe("RATE_LIMITED");
  });
});

describe("POST /checkout z punktami (D15, D16)", () => {
  it("1000 pkt: sesja na 7900 z opisem punktów, saldo w memory 0, pointsUsed 1000", async () => {
    const create = fakeStripe();
    const email = newEmail();
    const id = await reserve(email);

    const res = await apiCheckout(id, { points: 1000 });

    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_1", pointsUsed: 1000, cardAmount: 7900 });
    expect(create).toHaveBeenCalledTimes(1);
    const [params, options] = create.mock.calls[0];
    expect(options).toEqual({ idempotencyKey: `checkout-${id}` });
    expect(params.line_items?.[0].price_data).toMatchObject({ currency: "pln", unit_amount: 7900 });
    expect(params.line_items?.[0].price_data?.product_data?.description).toMatch(
      /^Wagon \d, miejsce \d+ · .+, odjazd \d\d:\d\d · punkty: −10,00\s?zł$/u,
    );
    expect(params.metadata).toEqual({ reservationId: id, eventId: FUTURE_EVENT._id, seatId: expect.any(String), pointsUsed: "1000" });

    expect(await memoryBalance(email)).toBe(0);
    const doc = await findReservation(id);
    expect(doc).toMatchObject({ status: "held", pointsUsed: 1000, cardAmount: 7900, loyalty: { spend: { status: "done", points: 1000 } } });
    expect(doc?.payment?.url).toBe(res.body.url);
    // Blokada e-maila zajęta i zwolniona (Z36).
    expect(acquireSpendLock).toHaveBeenCalledTimes(1);
    expect(releaseSpendLock).toHaveBeenCalledTimes(1);
  });

  it("parametry sesji z punktami są deterministyczne (ten sam idempotency key)", async () => {
    const create = fakeStripe();
    create.mockRejectedValueOnce(new Error("Stripe down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await reserve(newEmail());

    expect((await apiCheckout(id, { points: 1000 })).status).toBe(503);
    expect((await apiCheckout(id, { points: 1000 })).status).toBe(200);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).toEqual(create.mock.calls[0][0]);
  });

  it("10 równoległych checkoutów z 1000 pkt → jeden url, saldo zeszło dokładnie raz (Z38)", async () => {
    const create = fakeStripe();
    const spies = spyLoyalty();
    const email = newEmail();
    await seedBalance(email, 3000); // przy podwójnym pobraniu saldo zeszłoby do 1000
    const id = await reserve(email);

    const results = await Promise.all(Array.from({ length: 10 }, () => apiCheckout(id, { points: 1000 })));

    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(new Set(results.map((r) => r.body.url)).size).toBe(1);
    for (const r of results) expect(r.body).toMatchObject({ pointsUsed: 1000, cardAmount: 7900 });
    expect(spendCalls(spies)).toBe(1);
    expect(await memoryBalance(email)).toBe(2000);
    for (const [, options] of create.mock.calls) expect(options).toEqual({ idempotencyKey: `checkout-${id}` });
    expect((await findReservation(id))?.payment?.url).toBe(results[0].body.url);
  });

  it("zmiana punktów po pierwszym checkoucie → 409 POINTS_LOCKED, sesja ta sama (D16, Z45)", async () => {
    const create = fakeStripe();
    const spies = spyLoyalty();
    const email = newEmail();
    const id = await reserve(email);
    const first = await apiCheckout(id, { points: 1000 });
    expect(first.status).toBe(200);
    const callsAfterFirst = totalCalls(spies);

    for (const points of [500, 0, 1001]) {
      const res = await apiCheckout(id, { points });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "POINTS_LOCKED", message: expect.stringContaining("1000 pkt"), pointsUsed: 1000 });
    }
    // Bez points i z tą samą liczbą → ten sam url, bez Stripe i bez Voucherify.
    expect((await apiCheckout(id)).body).toEqual(first.body);
    expect((await apiCheckout(id, {})).body).toEqual(first.body);
    expect((await apiCheckout(id, { points: 1000 })).body).toEqual(first.body);

    expect(create).toHaveBeenCalledTimes(1);
    expect(totalCalls(spies)).toBe(callsAfterFirst);
    expect(await memoryBalance(email)).toBe(0);
  });

  it("sesja bez punktów, potem 1000 pkt → 409 POINTS_LOCKED z pointsUsed 0", async () => {
    const create = fakeStripe();
    const spies = spyLoyalty();
    const id = await reserve(newEmail());
    const first = await apiCheckout(id);

    const res = await apiCheckout(id, { points: 1000 });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "POINTS_LOCKED", pointsUsed: 0 });
    expect((await apiCheckout(id, { points: 0 })).body).toEqual(first.body);
    expect(create).toHaveBeenCalledTimes(1);
    expect(totalCalls(spies)).toBe(0);
  });

  it("za mało punktów → 409 INSUFFICIENT_POINTS z balance; bez payment, spend failed; potem bez punktów działa", async () => {
    const create = fakeStripe();
    const spies = spyLoyalty();
    const email = newEmail();
    await seedBalance(email, 820);
    const id = await reserve(email);

    const res = await apiCheckout(id, { points: 1000 });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "INSUFFICIENT_POINTS", message: expect.stringContaining("820 pkt"), balance: 820 });
    expect(create).not.toHaveBeenCalled();
    expect(spendCalls(spies)).toBe(0);
    expect(await memoryBalance(email)).toBe(820);
    const doc = await findReservation(id);
    expect(doc?.payment).toBeUndefined();
    expect(doc?.loyalty?.spend?.status).toBe("failed");
    expect(doc?.pointsUsed).toBeUndefined();
    expect(doc?.cardAmount).toBeUndefined();
    expect(releaseSpendLock).toHaveBeenCalledTimes(1);

    // Klient wybiera mniej punktów albo płaci bez nich.
    const withoutPoints = await apiCheckout(id);
    expect(withoutPoints.status).toBe(200);
    expect(withoutPoints.body).toMatchObject({ pointsUsed: 0, cardAmount: TEST_PRICE });
    expect(create.mock.calls[0][0].line_items?.[0].price_data?.unit_amount).toBe(TEST_PRICE);
  });

  it("za mało punktów, potem mniej punktów → sesja z nową liczbą", async () => {
    const create = fakeStripe();
    const email = newEmail();
    await seedBalance(email, 820);
    const id = await reserve(email);

    expect((await apiCheckout(id, { points: 1000 })).status).toBe(409);
    const res = await apiCheckout(id, { points: 820 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pointsUsed: 820, cardAmount: TEST_PRICE - 820 });
    expect(create.mock.calls[0][0].line_items?.[0].price_data?.unit_amount).toBe(TEST_PRICE - 820);
    expect(await memoryBalance(email)).toBe(0);
  });

  it("Voucherify odrzuca pobranie (REJECTED) → 409 INSUFFICIENT_POINTS, spend failed, bez sesji (Z55)", async () => {
    const create = fakeStripe();
    const email = newEmail();
    await seedBalance(email, 1000);
    const id = await reserve(email);
    const client = getLoyaltyClient();
    // Saldo zmienia się między odczytem a pobraniem: po odczycie 1000 ktoś zdejmuje 700.
    const realFind = client.findMember.bind(client);
    let reads = 0;
    vi.spyOn(client, "findMember").mockImplementation(async (e) => {
      const member = await realFind(e);
      if (member && ++reads === 1) await client.addPoints(member.memberId, member.cardId, -700, "panel");
      return member;
    });

    const res = await apiCheckout(id, { points: 1000 });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "INSUFFICIENT_POINTS", balance: 300 });
    expect(create).not.toHaveBeenCalled();
    expect((await findReservation(id))?.loyalty?.spend?.status).toBe("failed");
    expect(await memoryBalance(email)).toBe(300);
  });

  it("pobranie wciąż PENDING → 503 LOYALTY_UNAVAILABLE, spend retry, bez sesji Stripe (Z55)", async () => {
    const create = fakeStripe();
    vi.spyOn(getLoyaltyClient(), "getTransaction").mockResolvedValue({ status: "PENDING" });
    const id = await reserve(newEmail());

    const res = await apiCheckout(id, { points: 1000 });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "LOYALTY_UNAVAILABLE", message: expect.any(String) });
    expect(create).not.toHaveBeenCalled();
    const doc = await findReservation(id);
    expect(doc?.loyalty?.spend?.status).toBe("retry");
    expect(doc?.payment).toBeUndefined();
    expect(doc?.pointsUsed).toBeUndefined();
  });

  it("dwie rezerwacje jednego e-maila, równolegle po 1000 pkt (saldo 1000) → jedna sesja ze zniżką, saldo ≥ 0 (Z36)", async () => {
    const create = fakeStripe();
    const email = newEmail();
    const [a, b] = [await reserve(email), await reserve(email)];

    const results = await Promise.all([apiCheckout(a, { points: 1000 }), apiCheckout(b, { points: 1000 })]);

    const ok = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status !== 200);
    expect(ok).toHaveLength(1);
    expect(ok[0].body).toMatchObject({ pointsUsed: 1000, cardAmount: 7900 });
    expect(refused).toHaveLength(1);
    expect(refused[0].status).toBe(409);
    expect(["LOYALTY_BUSY", "INSUFFICIENT_POINTS"]).toContain(refused[0].body.error);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await memoryBalance(email)).toBe(0);

    const docs = await Promise.all([findReservation(a), findReservation(b)]);
    expect(docs.filter((d) => d?.loyalty?.spend?.status === "done")).toHaveLength(1);
    expect(docs.filter((d) => d?.payment)).toHaveLength(1);
  });

  it("blokada e-maila zajęta → 409 LOYALTY_BUSY, spend retry, saldo nietknięte (Z36)", async () => {
    const create = fakeStripe();
    const spies = spyLoyalty();
    vi.mocked(acquireSpendLock).mockResolvedValueOnce(false);
    const email = newEmail();
    const id = await reserve(email);

    const res = await apiCheckout(id, { points: 1000 });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "LOYALTY_BUSY", message: expect.any(String) });
    expect(create).not.toHaveBeenCalled();
    expect(totalCalls(spies)).toBe(0);
    expect(releaseSpendLock).not.toHaveBeenCalled();
    const doc = await findReservation(id);
    expect(doc?.loyalty?.spend?.status).toBe("retry");
    expect(doc?.pointsUsed).toBeUndefined();

    // Po chwili — przechodzi.
    expect((await apiCheckout(id, { points: 1000 })).status).toBe(200);
  });

  it("Voucherify niedostępny → 503 LOYALTY_UNAVAILABLE bez szczegółów, brak sesji Stripe, spend retry (D20, Z43)", async () => {
    const create = fakeStripe();
    const spies = spyLoyalty();
    breakLoyalty(spies);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await reserve(newEmail());

    const res = await apiCheckout(id, { points: 1000 });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "LOYALTY_UNAVAILABLE", message: expect.any(String) });
    expect(res.text).not.toMatch(LEAK);
    expect(errorLog).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    const doc = await findReservation(id);
    expect(doc?.loyalty?.spend?.status).toBe("retry");
    expect(doc?.payment).toBeUndefined();
    expect(doc?.pointsUsed).toBeUndefined();
    expect(releaseSpendLock).toHaveBeenCalledTimes(1);
  });

  it("timeout przy pobraniu (uncertain) → 503, spend retry — bez sesji ze zniżką (Z44)", async () => {
    const create = fakeStripe();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(getLoyaltyClient(), "addPoints").mockImplementation(async (_m, _c, points) => {
      if (points < 0) throw new LoyaltyUnavailableError("timeout", { uncertain: true });
      return { transactionId: "lctx_welcome" };
    });
    const id = await reserve(newEmail());

    const res = await apiCheckout(id, { points: 1000 });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("LOYALTY_UNAVAILABLE");
    expect(create).not.toHaveBeenCalled();
    expect((await findReservation(id))?.loyalty?.spend?.status).toBe("retry");
  });

  it("pobranie przeszło, ale krok spend nie jest już pending (przejęty) → 503, bez sesji ze zniżką (Z44)", async () => {
    const create = fakeStripe();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = getLoyaltyClient();
    const realAdd = client.addPoints.bind(client);
    const id = await reserve(newEmail());
    vi.spyOn(client, "addPoints").mockImplementation(async (memberId, cardId, points, reason) => {
      const tx = await realAdd(memberId, cardId, points, reason);
      // Inny proces przejął krok w trakcie naszego wywołania — finishPointsSpend("done") nic nie zapisze.
      if (points < 0) {
        await (await reservationsCollection()).updateOne({ _id: new ObjectId(id) }, { $set: { "loyalty.spend.status": "retry" } });
      }
      return tx;
    });

    const res = await apiCheckout(id, { points: 1000 });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("LOYALTY_UNAVAILABLE");
    expect(create).not.toHaveBeenCalled();
    expect((await findReservation(id))?.payment).toBeUndefined();
  });

  it("points 0 przy niedziałającym Voucherify → 200 jak w Etapie II, zero wywołań (Z43)", async () => {
    const create = fakeStripe();
    const spies = spyLoyalty();
    breakLoyalty(spies);
    const id = await reserve(newEmail());

    const res = await apiCheckout(id, { points: 0 });
    const noBody = await apiCheckout(id);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pointsUsed: 0, cardAmount: TEST_PRICE });
    expect(noBody.body).toEqual(res.body);
    expect(totalCalls(spies)).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("błąd Stripe po pobraniu punktów → 503 PAYMENT_UNAVAILABLE; ponowny checkout bez drugiego pobrania", async () => {
    const create = fakeStripe();
    const spies = spyLoyalty();
    vi.spyOn(console, "error").mockImplementation(() => {});
    create.mockRejectedValueOnce(new Error("StripeConnectionError: socket hang up sk_test_xyz"));
    const email = newEmail();
    const id = await reserve(email);

    const res = await apiCheckout(id, { points: 1000 });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "PAYMENT_UNAVAILABLE", message: expect.any(String) });
    expect(res.text).not.toMatch(LEAK);
    expect(await memoryBalance(email)).toBe(0);
    const doc = await findReservation(id);
    expect(doc).toMatchObject({ pointsUsed: 1000, cardAmount: 7900, loyalty: { spend: { status: "done" } } });
    expect(doc?.payment).toBeUndefined();

    // Zmiana punktów — już nie (punkty zeszły z karty).
    expect((await apiCheckout(id, { points: 0 })).body).toMatchObject({ error: "POINTS_LOCKED", pointsUsed: 1000 });
    expect((await apiCheckout(id, { points: 500 })).body).toMatchObject({ error: "POINTS_LOCKED", pointsUsed: 1000 });

    // Ponowne „Zapłać” (z tą samą liczbą albo bez points) → sesja, bez ponownego pobrania.
    const retry = await apiCheckout(id, { points: 1000 });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ pointsUsed: 1000, cardAmount: 7900 });
    expect((await apiCheckout(id)).body).toEqual(retry.body);
    expect(spendCalls(spies)).toBe(1);
    expect(await memoryBalance(email)).toBe(0);
    expect(create.mock.calls.at(-1)?.[0].line_items?.[0].price_data?.unit_amount).toBe(7900);
  });

  it("wygasła rezerwacja z punktami w body → 410, Voucherify niewołany", async () => {
    fakeStripe();
    const spies = spyLoyalty();
    const id = await reserve(newEmail());
    await (await reservationsCollection()).updateOne({ _id: new ObjectId(id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await apiCheckout(id, { points: 1000 });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("RESERVATION_EXPIRED");
    expect(totalCalls(spies)).toBe(0);
  });

  it("równolegle 0 pkt i 1000 pkt na tę samą rezerwację → nikt nie dostaje sesji niezgodnej z rezerwacją", async () => {
    fakeStripe();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await reserve(newEmail());

    const results = await Promise.all([apiCheckout(id, { points: 0 }), apiCheckout(id, { points: 1000 })]);

    const doc = await findReservation(id);
    for (const r of results.filter((x) => x.status === 200)) {
      // Kto dostał url, dostał sesję na kwotę zapisaną w rezerwacji.
      expect(r.body.url).toBe(doc?.payment?.url);
      expect(r.body).toMatchObject({ pointsUsed: doc?.pointsUsed, cardAmount: doc?.cardAmount });
    }
    for (const r of results.filter((x) => x.status !== 200)) {
      expect(["POINTS_LOCKED", "PAYMENT_UNAVAILABLE"]).toContain(r.body.error);
    }
  });
});

describe("GET /api/reservations/:id/points", () => {
  it("nowy e-mail: balance 1000, maxPoints 1000, locked false; bez e-maila w odpowiedzi; karta niezakładana (D14)", async () => {
    const spies = spyLoyalty();
    const email = newEmail();
    const id = await reserve(email);

    const res = await apiPoints(id, `?email=${encodeURIComponent("ktos@inny.pl")}`);

    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ balance: 1000, maxPoints: 1000, pointsUsed: 0, locked: false });
    expect(res.text).not.toContain("@");
    expect(spies.findMember).toHaveBeenCalledWith(email);
    expect(spies.createMember).not.toHaveBeenCalled();
  });

  it("saldo większe niż połowa ceny → maxPoints = 4450", async () => {
    const email = newEmail();
    await seedBalance(email, 9000);
    const id = await reserve(email);

    const res = await apiPoints(id);

    expect(res.body).toEqual({ balance: 9000, maxPoints: MAX_POINTS, pointsUsed: 0, locked: false });
  });

  it("po checkoucie z 1000 pkt → locked true, maxPoints = pointsUsed", async () => {
    fakeStripe();
    const id = await reserve(newEmail());
    expect((await apiCheckout(id, { points: 1000 })).status).toBe(200);

    const res = await apiPoints(id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ balance: 0, maxPoints: 1000, pointsUsed: 1000, locked: true });
  });

  it("po checkoucie bez punktów → locked true, maxPoints 0", async () => {
    fakeStripe();
    const id = await reserve(newEmail());
    await apiCheckout(id);

    expect((await apiPoints(id)).body).toEqual({ balance: 1000, maxPoints: 0, pointsUsed: 0, locked: true });
  });

  it.each(["abc", "%7B%7D", "ffffffffffffffffffffffff", "A".repeat(5000), "507F1F77BCF86CD799439011"])(
    "zły / nieistniejący id %j → 404 RESERVATION_NOT_FOUND",
    async (id) => {
      const res = await apiPoints(id);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "RESERVATION_NOT_FOUND", message: expect.any(String) });
    },
  );

  it("Voucherify niedostępny → 503 LOYALTY_UNAVAILABLE bez szczegółów", async () => {
    const spies = spyLoyalty();
    breakLoyalty(spies);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await reserve(newEmail());

    const res = await apiPoints(id);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "LOYALTY_UNAVAILABLE", message: expect.any(String) });
    expect(res.text).not.toMatch(LEAK);
  });

  it("limit ruchu (kubełek loyalty) → 429 z Retry-After", async () => {
    process.env.RATE_LIMIT_MAX = "1";
    process.env.RATE_LIMIT_WINDOW_SECONDS = "3600";
    const id = await reserve(newEmail());
    const ip = uniqueIp();
    const call = () =>
      pointsRoute(new Request(`http://localhost:3000/api/reservations/${id}/points`, { headers: { "x-real-ip": ip } }), {
        params: Promise.resolve({ id }),
      });

    expect((await call()).status).toBe(200);
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});
