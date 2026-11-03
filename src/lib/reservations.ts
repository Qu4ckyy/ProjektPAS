// Rezerwacja i wygasanie miejsc — CONTRACT.md §2, §3, §7. Właściciel: Eryk. Płatność: src/lib/payments.ts.
// Funkcje zwracają { ok: false, error } dla błędów biznesowych; wyjątek = błąd infrastruktury (→ 500).
import { ObjectId, type Collection } from "mongodb";
import { getReservationTtlSeconds } from "@/lib/config";
import { getDb, isDuplicateKeyError, RESERVATIONS_COLLECTION } from "@/lib/db";
import { getEvent, hasDeparted } from "@/lib/events";
import { syncCheckoutSession } from "@/lib/payments";
import { isReservationId, normalizeTicketCode } from "@/lib/validation";
import type {
  CreateReservationBody,
  ErrorCode,
  Reservation,
  ReservationResponse,
  TicketResponse,
  TrainEvent,
} from "@/lib/types";

/** Status HTTP i komunikat dla każdego błędu biznesowego (CONTRACT.md §3, §4). */
export const RESERVATION_ERRORS = {
  EVENT_NOT_FOUND: { status: 404, message: "Nie ma takiego kursu." },
  INVALID_SEAT: { status: 400, message: "W tym pociągu nie ma takiego miejsca." },
  EVENT_DEPARTED: { status: 409, message: "Ten pociąg już odjechał — nie można zarezerwować miejsca." },
  SEAT_TAKEN: { status: 409, message: "To miejsce jest już zajęte." },
  RESERVATION_NOT_FOUND: { status: 404, message: "Nie znaleziono rezerwacji." },
  RESERVATION_EXPIRED: { status: 410, message: "Rezerwacja wygasła, miejsce wróciło do puli." },
  TICKET_NOT_FOUND: { status: 404, message: "Nie znaleziono biletu." },
  ALREADY_PAID: { status: 409, message: "Ta rezerwacja jest już opłacona." },
  PAYMENT_REQUIRED: { status: 402, message: "Bilet trzeba najpierw opłacić." },
} as const satisfies Partial<Record<ErrorCode, { status: number; message: string }>>;

export type CreateReservationResult =
  /** replay: identyczne żądanie trafiło w istniejącą rezerwację tej samej osoby (D6) → 200 zamiast 201. */
  | { ok: true; replay: boolean; reservationId: string; expiresAt: Date; amount: number }
  | { ok: false; error: "EVENT_NOT_FOUND" | "INVALID_SEAT" | "EVENT_DEPARTED" | "SEAT_TAKEN" };

/** Insert → blokada → ponowny insert: blokująca rezerwacja może wygasnąć tuż przed nami. */
const MAX_INSERT_ATTEMPTS = 3;

async function reservationsCollection(): Promise<Collection<Reservation>> {
  return (await getDb()).collection<Reservation>(RESERVATIONS_COLLECTION);
}

/**
 * Wygasłe rezerwacje (held, expiresAt <= teraz) → status "expired", active false — zwalnia
 * unikalny indeks, więc miejsce da się zarezerwować ponownie (Z2). Kupionych nie rusza (Z5).
 * Zwraca liczbę zwolnionych rezerwacji.
 */
export async function releaseExpired(eventId: string, seatId?: string): Promise<number> {
  const reservations = await reservationsCollection();
  const result = await reservations.updateMany(
    {
      eventId,
      ...(seatId === undefined ? {} : { seatId }),
      status: "held",
      active: true,
      expiresAt: { $lte: new Date() },
    },
    { $set: { status: "expired", active: false } },
  );
  return result.modifiedCount;
}

/**
 * Zajęte miejsca kursu: active ORAZ (kupione LUB rezerwacja jeszcze ważna) — CONTRACT.md §2.
 * Woła ją Kamil w GET /api/events/:id — sygnatura stała.
 */
