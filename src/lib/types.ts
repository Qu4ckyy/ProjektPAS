// Typy wspólne dla wszystkich kart — CONTRACT.md §2, §3, §4.
import type { ObjectId } from "mongodb";

export type Wagon = { number: number; seats: number };

export type TrainEvent = {
  _id: string;
  title: string;
  startsAt: string; // ISO 8601 UTC (odjazd)
  seats: string[];
  price: number; // cena miejsca w groszach (np. 8900 = 89,00 zł)
  trainNumber: string;
  from: string;
  to: string;
  arrivesAt: string; // ISO 8601 UTC (przyjazd)
  wagons: Wagon[];
};

export type ReservationStatus = "held" | "paid" | "expired";

export type RefundReason = "late" | "duplicate" | "amount_mismatch" | "not_held";

export type ReservationPayment = {
  sessionId: string; // Stripe Checkout Session, "cs_test_..."
  url: string;
  createdAt: Date;
  paymentIntentId?: string;
  refunds?: { sessionId: string; refundId: string | null; reason: RefundReason; at: Date }[];
};

export type Reservation = {
  _id: ObjectId;
  eventId: string;
  seatId: string;
  customerName: string;
  email: string;
  amount: number; // grosze, zapisane w chwili rezerwacji
  code: string | null;
  status: ReservationStatus;
  active: boolean;
  createdAt: Date;
  expiresAt: Date;
  paidAt?: Date;
  payment?: ReservationPayment;
  pointsUsed?: number; // [E3] ustalane przy pierwszym „Zapłać” (D16)
  cardAmount?: number; // [E3] amount − pointsUsed — kwota sesji Stripe
  pointsEarned?: number; // [E3] floor(cardAmount / 100) × 10, przy przyjęciu płatności (D18)
  loyalty?: ReservationLoyalty;
  ticketEmail?: TicketEmail;
};

// --- [E3] Punkty i mail (§2) ---

/** Krok operacji w Voucherify: zajęty atomowo (pending), potem done / retry / failed. */
export type LoyaltyStep = {
  status: "pending" | "done" | "retry" | "failed";
  points: number;
  at: Date;
  attempts: number;
};

export type ReservationLoyalty = {
  spend?: LoyaltyStep; // pobranie pointsUsed (karta B)
  refund?: LoyaltyStep; // zwrot pointsUsed za nieopłaconą rezerwację (D17)
  earn?: LoyaltyStep; // naliczenie pointsEarned (D18)
};

export type TicketEmail = {
  status: "sending" | "sent" | "retry" | "failed";
  attempts: number;
  resendId?: string;
  lastError?: string; // tylko do diagnozy, nigdy w API
  at: Date;
};

export type LoyaltyMember = {
  _id: string; // e-mail po trim + lowercase (D13)
  memberId: string | null; // "lmbr_…"; null = sprawdziliśmy, nie ma
  cardId: string | null; // "lcrd_…" w portfelu VOUCHERIFY_CARD_DEFINITION_ID
  status: "creating" | "ready" | "absent";
  welcome?: "pending" | "done";
  balance?: number; // pamięć podręczna (D20)
  balanceAt?: Date;
  spendLockUntil?: Date; // blokada wydawania punktów (Z36)
  checkedAt: Date;
};

// --- Body i odpowiedzi API (§3) ---

export type CreateReservationBody = {
  eventId: string;
  seatId: string;
  customerName: string;
  email: string;
};

export type EventDetailsResponse = { event: TrainEvent; takenSeats: string[] };

export type CreateReservationResponse = { reservationId: string; expiresAt: string; amount: number };

export type CheckoutResponse = { url: string; pointsUsed: number; cardAmount: number };

/** [E3] Body checkoutu: liczy się tylko points (D22). */
export type CheckoutBody = { points?: number };

export type LoyaltyResponse = { email: string; points: number };

export type ReservationPointsResponse = {
  balance: number;
  maxPoints: number;
  pointsUsed: number;
  locked: boolean;
};

export type CronSettleResponse = { refunded: number; earned: number; emails: number };

export type PurchaseResponse = { code: string };

export type ReservationResponse = {
  reservationId: string;
  eventId: string;
  seatId: string;
  customerName: string;
  status: ReservationStatus;
  amount: number;
  expiresAt: string;
  serverNow: string;
  code?: string;
  pointsUsed: number; // [E3] 0 bez punktów
  cardAmount: number; // [E3] amount − pointsUsed
  pointsEarned: number | null; // [E3] null przed opłaceniem
  event: TrainEvent;
};

export type TicketResponse = {
  code: string;
  seatId: string;
  customerName: string;
  amount: number;
  paidAt: string;
  pointsUsed: number;
  cardAmount: number;
  pointsEarned: number;
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
  | "ALREADY_PAID"
  | "PAYMENT_REQUIRED"
  | "RATE_LIMITED"
  | "INVALID_SIGNATURE"
  | "PAYMENT_UNAVAILABLE"
  | "POINTS_OVER_LIMIT"
  | "INSUFFICIENT_POINTS"
  | "POINTS_LOCKED"
  | "LOYALTY_BUSY"
  | "LOYALTY_UNAVAILABLE"
  | "UNAUTHORIZED"
  | "INTERNAL_ERROR";

/** [E3] Odmowy punktowe mają dodatkowe pole liczbowe (§4). */
export type ApiError = {
  error: ErrorCode;
  message: string;
  maxPoints?: number; // POINTS_OVER_LIMIT
  balance?: number; // INSUFFICIENT_POINTS
  pointsUsed?: number; // POINTS_LOCKED
};
