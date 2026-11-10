// Checkout (karta A, Kamil) — CONTRACT.md §3, D9, D10, Z3, Z4, Z26, Z29, Z33, Z34. Stripe zmockowany.
import { ObjectId } from "mongodb";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as checkoutRoute } from "@/app/api/reservations/[id]/checkout/route";
import { buildSessionParams, createCheckout } from "@/lib/checkout";
import { closeDb, getDb } from "@/lib/db";
import { EVENTS_COLLECTION } from "@/lib/events";
import { createReservation } from "@/lib/reservations";
import { getStripe, PaymentUnavailableError } from "@/lib/stripe";
import type { TrainEvent } from "@/lib/types";
import { FUTURE_EVENT, reservationsCollection, resetTestData, TEST_PRICE } from "./helpers";

// Testy nigdy nie wołają prawdziwego Stripe — getStripe zwraca atrapę z create().
vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  return { ...actual, getStripe: vi.fn() };
});

const APP_URL = "https://konduktor.example";
const LEAK = /\bat .+\(|Error:|Mongo|Stripe|node_modules|\/src\/|\.ts:\d|sk_test/;

type CreateFn = (
  params: Stripe.Checkout.SessionCreateParams,
  options?: Stripe.RequestOptions,
) => Promise<Pick<Stripe.Checkout.Session, "id" | "url">>;

/**
 * Atrapa sessions.create zachowująca się jak Stripe przy idempotencji: ten sam klucz → ta sama sesja.
 * Opóźnienie, żeby równoległe żądania naprawdę się nakładały.
 */
function fakeStripe() {
  const sessions = new Map<string, { id: string; url: string }>();
  let counter = 0;
  const create = vi.fn<CreateFn>(async (_params, options) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const key = options?.idempotencyKey ?? `no-key-${counter}`;
    let session = sessions.get(key);
    if (!session) {
      counter++;
      const id = `cs_test_${counter}`;
      session = { id, url: `https://checkout.stripe.com/c/pay/${id}` };
      sessions.set(key, session);
    }
    return session;
  });
  vi.mocked(getStripe).mockReturnValue({ checkout: { sessions: { create } } } as unknown as Stripe);
  return create;
}

let ipCounter = 0;

async function apiCheckout(id: string, init: RequestInit = {}) {
  ipCounter++;
  const headers = new Headers(init.headers);
  if (!headers.has("x-real-ip")) headers.set("x-real-ip", `198.51.100.${ipCounter}`);
  const res = await checkoutRoute(
    new Request(`http://localhost:3000/api/reservations/${id}/checkout`, { method: "POST", ...init, headers }),
    { params: Promise.resolve({ id }) },
  );
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text, headers: res.headers };
}

let seatCounter = 0;
async function reserve(): Promise<string> {
  seatCounter = (seatCounter % 40) + 1;
  const seatId = `${seatCounter <= 20 ? 1 : 2}-${((seatCounter - 1) % 20) + 1}`;
  const result = await createReservation({
    eventId: FUTURE_EVENT._id,
    seatId,
    customerName: "Anna Płacąca",
    email: "anna@example.com",
  });
  if (!result.ok) throw new Error(`Rezerwacja ${seatId} nie powiodła się: ${result.error}`);
  return result.reservationId;
}

async function findReservation(id: string) {
  return (await reservationsCollection()).findOne({ _id: new ObjectId(id) });
}

beforeAll(resetTestData);
beforeEach(async () => {
  process.env.APP_URL = APP_URL;
  process.env.RATE_LIMIT_MAX = "1000";
  process.env.RESERVATION_TTL_SECONDS = "120";
  vi.mocked(getStripe).mockReset();
  await (await reservationsCollection()).deleteMany({});
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  delete process.env.APP_URL;
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.RESERVATION_TTL_SECONDS;
  await closeDb();
});

