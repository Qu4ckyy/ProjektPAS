// Webhook Stripe i synchronizacja sesji — CONTRACT.md §3, D8, Z24–Z31, Z34.
// Stripe zmockowany (bez sieci), ale podpisy prawdziwe: generateTestHeaderString + constructEvent.
import { ObjectId } from "mongodb";
import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { POST as webhookRoute } from "@/app/api/webhooks/stripe/route";
import { closeDb, getDb, STRIPE_EVENTS_COLLECTION } from "@/lib/db";
import { createReservation, getTicketByCode, saveCheckoutSession } from "@/lib/reservations";
import { getStripe, PaymentUnavailableError } from "@/lib/stripe";
import { TICKET_CODE_REGEX, type CreateReservationBody } from "@/lib/types";
import {
  apiCreate,
  apiGetReservation,
  apiPurchase,
  paidSession,
  reservationsCollection,
  resetTestData,
  setTtl,
  TEST_PRICE,
  validBody,
} from "./helpers";

vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  return { ...actual, getStripe: vi.fn() };
});

const WEBHOOK_SECRET = "whsec_unit_only_not_real";
const LEAK = /\bat .+\(|Error:|Mongo|Stripe|node_modules|\/src\/|\.ts:\d|sk_test|whsec/;

const realStripe = new Stripe("sk_test_unit_only_not_real");
const refundsCreate = vi.fn();
const sessionsRetrieve = vi.fn();

let eventCounter = 0;
let seatCounter = 0;

type EventOptions = { id?: string; type?: string; created?: number };

function stripeEvent(session: Stripe.Checkout.Session, options: EventOptions = {}) {
  return {
    id: options.id ?? `evt_test_${++eventCounter}`,
    object: "event",
    type: options.type ?? "checkout.session.completed",
    created: options.created ?? Math.floor(Date.now() / 1000),
    data: { object: session },
  };
}

function sign(payload: string, overrides: { secret?: string; timestamp?: number } = {}): string {
  return realStripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET, ...overrides });
}

async function postRaw(body: BodyInit | undefined, signature?: string) {
  const headers = signature === undefined ? undefined : { "stripe-signature": signature };
  const res = await webhookRoute(new Request("http://localhost:3000/api/webhooks/stripe", { method: "POST", body, headers }));
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as unknown, text };
}

function postEvent(event: ReturnType<typeof stripeEvent>) {
  const payload = JSON.stringify(event);
  return postRaw(payload, sign(payload));
}

function nextSeat(): string {
  seatCounter = (seatCounter % 40) + 1;
  return `${seatCounter <= 20 ? 1 : 2}-${((seatCounter - 1) % 20) + 1}`;
}

async function reserve(seatId: string = nextSeat()): Promise<string> {
  const result = await createReservation(validBody({ seatId }) as unknown as CreateReservationBody);
  if (!result.ok) throw new Error(`Rezerwacja ${seatId} nie powiodła się: ${result.error}`);
  return result.reservationId;
}

async function findReservation(id: string) {
  return (await reservationsCollection()).findOne({ _id: new ObjectId(id) });
}

/** Przestawia expiresAt rezerwacji, zamiast czekać na TTL. Zwraca nową wartość. */
async function setExpiresAt(id: string, expiresAt: Date): Promise<Date> {
  await (await reservationsCollection()).updateOne({ _id: new ObjectId(id) }, { $set: { expiresAt } });
  return expiresAt;
}

async function stripeEventsCollection() {
  return (await getDb()).collection<{ _id: string; type: string; reservationId?: string; outcome: string }>(
    STRIPE_EVENTS_COLLECTION,
  );
}

function expectHeldWithoutTicket(doc: Awaited<ReturnType<typeof findReservation>>): void {
  expect(doc).toMatchObject({ status: "held", active: true, code: null });
  expect(doc).not.toHaveProperty("paidAt");
}

function expectError(res: { status: number; body: unknown; text: string }, status: number, error: string): void {
  expect(res.status, res.text).toBe(status);
  expect(res.body).toEqual({ error, message: expect.any(String) });
  expect(res.text).not.toMatch(LEAK);
}

