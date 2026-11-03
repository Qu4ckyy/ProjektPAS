// Typy wspólne dla wszystkich kart — CONTRACT.md §2, §3, §4.
import type { ObjectId } from "mongodb";

export type Wagon = { number: number; seats: number };

export type TrainEvent = {
  _id: string;
  title: string;
  startsAt: string; // ISO 8601 UTC (odjazd)
  seats: string[];
  trainNumber: string;
  from: string;
  to: string;
  arrivesAt: string; // ISO 8601 UTC (przyjazd)
  wagons: Wagon[];
};

export type ReservationStatus = "held" | "paid" | "expired";

export type Reservation = {
  _id: ObjectId;
  eventId: string;
  seatId: string;
  customerName: string;
  email: string;
  code: string | null;
  status: ReservationStatus;
  active: boolean;
  createdAt: Date;
  expiresAt: Date;
  paidAt?: Date;
};

// --- Body i odpowiedzi API (§3) ---

export type CreateReservationBody = {
  eventId: string;
  seatId: string;
  customerName: string;
  email: string;
};

export type EventDetailsResponse = { event: TrainEvent; takenSeats: string[] };

export type CreateReservationResponse = { reservationId: string; expiresAt: string };

export type PurchaseResponse = { code: string };

export type ReservationResponse = {
  reservationId: string;
  eventId: string;
  seatId: string;
  customerName: string;
  status: ReservationStatus;
  expiresAt: string;
  serverNow: string;
  code?: string;
  event: TrainEvent;
};

export type TicketResponse = {
  code: string;
  seatId: string;
  customerName: string;
  paidAt: string;
  event: TrainEvent;
};

// --- Formaty identyfikatorów (§2, §3) ---

/** reservationId: 24 znaki hex, małe litery (jak zwraca API). Nie używaj samego ObjectId.isValid. */
export const RESERVATION_ID_REGEX = /^[0-9a-f]{24}$/;

/** Kod biletu XXXX-XXXX z alfabetu bez 0, 1, I, O. */
export const TICKET_CODE_REGEX = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

// --- Błędy (§4) ---

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_SEAT"
  | "EVENT_NOT_FOUND"
  | "EVENT_DEPARTED"
  | "SEAT_TAKEN"
  | "RESERVATION_NOT_FOUND"
  | "RESERVATION_EXPIRED"
  | "TICKET_NOT_FOUND"
  | "INTERNAL_ERROR";

export type ApiError = { error: ErrorCode; message: string };
