// Wspólne dane i narzędzia testów: kursy testowe w pociag_test, wywołania handlerów.
import type { Collection } from "mongodb";
import type Stripe from "stripe";
import { GET as getEventRoute } from "@/app/api/events/[id]/route";
import { GET as getReservationRoute } from "@/app/api/reservations/[id]/route";
import { POST as purchaseRoute } from "@/app/api/reservations/[id]/purchase/route";
import { POST as createRoute } from "@/app/api/reservations/route";
import { GET as getTicketRoute } from "@/app/api/tickets/[code]/route";
import { getDb, LOYALTY_MEMBERS_COLLECTION, RESERVATIONS_COLLECTION, STRIPE_EVENTS_COLLECTION } from "@/lib/db";
import { EVENTS_COLLECTION } from "@/lib/events";
import { loyaltyTiming } from "@/lib/loyalty";
import { acceptPayment } from "@/lib/payments";
import { resetMemoryLoyalty, resetVoucherifyRateLimit } from "@/lib/voucherify";
import type { Reservation, TrainEvent, Wagon } from "@/lib/types";

export const TEST_DB = "pociag_test";

// [E3] Odpytywanie o APPROVED bez czekania — provider memory zatwierdza od razu, a mocki fetch same
// decydują, ile razy odpowiedzieć PENDING. Prawdziwe czasy: loyaltyTiming w src/lib/loyalty.ts.
loyaltyTiming.approvalPollMs = [5, 5, 5];
loyaltyTiming.memberWaitStepMs = 20;

/** Krótki TTL do testów wygasania. */
export const SHORT_TTL_SECONDS = 2;

const HOUR = 60 * 60 * 1000;

/** Cena miejsca w kursach testowych (grosze). */
export const TEST_PRICE = 8900;
const WAGONS: Wagon[] = [
  { number: 1, seats: 20 },
  { number: 2, seats: 20 },
];

function testEvent(id: string, startsAt: Date): TrainEvent {
  return {
    _id: id,
    title: `TEST ${id}`,
    trainNumber: "TEST 1",
    price: TEST_PRICE,
    from: "Testowo Główne",
    to: "Próbna Wschodnia",
    startsAt: startsAt.toISOString(),
    arrivesAt: new Date(startsAt.getTime() + 2 * HOUR).toISOString(),
    wagons: WAGONS,
    seats: WAGONS.flatMap((w) => Array.from({ length: w.seats }, (_, i) => `${w.number}-${i + 1}`)),
  };
}

/** Kurs za 30 dni — na nim rezerwujemy. */
export const FUTURE_EVENT = testEvent("test-future", new Date(Date.now() + 30 * 24 * HOUR));
/** Kurs, który odjechał godzinę temu (Z9). */
export const DEPARTED_EVENT = testEvent("test-departed", new Date(Date.now() - HOUR));

export async function reservationsCollection(): Promise<Collection<Reservation>> {
  const db = await getDb();
  // Bezpiecznik: testy kasują rezerwacje — tylko w bazie testowej.
  if (db.databaseName !== TEST_DB) {
    throw new Error(`Testy muszą działać na bazie ${TEST_DB}, a nie ${db.databaseName}.`);
  }
  return db.collection<Reservation>(RESERVATIONS_COLLECTION);
}

/**
 * Wstawia kursy testowe (idempotentnie), czyści rezerwacje, log zdarzeń Stripe i konta punktowe
 * (Mongo + provider memory + blokada po 429). deleteMany, nie drop — drop usuwa indeksy.
 */
export async function resetTestData(): Promise<void> {
  const reservations = await reservationsCollection();
  const db = await getDb();
  const events = db.collection<TrainEvent>(EVENTS_COLLECTION);
  await Promise.all(
    [FUTURE_EVENT, DEPARTED_EVENT].map((event) => events.replaceOne({ _id: event._id }, event, { upsert: true })),
  );
  await reservations.deleteMany({});
  await db.collection(LOYALTY_MEMBERS_COLLECTION).deleteMany({});
  await db.collection(STRIPE_EVENTS_COLLECTION).deleteMany({});
  resetMemoryLoyalty();
  resetVoucherifyRateLimit();
}

export function setTtl(seconds: number | undefined): void {
  if (seconds === undefined) delete process.env.RESERVATION_TTL_SECONDS;
  else process.env.RESERVATION_TTL_SECONDS = String(seconds);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Czeka, aż rezerwacje z krótkim TTL na pewno wygasną. */
export function waitForExpiry(): Promise<void> {
  return sleep(SHORT_TTL_SECONDS * 1000 + 300);
}

let customerCounter = 0;

/** Poprawne body rezerwacji; nadpisz pola w overrides. */
export function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  customerCounter++;
  return {
    eventId: FUTURE_EVENT._id,
    seatId: "1-1",
    customerName: `Jan Testowy ${customerCounter}`,
    email: `jan${customerCounter}@example.com`,
    ...overrides,
  };
}

/** Opłacona sesja Stripe Checkout tej rezerwacji, tak jak przychodzi w webhooku. */
export function paidSession(
  reservationId: string,
  overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session {
  return {
    id: `cs_test_${reservationId}`,
    object: "checkout.session",
    client_reference_id: reservationId,
    metadata: { reservationId },
    amount_total: TEST_PRICE,
    currency: "pln",
    payment_status: "paid",
    payment_intent: `pi_test_${reservationId}`,
    ...overrides,
  } as Stripe.Checkout.Session;
}

/** Opłaca rezerwację z pominięciem Stripe, tą samą funkcją co webhook. Zwraca kod biletu. */
export async function payReservation(reservationId: string): Promise<string> {
  const code = await acceptPayment(paidSession(reservationId), Date.now());
  if (!code) throw new Error(`Opłacenie ${reservationId} nie powiodło się.`);
  return code;
}

// --- Wywołania handlerów jak z sieci ---

export type ApiResult = { status: number; body: unknown; text: string; headers: Headers };

async function toResult(res: Response): Promise<ApiResult> {
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, body, text, headers: res.headers };
}

const BASE = "http://localhost:3000";

/** POST /api/reservations. Obiekt → JSON; string / Uint8Array → wysłane dosłownie. */
export async function apiCreate(body: unknown, init: RequestInit = {}): Promise<ApiResult> {
  const raw: BodyInit | undefined =
    typeof body === "string" ? body : body instanceof Uint8Array ? new Uint8Array(body) : JSON.stringify(body);
  return toResult(await createRoute(new Request(`${BASE}/api/reservations`, { method: "POST", body: raw, ...init })));
}

export async function apiPurchase(id: string, body?: string): Promise<ApiResult> {
  const req = new Request(`${BASE}/api/reservations/x/purchase`, { method: "POST", body });
  return toResult(await purchaseRoute(req, { params: Promise.resolve({ id }) }));
}

export async function apiGetReservation(id: string): Promise<ApiResult> {
  return toResult(await getReservationRoute(new Request(`${BASE}/api/reservations/x`), { params: Promise.resolve({ id }) }));
}

export async function apiGetTicket(code: string): Promise<ApiResult> {
  return toResult(await getTicketRoute(new Request(`${BASE}/api/tickets/x`), { params: Promise.resolve({ code }) }));
}

/** GET /api/events/:id (Kamil) — sprawdzamy, że takenSeats widzi nasze rezerwacje. */
export async function apiGetEvent(id: string): Promise<ApiResult> {
  return toResult(await getEventRoute(new Request(`${BASE}/api/events/x`), { params: Promise.resolve({ id }) }));
}