let consoleError: MockInstance<typeof console.error>;
let consoleWarn: MockInstance<typeof console.warn>;

beforeAll(resetTestData);
beforeEach(async () => {
  setTtl(120);
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  refundsCreate.mockReset().mockImplementation(async (params: { payment_intent: string }) => ({
    id: `re_${params.payment_intent}`,
  }));
  sessionsRetrieve.mockReset();
  vi.mocked(getStripe).mockReset().mockReturnValue({
    webhooks: realStripe.webhooks,
    refunds: { create: refundsCreate },
    checkout: { sessions: { retrieve: sessionsRetrieve } },
  } as unknown as Stripe);
  await (await reservationsCollection()).deleteMany({});
  await (await stripeEventsCollection()).deleteMany({});
});
afterEach(() => {
  consoleError.mockRestore();
  consoleWarn.mockRestore();
});
afterAll(async () => {
  setTtl(undefined);
  delete process.env.STRIPE_WEBHOOK_SECRET;
  await closeDb();
});

describe("Z27: podpis", () => {
  it("brak nagłówka → 400 INVALID_SIGNATURE, nic się nie zmienia", async () => {
    const id = await reserve();
    expectError(await postRaw(JSON.stringify(stripeEvent(paidSession(id)))), 400, "INVALID_SIGNATURE");
    expectHeldWithoutTicket(await findReservation(id));
    expect(await (await stripeEventsCollection()).countDocuments()).toBe(0);
  });

  it("brak sekretu na serwerze → 400, a przyczyna tylko w logach", async () => {
    const id = await reserve();
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const payload = JSON.stringify(stripeEvent(paidSession(id)));
    expectError(await postRaw(payload, sign(payload)), 400, "INVALID_SIGNATURE");
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("STRIPE_WEBHOOK_SECRET"));
    expectHeldWithoutTicket(await findReservation(id));
  });

  it.each<[string, (payload: string) => string]>([
    ["śmieci w nagłówku", () => "nie-podpis"],
    ["pusty nagłówek t=,v1=", () => "t=,v1="],
    ["podpis innym sekretem", (payload) => sign(payload, { secret: "whsec_inny" })],
    ["podpis sprzed godziny", (payload) => sign(payload, { timestamp: Math.floor(Date.now() / 1000) - 3600 })],
    ["podpis innego body", () => sign('{"id":"evt_inny"}')],
  ])("%s → 400, rezerwacja held", async (_name, signature) => {
    const id = await reserve();
    const payload = JSON.stringify(stripeEvent(paidSession(id)));
    expectError(await postRaw(payload, signature(payload)), 400, "INVALID_SIGNATURE");
    expectHeldWithoutTicket(await findReservation(id));
    expect(await (await stripeEventsCollection()).countDocuments()).toBe(0);
  });

  it("body ponad 1 MB → 400 bez weryfikacji", async () => {
    const payload = "x".repeat(1024 * 1024 + 1);
    expectError(await postRaw(payload, sign(payload)), 400, "INVALID_SIGNATURE");
    expect(getStripe).not.toHaveBeenCalled();
  });

  it("podpis liczony z surowych bajtów: polskie znaki w body nie psują weryfikacji", async () => {
    const id = await reserve();
    const session = paidSession(id, { metadata: { reservationId: id, opis: "Zażółć gęślą jaźń → 🚆" } });
    const res = await postEvent(stripeEvent(session));
    expect(res.status, res.text).toBe(200);
    expect((await findReservation(id))?.status).toBe("paid");
  });

  it("brak klucza Stripe przy poprawnym podpisie → 500 bez szczegółów (Stripe ponowi)", async () => {
    const id = await reserve();
    vi.mocked(getStripe).mockImplementation(() => {
      throw new PaymentUnavailableError("Brak STRIPE_SECRET_KEY.");
    });
    const payload = JSON.stringify(stripeEvent(paidSession(id)));
    expectError(await postRaw(payload, sign(payload)), 500, "INTERNAL_ERROR");
    expectHeldWithoutTicket(await findReservation(id));
  });
});