export async function getTakenSeats(eventId: string): Promise<string[]> {
  if (typeof eventId !== "string") return [];
  const reservations = await reservationsCollection();
  const seats = await reservations.distinct("seatId", {
    eventId,
    active: true,
    $or: [{ status: "paid" }, { expiresAt: { $gt: new Date() } }],
  });
  return seats.sort();
}

/**
 * Rezerwacja miejsca. Input po validateReservationBody (stringi, trim, e-mail małymi literami).
 * Przed podwójną rezerwacją chroni unikalny indeks: przy równoległych żądaniach dokładnie jeden
 * insert przechodzi, reszta dostaje E11000 (Z1) i sprawdza, czyja jest blokująca rezerwacja:
 * tej samej osoby → ta sama rezerwacja (D6, Z22), kogoś innego → SEAT_TAKEN.
 */
export async function createReservation(input: CreateReservationBody): Promise<CreateReservationResult> {
  const { eventId, seatId, customerName, email } = input;

  const event = await getEvent(eventId);
  if (!event) return { ok: false, error: "EVENT_NOT_FOUND" };
  if (!event.seats.includes(seatId)) return { ok: false, error: "INVALID_SEAT" };
  if (hasDeparted(event)) return { ok: false, error: "EVENT_DEPARTED" };

  const reservations = await reservationsCollection();
  await releaseExpired(event._id, seatId);

  for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt++) {
    const createdAt = new Date();
    // Nie dłużej niż do odjazdu (CONTRACT.md §2, Z21) — po odjeździe płatność daje zwrot.
    const expiresAt = new Date(
      Math.min(createdAt.getTime() + getReservationTtlSeconds() * 1000, new Date(event.startsAt).getTime()),
    );
    const doc: Reservation = {
      _id: new ObjectId(),
      eventId: event._id,
      seatId,
      customerName,
      email,
      amount: event.price,
      code: null,
      status: "held",
      active: true,
      createdAt,
      expiresAt,
    };
    try {
      await reservations.insertOne(doc);
      return { ok: true, replay: false, reservationId: doc._id.toHexString(), expiresAt, amount: doc.amount };
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }

    const holder = await reservations.findOne({ eventId: event._id, seatId, active: true });
    if (!holder) continue; // Zwolniona między insertem a odczytem.
    if (holder.status !== "paid" && holder.expiresAt <= new Date()) {
      await releaseExpired(event._id, seatId);
      continue;
    }
    if (holder.customerName === customerName && holder.email.toLowerCase() === email.toLowerCase()) {
      return {
        ok: true,
        replay: true,
        reservationId: holder._id.toHexString(),
        expiresAt: holder.expiresAt,
        amount: holder.amount,
      };
    }
    return { ok: false, error: "SEAT_TAKEN" };
  }
  return { ok: false, error: "SEAT_TAKEN" };
}

/**
 * GET /api/reservations/:id — bez e-maila (Z11), status wyliczony względem teraz. Gdy rezerwacja
 * czeka na płatność, pyta Stripe o sesję — strona powrotu nie czeka na spóźniony webhook (Z31).
 */
export async function getReservation(id: string): Promise<ReservationResponse | null> {
  if (!isReservationId(id)) return null;
  const reservations = await reservationsCollection();
  const _id = new ObjectId(id);
  let doc = await reservations.findOne({ _id }, { projection: { email: 0 } });
  if (!doc) return null;
  const event = await getEvent(doc.eventId);
  if (!event) return null;

  if (doc.status === "held" && doc.payment?.sessionId && doc.expiresAt > new Date()) {
    if (await syncCheckoutSession(id, doc.payment.sessionId)) {
      doc = (await reservations.findOne({ _id }, { projection: { email: 0 } })) ?? doc;
    }
  }

  const now = new Date();
  const status = doc.status === "held" && doc.expiresAt <= now ? "expired" : doc.status;
  // Jawna lista pól — nic z dokumentu nie wycieka przypadkiem.
  return {
    reservationId: doc._id.toHexString(),
    eventId: doc.eventId,
    seatId: doc.seatId,
    customerName: doc.customerName,
    status,
    amount: doc.amount ?? event.price,
    expiresAt: doc.expiresAt.toISOString(),
    serverNow: now.toISOString(),
    ...(status === "paid" && doc.code ? { code: doc.code } : {}),
    event,
  };
}

