// Rezerwacja, zakup i wygasanie miejsc — CONTRACT.md §2, §3, §7. Właściciel: Eryk.
// Funkcje zwracają { ok: false, error } dla błędów biznesowych; wyjątek = błąd infrastruktury (→ 500).
import { randomBytes } from "node:crypto";
import { MongoServerError, ObjectId, type Collection } from "mongodb";
import { getReservationTtlSeconds } from "@/lib/config";
import { getDb, RESERVATIONS_COLLECTION } from "@/lib/db";
import { getEvent, hasDeparted } from "@/lib/events";
import { isReservationId, normalizeTicketCode } from "@/lib/validation";
import type {
  CreateReservationBody,
  ErrorCode,
  Reservation,
  ReservationResponse,
  TicketResponse,
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
} as const satisfies Partial<Record<ErrorCode, { status: number; message: string }>>;

export type CreateReservationResult =
  | { ok: true; reservationId: string; expiresAt: Date }
  | { ok: false; error: "EVENT_NOT_FOUND" | "INVALID_SEAT" | "EVENT_DEPARTED" | "SEAT_TAKEN" };

export type PurchaseResult =
  | { ok: true; code: string }
  | { ok: false; error: "RESERVATION_NOT_FOUND" | "RESERVATION_EXPIRED" };

/** Alfabet kodu: 32 znaki bez 0, 1, I, O (CONTRACT.md §2). */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Ile razy losujemy nowy kod przy kolizji unikalnego indeksu (32^8 kombinacji — praktycznie nigdy). */
const MAX_CODE_ATTEMPTS = 5;

async function reservationsCollection(): Promise<Collection<Reservation>> {
  return (await getDb()).collection<Reservation>(RESERVATIONS_COLLECTION);
}

function isDuplicateKeyError(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

/**
 * Kod biletu XXXX-XXXX z crypto.randomBytes (Z10). 256 % 32 == 0, więc byte & 31
 * daje równy rozkład — bez modulo bias.
 */
export function generateCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < bytes.length; i++) {
    if (i === 4) code += "-";
    code += CODE_ALPHABET[bytes[i] & 31];
  }
  return code;
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
    $or: [{ status: "purchased" }, { expiresAt: { $gt: new Date() } }],
  });
  return seats.sort();
}

/**
 * Rezerwacja miejsca. Input po validateReservationBody (stringi, trim, limity).
 * Przed podwójną rezerwacją chroni unikalny indeks — przy 50 równoległych żądaniach
 * dokładnie jeden insert przechodzi, reszta dostaje E11000 → SEAT_TAKEN (Z1).
 */
export async function createReservation(input: CreateReservationBody): Promise<CreateReservationResult> {
  const { eventId, seatId, customerName, email } = input;

  const event = await getEvent(eventId);
  if (!event) return { ok: false, error: "EVENT_NOT_FOUND" };
  if (!event.seats.includes(seatId)) return { ok: false, error: "INVALID_SEAT" };
  if (hasDeparted(event)) return { ok: false, error: "EVENT_DEPARTED" };

  const reservations = await reservationsCollection();
  await releaseExpired(event._id, seatId);

  // Druga próba tylko wtedy, gdy blokująca rezerwacja wygasła między releaseExpired a insertem.
  for (let attempt = 0; attempt < 2; attempt++) {
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + getReservationTtlSeconds() * 1000);
    const doc: Reservation = {
      _id: new ObjectId(),
      eventId: event._id,
      seatId,
      customerName,
      email,
      code: null,
      status: "held",
      active: true,
      createdAt,
      expiresAt,
    };
    try {
      await reservations.insertOne(doc);
      return { ok: true, reservationId: doc._id.toHexString(), expiresAt };
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      if (attempt > 0 || (await releaseExpired(event._id, seatId)) === 0) break;
    }
  }
  return { ok: false, error: "SEAT_TAKEN" };
}

/**
 * Zakup rezerwacji — atomowy findOneAndUpdate z warunkiem expiresAt > teraz (Z3).
 * Ponowny lub równoległy zakup tej samej rezerwacji → ten sam kod (Z4). Body nie jest czytane.
 */
export async function purchaseReservation(id: string): Promise<PurchaseResult> {
  if (!isReservationId(id)) return { ok: false, error: "RESERVATION_NOT_FOUND" };
  const _id = new ObjectId(id);
  const reservations = await reservationsCollection();
  const now = new Date();

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    try {
      const purchased = await reservations.findOneAndUpdate(
        { _id, status: "held", active: true, expiresAt: { $gt: now } },
        { $set: { status: "purchased", code: generateCode(), purchasedAt: now } },
        { returnDocument: "after", projection: { code: 1 } },
      );
      if (purchased?.code) return { ok: true, code: purchased.code };
      break;
    } catch (err) {
      // Kolizja kodu z unikalnym indeksem — losujemy nowy.
      if (!isDuplicateKeyError(err) || attempt === MAX_CODE_ATTEMPTS - 1) throw err;
    }
  }

  // Nie trafiło: rezerwacji nie ma, jest już kupiona albo wygasła. Najpierw oznaczamy wygasłą
  // (warunkowo — mogła zostać kupiona w międzyczasie), potem czytamy stan końcowy, żeby dwa
  // równoległe żądania nigdy nie dostały sprzecznych odpowiedzi.
  await reservations.updateOne(
    { _id, status: "held", active: true, expiresAt: { $lte: now } },
    { $set: { status: "expired", active: false } },
  );
  const current = await reservations.findOne({ _id }, { projection: { status: 1, code: 1 } });
  if (!current) return { ok: false, error: "RESERVATION_NOT_FOUND" };
  if (current.status === "purchased" && current.code) return { ok: true, code: current.code };
  return { ok: false, error: "RESERVATION_EXPIRED" };
}

/** GET /api/reservations/:id — bez e-maila (Z11), status wyliczony względem teraz. */
export async function getReservation(id: string): Promise<ReservationResponse | null> {
  if (!isReservationId(id)) return null;
  const reservations = await reservationsCollection();
  const doc = await reservations.findOne({ _id: new ObjectId(id) }, { projection: { email: 0 } });
  if (!doc) return null;
  const event = await getEvent(doc.eventId);
  if (!event) return null;

  const now = new Date();
  const status = doc.status === "held" && doc.expiresAt <= now ? "expired" : doc.status;
  // Jawna lista pól — nic z dokumentu nie wycieka przypadkiem.
  return {
    reservationId: doc._id.toHexString(),
    eventId: doc.eventId,
    seatId: doc.seatId,
    customerName: doc.customerName,
    status,
    expiresAt: doc.expiresAt.toISOString(),
    serverNow: now.toISOString(),
    ...(status === "purchased" && doc.code ? { code: doc.code } : {}),
    event,
  };
}

/** GET /api/tickets/:code — tylko kupione bilety; pokazuje imię, bez e-maila (Z11). */
export async function getTicketByCode(code: string): Promise<TicketResponse | null> {
  const normalized = normalizeTicketCode(code);
  if (!normalized) return null;
  const reservations = await reservationsCollection();
  const doc = await reservations.findOne(
    { code: normalized, status: "purchased" },
    { projection: { email: 0 } },
  );
  if (!doc?.code) return null;
  const event = await getEvent(doc.eventId);
  if (!event) return null;

  return {
    code: doc.code,
    seatId: doc.seatId,
    customerName: doc.customerName,
    purchasedAt: (doc.purchasedAt ?? doc.createdAt).toISOString(),
    event,
  };
}