describe("POST /api/reservations/:id/checkout", () => {
  it("200 { url } — sesja Stripe z kwotą z bazy, opisem po polsku i adresami z APP_URL", async () => {
    const create = fakeStripe();
    const id = await reserve();

    const res = await apiCheckout(id);

    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_1", pointsUsed: 0, cardAmount: TEST_PRICE });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(create).toHaveBeenCalledTimes(1);
    const [params, options] = create.mock.calls[0];
    expect(options).toEqual({ idempotencyKey: `checkout-${id}` });
    expect(params).toEqual({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "pln",
            unit_amount: TEST_PRICE,
            product_data: { name: FUTURE_EVENT.title, description: expect.stringMatching(/^Wagon \d, miejsce \d+ · .+, odjazd \d\d:\d\d$/) },
          },
        },
      ],
      client_reference_id: id,
      metadata: { reservationId: id, eventId: FUTURE_EVENT._id, seatId: expect.any(String), pointsUsed: "0" },
      customer_email: "anna@example.com",
      locale: "pl",
      success_url: `${APP_URL}/payment/success?reservationId=${id}`,
      cancel_url: `${APP_URL}/payment/cancel?reservationId=${id}`,
    });

    // Sesja zapisana w rezerwacji (Eryk: saveCheckoutSession).
    const doc = await findReservation(id);
    expect(doc?.status).toBe("held");
    expect(doc?.payment).toMatchObject({ sessionId: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  });

  it("opis: „Wagon 2, miejsce 14 · <dzień>, odjazd <godzina>” dla kursu IC 1500", () => {
    const event: TrainEvent = {
      ...FUTURE_EVENT,
      _id: "ic-1500-2026-12-04",
      title: "IC 1500 Warszawa Centralna → Kraków Główny",
      startsAt: "2026-12-04T07:15:00.000Z",
    };
    const reservation = {
      _id: new ObjectId(),
      eventId: event._id,
      seatId: "2-14",
      customerName: "Anna",
      email: "anna@example.com",
      amount: 8900,
      code: null,
      status: "held" as const,
      active: true,
      createdAt: new Date(),
      expiresAt: new Date(),
    };
    const params = buildSessionParams(reservation, event, APP_URL);
    expect(params.line_items?.[0].price_data?.product_data).toEqual({
      name: "IC 1500 Warszawa Centralna → Kraków Główny",
      description: "Wagon 2, miejsce 14 · pt., 4 grudnia 2026, odjazd 08:15",
    });
    // Deterministyczne: te same dane → te same parametry, bez expires_at (ten sam idempotency key).
    expect(buildSessionParams(reservation, event, APP_URL)).toEqual(params);
    expect(params).not.toHaveProperty("expires_at");
  });

  it("drugie „Zapłać” → ten sam url bez drugiego wywołania Stripe (D9)", async () => {
    const create = fakeStripe();
    const id = await reserve();

    const first = await apiCheckout(id);
    const second = await apiCheckout(id);

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("10 równoległych „Zapłać” → jeden url i jedna sesja w bazie (Z4, Z26)", async () => {
    const create = fakeStripe();
    const id = await reserve();

    const results = await Promise.all(Array.from({ length: 10 }, () => apiCheckout(id)));

    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(new Set(results.map((r) => r.body.url)).size).toBe(1);
    // Każde wywołanie Stripe z tym samym kluczem — Stripe oddaje jedną sesję.
    for (const [, options] of create.mock.calls) expect(options).toEqual({ idempotencyKey: `checkout-${id}` });
    const doc = await findReservation(id);
    expect(doc?.payment?.url).toBe(results[0].body.url);
  });

  it("kwota zawsze z rezerwacji: body z inną kwotą ignorowane, zmiana ceny kursu nie zmienia amount (Z29)", async () => {
    const create = fakeStripe();
    const id = await reserve();
    const events = (await getDb()).collection<TrainEvent>(EVENTS_COLLECTION);
    await events.updateOne({ _id: FUTURE_EVENT._id }, { $set: { price: 1 } });
    try {
      const res = await apiCheckout(id, {
        body: JSON.stringify({ amount: 1, unit_amount: 1, currency: "usd" }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      const [params] = create.mock.calls[0];
      expect(params.line_items?.[0].price_data).toMatchObject({ currency: "pln", unit_amount: TEST_PRICE });
    } finally {
      await events.updateOne({ _id: FUTURE_EVENT._id }, { $set: { price: FUTURE_EVENT.price } });
    }
  });

  it("adresy powrotu z APP_URL, nigdy z nagłówka Host / X-Forwarded-Host (Z33)", async () => {
    const create = fakeStripe();
    process.env.APP_URL = `${APP_URL}/`;
    const id = await reserve();

    await apiCheckout(id, { headers: { host: "evil.example", "x-forwarded-host": "evil.example" } });

    const [params] = create.mock.calls[0];
    expect(params.success_url).toBe(`${APP_URL}/payment/success?reservationId=${id}`);
    expect(params.cancel_url).toBe(`${APP_URL}/payment/cancel?reservationId=${id}`);
  });

  it("wygasła rezerwacja → 410, Stripe niewołany (Z3)", async () => {
    const create = fakeStripe();
    const id = await reserve();
    await (await reservationsCollection()).updateOne(
      { _id: new ObjectId(id) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const res = await apiCheckout(id);

    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: "RESERVATION_EXPIRED", message: expect.any(String) });
    expect(create).not.toHaveBeenCalled();
  });

  it("opłacona rezerwacja → 409 ALREADY_PAID, Stripe niewołany", async () => {
    const create = fakeStripe();
    const id = await reserve();
    await (await reservationsCollection()).updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "paid", code: "ABCD-EFGH", paidAt: new Date() } },
    );

    const res = await apiCheckout(id);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "ALREADY_PAID", message: expect.any(String) });
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["abc", "%7B%7D", "ffffffffffffffffffffffff", "A".repeat(5000), "507F1F77BCF86CD799439011"])(
    "zły / nieistniejący id %j → 404 RESERVATION_NOT_FOUND",
    async (id) => {
      const create = fakeStripe();
      const res = await apiCheckout(id);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "RESERVATION_NOT_FOUND", message: expect.any(String) });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("błąd Stripe → 503 PAYMENT_UNAVAILABLE bez szczegółów, rezerwacja bez payment; ponowienie działa (Z34)", async () => {
    const create = fakeStripe();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    create.mockRejectedValueOnce(Object.assign(new Error("StripeConnectionError: socket hang up sk_test_xyz"), { type: "StripeConnectionError" }));
    const id = await reserve();

    const res = await apiCheckout(id);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "PAYMENT_UNAVAILABLE", message: expect.any(String) });
    expect(res.text).not.toMatch(LEAK);
    expect(errorLog).toHaveBeenCalled();
    const doc = await findReservation(id);
    expect(doc?.status).toBe("held");
    expect(doc?.active).toBe(true);
    expect(doc?.payment).toBeUndefined();

    // „Zapłać” można ponowić.
    const retry = await apiCheckout(id);
    expect(retry.status).toBe(200);
    expect(retry.body.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  });

  it("brak / zły klucz (PaymentUnavailableError) → 503 (D11, Z32)", async () => {
    vi.mocked(getStripe).mockImplementation(() => {
      throw new PaymentUnavailableError("STRIPE_SECRET_KEY nie jest kluczem testowym (sk_test_) — płatności wyłączone.");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await reserve();

    const res = await apiCheckout(id);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "PAYMENT_UNAVAILABLE", message: expect.any(String) });
    expect(res.text).not.toMatch(LEAK);
    expect((await findReservation(id))?.payment).toBeUndefined();
  });

  it.each([undefined, "", "   ", "javascript:alert(1)", "nie-adres"])("APP_URL = %j → 503 i log, Stripe niewołany (D10)", async (value) => {
    const create = fakeStripe();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    if (value === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = value;
    const id = await reserve();

    const res = await apiCheckout(id);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "PAYMENT_UNAVAILABLE", message: expect.any(String) });
    expect(create).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalled();
  });

  it("Stripe zawodzi, ale równoległe żądanie zdążyło zapisać sesję → ten sam url zamiast 503", async () => {
    const create = fakeStripe();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await reserve();
    const winner = await createCheckout(id);
    expect(winner.ok).toBe(true);

    // Symulacja: drugie żądanie przeczytało rezerwację przed zapisem sesji, a Stripe odrzucił je 409.
    const reservations = await reservationsCollection();
    await reservations.updateOne({ _id: new ObjectId(id) }, { $unset: { payment: "" } });
    create.mockImplementationOnce(async () => {
      await reservations.updateOne(
        { _id: new ObjectId(id) },
        { $set: { payment: { sessionId: "cs_test_1", url: (winner as { url: string }).url, createdAt: new Date() } } },
      );
      throw new Error("idempotency conflict");
    });

    expect(await createCheckout(id)).toEqual(winner);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