/** GET /api/tickets/:code — tylko opłacone bilety; pokazuje imię, bez e-maila (Z11). */
export async function getTicketByCode(code: string): Promise<TicketResponse | null> {
  const normalized = normalizeTicketCode(code);
  if (!normalized) return null;
  const reservations = await reservationsCollection();
  const doc = await reservations.findOne(
    { code: normalized, status: "paid" },
    { projection: { email: 0 } },
  );
  if (!doc?.code) return null;
  const event = await getEvent(doc.eventId);
  if (!event) return null;

  return {
    code: doc.code,
    seatId: doc.seatId,
    customerName: doc.customerName,
    amount: doc.amount ?? event.price,
    paidAt: (doc.paidAt ?? doc.createdAt).toISOString(),
    event,
  };
}

// --- Etap II: płatności (CONTRACT.md §3, §6) ---

export type LegacyPurchaseResult =
  | { ok: true; code: string }
  | { ok: false; error: "RESERVATION_NOT_FOUND" | "RESERVATION_EXPIRED" | "PAYMENT_REQUIRED" };

/**
 * POST /api/reservations/:id/purchase po Etapie II (D5): bilet tylko dla opłaconej rezerwacji.
 * Nie zmienia stanu — biletu bez płatności nie da się już dostać.
 */
export async function getLegacyPurchase(id: string): Promise<LegacyPurchaseResult> {
  if (!isReservationId(id)) return { ok: false, error: "RESERVATION_NOT_FOUND" };
  const reservations = await reservationsCollection();
  const doc = await reservations.findOne({ _id: new ObjectId(id) }, { projection: { status: 1, code: 1, expiresAt: 1 } });
  if (!doc) return { ok: false, error: "RESERVATION_NOT_FOUND" };
  if (doc.status === "paid" && doc.code) return { ok: true, code: doc.code };
  if (doc.status === "expired" || doc.expiresAt <= new Date()) return { ok: false, error: "RESERVATION_EXPIRED" };
  return { ok: false, error: "PAYMENT_REQUIRED" };
}

export type CheckoutCandidate =
  | { ok: true; reservation: Reservation; event: TrainEvent }
  | { ok: false; error: "RESERVATION_NOT_FOUND" | "RESERVATION_EXPIRED" | "ALREADY_PAID" };

/** Rezerwacja, którą można opłacić: held i jeszcze ważna. Pełny dokument — checkout potrzebuje e-maila i payment. */
export async function getCheckoutCandidate(id: string): Promise<CheckoutCandidate> {
  if (!isReservationId(id)) return { ok: false, error: "RESERVATION_NOT_FOUND" };
  const reservations = await reservationsCollection();
  const reservation = await reservations.findOne({ _id: new ObjectId(id) });
  if (!reservation) return { ok: false, error: "RESERVATION_NOT_FOUND" };
  if (reservation.status === "paid") return { ok: false, error: "ALREADY_PAID" };
  if (reservation.status === "expired" || reservation.expiresAt <= new Date()) {
    return { ok: false, error: "RESERVATION_EXPIRED" };
  }
  const event = await getEvent(reservation.eventId);
  if (!event) return { ok: false, error: "RESERVATION_NOT_FOUND" };
  return { ok: true, reservation, event };
}

/**
 * Zapisuje sesję Stripe atomowo i tylko raz: rezerwacja held bez sesji (§6). Przy równoległych
 * „Zapłać” wygrywa pierwszy zapis, a klucz idempotencji daje wszystkim tę samą sesję (D9).
 */
export async function saveCheckoutSession(id: string, session: { sessionId: string; url: string }): Promise<void> {
  if (!isReservationId(id)) return;
  const reservations = await reservationsCollection();
  await reservations.updateOne(
    { _id: new ObjectId(id), status: "held", "payment.sessionId": { $exists: false } },
    { $set: { payment: { sessionId: session.sessionId, url: session.url, createdAt: new Date() } } },
  );
}