describe("przyjęcie płatności", () => {
  it("checkout.session.completed → paid, kod, paidAt, paymentIntentId; odpowiedź { received: true }", async () => {
    const id = await reserve();
    await saveCheckoutSession(id, { sessionId: `cs_test_${id}`, url: "https://checkout.stripe.com/c/pay/x", pointsUsed: 0, cardAmount: 8900 });

    const res = await postEvent(stripeEvent(paidSession(id)));
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ received: true });

    const doc = await findReservation(id);
    expect(doc).toMatchObject({ status: "paid", active: true, code: expect.stringMatching(TICKET_CODE_REGEX) });
    expect(doc!.paidAt).toBeInstanceOf(Date);
    expect(doc!.payment).toMatchObject({
      sessionId: `cs_test_${id}`,
      url: "https://checkout.stripe.com/c/pay/x",
      paymentIntentId: `pi_test_${id}`,
    });
    expect(refundsCreate).not.toHaveBeenCalled();
    expect(await (await stripeEventsCollection()).findOne({ reservationId: id })).toMatchObject({
      type: "checkout.session.completed",
      outcome: "paid",
    });

    // Opłacone: bilet po kodzie i zgodność z D5.
    expect(await getTicketByCode(doc!.code!)).toMatchObject({ code: doc!.code, amount: TEST_PRICE });
    expect((await apiPurchase(id)).body).toEqual({ code: doc!.code });
  });

  it("payment_intent jako rozwinięty obiekt też działa", async () => {
    const id = await reserve();
    const session = paidSession(id, { payment_intent: { id: "pi_obiekt" } as Stripe.PaymentIntent });
    expect((await postEvent(stripeEvent(session))).status).toBe(200);
    expect((await findReservation(id))?.payment?.paymentIntentId).toBe("pi_obiekt");
  });

  it("płatność odroczona: completed bez zapłaty → ignored, async_payment_succeeded → paid", async () => {
    const id = await reserve();
    await postEvent(stripeEvent(paidSession(id, { payment_status: "unpaid" })));
    expectHeldWithoutTicket(await findReservation(id));

    await postEvent(stripeEvent(paidSession(id), { type: "checkout.session.async_payment_succeeded" }));
    expect((await findReservation(id))?.status).toBe("paid");
  });

  it("D8: potwierdzona 5 s po expiresAt, miejsce dalej trzymane → przyjęta, miejsce zostaje przy nim", async () => {
    const id = await reserve("1-1");
    await setExpiresAt(id, new Date(Date.now() - 5_000));

    await postEvent(stripeEvent(paidSession(id)));
    expect((await findReservation(id))?.status).toBe("paid");
    expect(refundsCreate).not.toHaveBeenCalled();
    expect((await apiCreate(validBody({ seatId: "1-1" }))).status).toBe(409);
  });
});

describe("Z28: ponowienia Stripe", () => {
  it("to samo zdarzenie 2× → jeden kod, jeden wpis, bez drugiego zapisu", async () => {
    const id = await reserve();
    const event = stripeEvent(paidSession(id));
    expect((await postEvent(event)).status).toBe(200);
    const first = await findReservation(id);

    expect((await postEvent(event)).status).toBe(200);
    expect(await findReservation(id)).toEqual(first);
    expect(await (await stripeEventsCollection()).countDocuments({ _id: event.id })).toBe(1);
  });

  it("10 równoległych kopii tego samego zdarzenia → jeden kod, jeden wpis, same 200", async () => {
    const id = await reserve();
    const event = stripeEvent(paidSession(id));
    const results = await Promise.all(Array.from({ length: 10 }, () => postEvent(event)));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect((await findReservation(id))?.code).toMatch(TICKET_CODE_REGEX);
    expect(await (await stripeEventsCollection()).countDocuments({ _id: event.id })).toBe(1);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("2 różne zdarzenia tej samej sesji → jeden kod i żadnego zwrotu", async () => {
    const id = await reserve();
    await postEvent(stripeEvent(paidSession(id)));
    const { code } = (await findReservation(id))!;

    await postEvent(stripeEvent(paidSession(id), { type: "checkout.session.async_payment_succeeded" }));
    expect((await findReservation(id))?.code).toBe(code);
    expect(refundsCreate).not.toHaveBeenCalled();
    expect(await (await stripeEventsCollection()).countDocuments({ reservationId: id })).toBe(2);
  });
});

describe("Z24: płatność po wygaśnięciu → zwrot", () => {
  it("po expiresAt + 10 s: brak biletu, zwrot raz, a miejsce nie wraca do spóźnionego", async () => {
    const id = await reserve("1-1");
    await setExpiresAt(id, new Date(Date.now() - 11_000));

    const res = await postEvent(stripeEvent(paidSession(id)));
    expect(res.status, res.text).toBe(200);

    expectHeldWithoutTicket(await findReservation(id));
    expect(refundsCreate).toHaveBeenCalledTimes(1);
    expect(refundsCreate).toHaveBeenCalledWith(
      { payment_intent: `pi_test_${id}` },
      { idempotencyKey: `refund-cs_test_${id}` },
    );
    expect((await findReservation(id))?.payment?.refunds).toEqual([
      { sessionId: `cs_test_${id}`, refundId: `re_pi_test_${id}`, reason: "late", at: expect.any(Date) },
    ]);
    expect(await (await stripeEventsCollection()).findOne({ reservationId: id })).toMatchObject({ outcome: "refunded" });

    // Rezerwacja dalej wyliczona jako wygasła, a miejsce może wziąć ktoś inny.
    expect((await apiGetReservation(id)).body).toMatchObject({ status: "expired" });
    expect((await apiCreate(validBody({ seatId: "1-1" }))).status).toBe(201);
    expect(await findReservation(id)).toMatchObject({ status: "expired", active: false, code: null });
  });

  it("granica D8: dokładnie 10 s po expiresAt → zwrot, 9 s → przyjęta", async () => {
    const created = Math.floor(Date.now() / 1000);

    const late = await reserve();
    await setExpiresAt(late, new Date((created - 10) * 1000));
    await postEvent(stripeEvent(paidSession(late), { created }));
    expectHeldWithoutTicket(await findReservation(late));
    expect(refundsCreate).toHaveBeenCalledTimes(1);

    const inTime = await reserve();
    await setExpiresAt(inTime, new Date((created - 9) * 1000));
    await postEvent(stripeEvent(paidSession(inTime), { created }));
    expect((await findReservation(inTime))?.status).toBe("paid");
    expect(refundsCreate).toHaveBeenCalledTimes(1);
  });

  it("liczy się czas potwierdzenia w Stripe, a nie dostarczenia: webhook spóźniony o godzinę → przyjęta", async () => {
    const id = await reserve();
    const expiresAt = await setExpiresAt(id, new Date(Date.now() - 60 * 60 * 1000));
    const created = Math.floor(expiresAt.getTime() / 1000) - 30;
    await postEvent(stripeEvent(paidSession(id), { created }));
    expect((await findReservation(id))?.status).toBe("paid");
  });

  it("rezerwacja wygasła i zwolniona, mimo że w oknie 10 s → zwrot not_held", async () => {
    const id = await reserve("1-2");
    await setExpiresAt(id, new Date(Date.now() - 3_000));
    expect((await apiCreate(validBody({ seatId: "1-2" }))).status).toBe(201);

    await postEvent(stripeEvent(paidSession(id)));
    const doc = await findReservation(id);
    expect(doc).toMatchObject({ status: "expired", active: false, code: null });
    expect(doc?.payment?.refunds?.[0]).toMatchObject({ reason: "not_held" });
    expect(refundsCreate).toHaveBeenCalledTimes(1);
  });

  it("ponowienia spóźnionej płatności: to samo zdarzenie i inne zdarzenie sesji → jeden zwrot, jeden wpis", async () => {
    const id = await reserve();
    await setExpiresAt(id, new Date(Date.now() - 60_000));
    const event = stripeEvent(paidSession(id));

    await postEvent(event);
    await postEvent(event);
    await postEvent(stripeEvent(paidSession(id), { type: "checkout.session.async_payment_succeeded" }));

    expect(refundsCreate).toHaveBeenCalledTimes(1);
    expect((await findReservation(id))?.payment?.refunds).toHaveLength(1);
  });

  it("5 równoległych kopii spóźnionego zdarzenia → ten sam klucz idempotencji, jeden wpis", async () => {
    const id = await reserve();
    await setExpiresAt(id, new Date(Date.now() - 60_000));
    const event = stripeEvent(paidSession(id));

    const results = await Promise.all(Array.from({ length: 5 }, () => postEvent(event)));
    expect(results.map((r) => r.status)).toEqual(Array(5).fill(200));
    for (const [, options] of refundsCreate.mock.calls) {
      expect(options).toEqual({ idempotencyKey: `refund-cs_test_${id}` });
    }
    expect((await findReservation(id))?.payment?.refunds).toHaveLength(1);
  });
});

describe("Z25: płatność X vs rezerwacja Y w chwili wygaśnięcia (C2)", () => {
  it("najpierw webhook X → X ma miejsce, Y dostaje 409, bez zwrotu", async () => {
    const x = await reserve("2-1");
    await setExpiresAt(x, new Date(Date.now() - 2_000));

    await postEvent(stripeEvent(paidSession(x)));
    expect((await apiCreate(validBody({ seatId: "2-1" }))).status).toBe(409);
    expect(await findReservation(x)).toMatchObject({ status: "paid", active: true });
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("najpierw rezerwacja Y → Y ma miejsce, X dostaje zwrot i nie ma biletu", async () => {
    const x = await reserve("2-2");
    await setExpiresAt(x, new Date(Date.now() - 2_000));

    expect((await apiCreate(validBody({ seatId: "2-2" }))).status).toBe(201);
    await postEvent(stripeEvent(paidSession(x)));
    expect(await findReservation(x)).toMatchObject({ status: "expired", active: false, code: null });
    expect(refundsCreate).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2, 3, 4, 5])("równolegle, runda %i: zawsze jeden właściciel, a przegrany X dostaje zwrot", async (round) => {
    const seatId = `2-${10 + round}`;
    const x = await reserve(seatId);
    await setExpiresAt(x, new Date(Date.now() - 2_000));

    const [webhook, y] = await Promise.all([postEvent(stripeEvent(paidSession(x))), apiCreate(validBody({ seatId }))]);
    expect(webhook.status, webhook.text).toBe(200);

    const reservations = await reservationsCollection();
    const holders = await reservations.find({ seatId, active: true }).toArray();
    expect(holders).toHaveLength(1);

    const doc = await findReservation(x);
    if (doc?.status === "paid") {
      expect(y.status).toBe(409);
      expect(refundsCreate).not.toHaveBeenCalled();
    } else {
      expect(y.status).toBe(201);
      expect(doc).toMatchObject({ status: "expired", active: false, code: null });
      expect(refundsCreate).toHaveBeenCalledTimes(1);
    }
  });
});

describe("Z26: druga płatność za tę samą rezerwację", () => {
  it("druga sesja dla opłaconej rezerwacji → zwrot duplicate, kod się nie zmienia", async () => {
    const id = await reserve();
    await postEvent(stripeEvent(paidSession(id)));
    const paid = (await findReservation(id))!;

    await postEvent(stripeEvent(paidSession(id, { id: "cs_test_druga", payment_intent: "pi_druga" })));

    const doc = await findReservation(id);
    expect(doc).toMatchObject({ status: "paid", code: paid.code });
    expect(doc?.payment?.paymentIntentId).toBe(paid.payment?.paymentIntentId);
    expect(refundsCreate).toHaveBeenCalledTimes(1);
    expect(refundsCreate).toHaveBeenCalledWith({ payment_intent: "pi_druga" }, { idempotencyKey: "refund-cs_test_druga" });
    expect(doc?.payment?.refunds?.[0]).toMatchObject({ sessionId: "cs_test_druga", reason: "duplicate" });
  });

  it("płaci inna sesja niż zapisana: ona dostaje bilet, a zapisana potem idzie na zwrot", async () => {
    const id = await reserve();
    await saveCheckoutSession(id, { sessionId: "cs_test_zapisana", url: "https://checkout.stripe.com/c/pay/zapisana", pointsUsed: 0, cardAmount: 8900 });

    await postEvent(stripeEvent(paidSession(id, { id: "cs_test_inna", payment_intent: "pi_inna" })));
    const paid = (await findReservation(id))!;
    expect(paid.status).toBe("paid");
    expect(paid.payment?.sessionId).toBe("cs_test_inna");

    // Inne zdarzenie sesji, która zapłaciła — bez zwrotu.
    await postEvent(
      stripeEvent(paidSession(id, { id: "cs_test_inna", payment_intent: "pi_inna" }), {
        type: "checkout.session.async_payment_succeeded",
      }),
    );
    expect(refundsCreate).not.toHaveBeenCalled();

    await postEvent(stripeEvent(paidSession(id, { id: "cs_test_zapisana", payment_intent: "pi_zapisana" })));
    expect(refundsCreate).toHaveBeenCalledWith(
      { payment_intent: "pi_zapisana" },
      { idempotencyKey: "refund-cs_test_zapisana" },
    );
    expect((await findReservation(id))?.code).toBe(paid.code);
  });
});

describe("Z29: zła kwota albo waluta → zwrot, rezerwacja held bez zmian", () => {
  it.each<[string, Partial<Stripe.Checkout.Session>]>([
    ["za mało", { amount_total: 100 }],
    ["za dużo", { amount_total: TEST_PRICE + 1 }],
    ["zero", { amount_total: 0 }],
    ["brak kwoty", { amount_total: null }],
    ["inna waluta", { currency: "eur" }],
    ["brak waluty", { currency: null }],
  ])("%s", async (_name, overrides) => {
    const id = await reserve();
    const res = await postEvent(stripeEvent(paidSession(id, overrides)));
    expect(res.status, res.text).toBe(200);

    const doc = await findReservation(id);
    expectHeldWithoutTicket(doc);
    expect(doc?.payment?.refunds?.[0]).toMatchObject({ reason: "amount_mismatch" });
    expect(refundsCreate).toHaveBeenCalledTimes(1);
  });

  it("dokument bez pola amount i sesja bez kwoty nie dają biletu", async () => {
    const id = await reserve();
    await (await reservationsCollection()).updateOne({ _id: new ObjectId(id) }, { $unset: { amount: "" } });
    await postEvent(stripeEvent(paidSession(id, { amount_total: null })));
    expect(await findReservation(id)).toMatchObject({ status: "held", code: null });
  });
});

describe("zdarzenia bez naszej rezerwacji → 200 i nic", () => {
  it.each<[string, Partial<Stripe.Checkout.Session>]>([
    ["brak client_reference_id (stripe trigger)", { client_reference_id: null, metadata: {} }],
    ["zły format", { client_reference_id: "abc", metadata: {} }],
    ["id 12-znakowy", { client_reference_id: "aaaaaaaaaaaa", metadata: {} }],
    ["obiekt zamiast id", { client_reference_id: { $ne: null } as unknown as string, metadata: {} }],
    ["nieistniejąca rezerwacja", { client_reference_id: "0123456789abcdef01234567", metadata: {} }],
  ])("%s", async (_name, overrides) => {
    const id = await reserve();
    const res = await postEvent(stripeEvent(paidSession(id, overrides)));
    expect(res.status, res.text).toBe(200);
    expect(refundsCreate).not.toHaveBeenCalled();
    expectHeldWithoutTicket(await findReservation(id));
    expect(await (await stripeEventsCollection()).findOne({})).toMatchObject({ outcome: "ignored" });
  });

  it("client_reference_id niezgodny z metadata → ignored", async () => {
    const id = await reserve();
    const session = paidSession(id, { metadata: { reservationId: "0123456789abcdef01234567" } });
    expect((await postEvent(stripeEvent(session))).status).toBe(200);
    expectHeldWithoutTicket(await findReservation(id));
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("inny typ zdarzenia → 200, outcome ignored", async () => {
    const id = await reserve();
    const event = stripeEvent(paidSession(id), { type: "payment_intent.succeeded" });
    expect((await postEvent(event)).status).toBe(200);
    expectHeldWithoutTicket(await findReservation(id));
    expect(await (await stripeEventsCollection()).findOne({ _id: event.id })).toMatchObject({
      type: "payment_intent.succeeded",
      outcome: "ignored",
    });
  });
});

describe("Z34: błędy po naszej stronie → 500, Stripe ponawia", () => {
  it("zwrot się nie udał → 500 bez szczegółów, brak wpisu; ponowienie kończy zwrot", async () => {
    const id = await reserve();
    await setExpiresAt(id, new Date(Date.now() - 60_000));
    const event = stripeEvent(paidSession(id));
    refundsCreate.mockRejectedValueOnce(new Error("Stripe API down: sk_test_sekret"));

    expectError(await postEvent(event), 500, "INTERNAL_ERROR");
    expect(await (await stripeEventsCollection()).countDocuments({ _id: event.id })).toBe(0);
    expect((await findReservation(id))?.payment?.refunds).toBeUndefined();

    expect((await postEvent(event)).status).toBe(200);
    expect(refundsCreate).toHaveBeenCalledTimes(2);
    expect((await findReservation(id))?.payment?.refunds).toHaveLength(1);
    expect(await (await stripeEventsCollection()).findOne({ _id: event.id })).toMatchObject({ outcome: "refunded" });
  });

  it("już zwrócone w Stripe (charge_already_refunded) → 200, wpis bez refundId", async () => {
    const id = await reserve();
    await setExpiresAt(id, new Date(Date.now() - 60_000));
    refundsCreate.mockRejectedValueOnce(Object.assign(new Error("already"), { code: "charge_already_refunded" }));

    expect((await postEvent(stripeEvent(paidSession(id)))).status).toBe(200);
    expect((await findReservation(id))?.payment?.refunds?.[0]).toMatchObject({ refundId: null, reason: "late" });
  });

  it("sesja bez payment_intent → wpis bez refundId, bez wołania Stripe, błąd w logach", async () => {
    const id = await reserve();
    await setExpiresAt(id, new Date(Date.now() - 60_000));
    expect((await postEvent(stripeEvent(paidSession(id, { payment_intent: null })))).status).toBe(200);
    expect(refundsCreate).not.toHaveBeenCalled();
    expect((await findReservation(id))?.payment?.refunds?.[0]).toMatchObject({ refundId: null });
    expect(consoleError).toHaveBeenCalled();
  });

  it("awaria bazy → 500 bez szczegółów", async () => {
    const id = await reserve();
    const event = stripeEvent(paidSession(id));
    const uri = process.env.MONGODB_URI;
    await closeDb();
    process.env.MONGODB_URI = "zepsuty-uri://haslo@nie-ma-takiego-hosta";
    try {
      const res = await postEvent(event);
      expectError(res, 500, "INTERNAL_ERROR");
      expect(res.text).not.toContain("haslo");
    } finally {
      process.env.MONGODB_URI = uri;
      await closeDb();
    }
    // Po naprawie ponowienie Stripe kończy sprawę.
    expect((await postEvent(event)).status).toBe(200);
    expect((await findReservation(id))?.status).toBe("paid");
  });
});

describe("Z31: GET rezerwacji synchronizuje sesję ze Stripe", () => {
  async function reserveWithSession(seatId?: string): Promise<string> {
    const id = await reserve(seatId);
    await saveCheckoutSession(id, { sessionId: `cs_test_${id}`, url: "https://checkout.stripe.com/c/pay/x", pointsUsed: 0, cardAmount: 8900 });
    return id;
  }

  it("held z sesją opłaconą w Stripe → paid po samym GET, z krótkim limitem czasu i bez ponowień", async () => {
    const id = await reserveWithSession();
    sessionsRetrieve.mockResolvedValue(paidSession(id));

    const res = await apiGetReservation(id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "paid", code: expect.stringMatching(TICKET_CODE_REGEX) });
    expect(sessionsRetrieve).toHaveBeenCalledWith(`cs_test_${id}`, {}, { timeout: 3_000, maxNetworkRetries: 0 });
    expect(await findReservation(id)).toMatchObject({ status: "paid", active: true });
    expect(res.text).not.toContain("email");
  });

  it("webhook po synchronizacji → ten sam kod, bez zwrotu", async () => {
    const id = await reserveWithSession();
    sessionsRetrieve.mockResolvedValue(paidSession(id));
    const code = ((await apiGetReservation(id)).body as { code: string }).code;

    expect((await postEvent(stripeEvent(paidSession(id)))).status).toBe(200);
    expect((await findReservation(id))?.code).toBe(code);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("sesja nieopłacona → held, bez kodu", async () => {
    const id = await reserveWithSession();
    sessionsRetrieve.mockResolvedValue(paidSession(id, { payment_status: "unpaid" }));
    const res = await apiGetReservation(id);
    expect(res.body).toMatchObject({ status: "held" });
    expect(res.body).not.toHaveProperty("code");
  });

  it("Stripe rzuca → stan z bazy, bez 500", async () => {
    const id = await reserveWithSession();
    sessionsRetrieve.mockRejectedValue(new Error("Stripe API down"));
    const res = await apiGetReservation(id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "held" });
    expect(consoleError).toHaveBeenCalled();
  });

  it("brak klucza Stripe (getStripe rzuca) → stan z bazy, bez 500", async () => {
    const id = await reserveWithSession();
    vi.mocked(getStripe).mockImplementation(() => {
      throw new PaymentUnavailableError();
    });
    const res = await apiGetReservation(id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "held" });
  });

  it("nigdy nie robi zwrotów: zła kwota w sesji → held, refunds nietknięte", async () => {
    const id = await reserveWithSession();
    sessionsRetrieve.mockResolvedValue(paidSession(id, { amount_total: 100 }));
    expect((await apiGetReservation(id)).body).toMatchObject({ status: "held" });
    expect(refundsCreate).not.toHaveBeenCalled();
    expect((await findReservation(id))?.payment?.refunds).toBeUndefined();
  });

  it("sesja innej rezerwacji → nie przyjmuje", async () => {
    const id = await reserveWithSession();
    sessionsRetrieve.mockResolvedValue(paidSession("0123456789abcdef01234567"));
    expect((await apiGetReservation(id)).body).toMatchObject({ status: "held" });
  });

  it("nie pyta Stripe, gdy nie ma o co: bez sesji, po wygaśnięciu, już opłacona", async () => {
    const noSession = await reserve();
    await apiGetReservation(noSession);

    const expired = await reserveWithSession();
    await setExpiresAt(expired, new Date(Date.now() - 1_000));
    expect((await apiGetReservation(expired)).body).toMatchObject({ status: "expired" });

    const paid = await reserveWithSession();
    await postEvent(stripeEvent(paidSession(paid)));
    expect((await apiGetReservation(paid)).body).toMatchObject({ status: "paid" });

    expect(sessionsRetrieve).not.toHaveBeenCalled();
  });

  it("wygasła z sesją opłaconą w Stripe: GET nie wydaje biletu, zwrot robi dopiero webhook", async () => {
    const id = await reserveWithSession();
    await setExpiresAt(id, new Date(Date.now() - 60_000));
    sessionsRetrieve.mockResolvedValue(paidSession(id));

    expect((await apiGetReservation(id)).body).toMatchObject({ status: "expired" });
    expect(refundsCreate).not.toHaveBeenCalled();
    await postEvent(stripeEvent(paidSession(id)));
    expect(refundsCreate).toHaveBeenCalledTimes(1);
  });
});

describe("Z30: bilet tylko po płatności", () => {
  it("D5: /purchase na held → 402, a bilet pojawia się dopiero po webhooku", async () => {
    const id = await reserve();
    const before = await apiPurchase(id);
    expect(before.status).toBe(402);
    expect(before.body).toMatchObject({ error: "PAYMENT_REQUIRED" });
    expect(await findReservation(id)).toMatchObject({ status: "held", code: null });

    await postEvent(stripeEvent(paidSession(id)));
    expect((await apiPurchase(id)).status).toBe(200);
  });
});
