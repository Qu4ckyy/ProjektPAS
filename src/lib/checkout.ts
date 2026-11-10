// Przejście do płatności Stripe Checkout — CONTRACT.md §3, D9, D10, Z26, Z29, Z33, Z34. Właściciel: Kamil.
// [E3] Z punktami: D15, D16, D22, §3 „Checkout z punktami”. STUB części punktowej — dopracowuje Kamil.
import type Stripe from "stripe";
import { formatDate, formatPrice, formatTime } from "@/lib/format";
import { maxPointsFor } from "@/lib/points";
import { getCheckoutCandidate, saveCheckoutSession } from "@/lib/reservations";
import { seatLabel } from "@/lib/seats";
import { spendPointsForCheckout } from "@/lib/spend";
import { getStripe } from "@/lib/stripe";
import type { Reservation, TrainEvent } from "@/lib/types";

export type CreateCheckoutResult =
  | { ok: true; url: string; pointsUsed: number; cardAmount: number }
  | {
      ok: false;
      error:
        | "RESERVATION_NOT_FOUND"
        | "RESERVATION_EXPIRED"
        | "ALREADY_PAID"
        | "PAYMENT_UNAVAILABLE"
        | "LOYALTY_BUSY"
        | "LOYALTY_UNAVAILABLE";
    }
  | { ok: false; error: "POINTS_OVER_LIMIT"; maxPoints: number }
  | { ok: false; error: "POINTS_LOCKED"; pointsUsed: number }
  | { ok: false; error: "INSUFFICIENT_POINTS"; balance: number };

/** Kwota sesji Stripe: cardAmount, a dla rezerwacji bez ustalonych punktów — pełna cena. */
function cardAmountOf(reservation: Reservation): number {
  return reservation.cardAmount ?? reservation.amount - (reservation.pointsUsed ?? 0);
}

/**
 * APP_URL bez "/" na końcu (D10) — jedyne źródło adresów powrotu, nigdy nagłówek Host (Z33).
 * Brak albo coś innego niż adres http(s) → null (płatności niedostępne).
 */
export function appUrl(): string | null {
  const raw = process.env.APP_URL?.trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return raw;
}

/** Klucz idempotencji sesji — jedna sesja Stripe na rezerwację (D9). */
export function checkoutIdempotencyKey(reservationId: string): string {
  return `checkout-${reservationId}`;
}

/**
 * Parametry sesji wyliczone WYŁĄCZNIE z rezerwacji i kursu: Stripe odrzuca ten sam idempotency key
 * z innymi parametrami, więc żadnego Date.now() ani expires_at. Kwota tylko z bazy (Z29).
 */
export function buildSessionParams(
  reservation: Reservation,
  event: TrainEvent,
  baseUrl: string,
): Stripe.Checkout.SessionCreateParams {
  const reservationId = reservation._id.toHexString();
  const query = `reservationId=${encodeURIComponent(reservationId)}`;
  return {
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "pln",
          unit_amount: cardAmountOf(reservation),
          product_data: {
            name: event.title,
            description:
              `${seatLabel(reservation.seatId)} · ${formatDate(event.startsAt)}, odjazd ${formatTime(event.startsAt)}` +
              ((reservation.pointsUsed ?? 0) > 0 ? ` · punkty: −${formatPrice(reservation.pointsUsed ?? 0)}` : ""),
          },
        },
      },
    ],
    client_reference_id: reservationId,
    metadata: {
      reservationId,
      eventId: reservation.eventId,
      seatId: reservation.seatId,
      pointsUsed: String(reservation.pointsUsed ?? 0),
    },
    customer_email: reservation.email,
    locale: "pl",
    success_url: `${baseUrl}/payment/success?${query}`,
    cancel_url: `${baseUrl}/payment/cancel?${query}`,
  };
}

/**
 * POST /api/reservations/:id/checkout. Ponowne „Zapłać” zwraca zapisany url bez wołania Stripe;
 * równoległe pierwsze kliknięcia dostają tę samą sesję dzięki kluczowi idempotencji (D9, Z4, Z26).
 * Błąd Stripe → PAYMENT_UNAVAILABLE, rezerwacja nietknięta, szczegóły tylko w logach (Z34).
 */
export async function createCheckout(reservationId: string, points?: number): Promise<CreateCheckoutResult> {
  const candidate = await getCheckoutCandidate(reservationId);
  if (!candidate.ok) return candidate;
  const { event } = candidate;
  let { reservation } = candidate;

  // D16: po pierwszym „Zapłać” punkty są zablokowane; ten sam url bez Stripe i bez Voucherify.
  if (reservation.payment?.url) {
    const used = reservation.pointsUsed ?? 0;
    if (points !== undefined && points !== used) return { ok: false, error: "POINTS_LOCKED", pointsUsed: used };
    return { ok: true, url: reservation.payment.url, pointsUsed: used, cardAmount: cardAmountOf(reservation) };
  }

  const maxPoints = maxPointsFor(reservation.amount);
  if (points !== undefined && points > maxPoints) return { ok: false, error: "POINTS_OVER_LIMIT", maxPoints };
  if (points !== undefined && points > 0) {
    // Punkty schodzą przed sesją Stripe (D15); bez spend: done nie ma sesji ze zniżką (Z44).
    const spend = await spendPointsForCheckout(reservationId, points);
    if (!spend.ok) return spend;
    reservation = spend.reservation;
  } else if ((reservation.pointsUsed ?? 0) > 0) {
    // Punkty już pobrane wcześniej (Stripe padł po pobraniu) — bez points w body zostają te same.
    if (reservation.loyalty?.spend?.status !== "done") {
      return { ok: false, error: "POINTS_LOCKED", pointsUsed: reservation.pointsUsed ?? 0 };
    }
  }
  const pointsUsed = reservation.pointsUsed ?? 0;
  const cardAmount = cardAmountOf(reservation);

  const base = appUrl();
  if (!base) {
    console.error("[checkout] Brak lub zły APP_URL — nie da się zbudować adresów powrotu ze Stripe.");
    return { ok: false, error: "PAYMENT_UNAVAILABLE" };
  }

  const id = reservation._id.toHexString();
  let session: Stripe.Checkout.Session;
  try {
    session = await getStripe().checkout.sessions.create(buildSessionParams(reservation, event, base), {
      idempotencyKey: checkoutIdempotencyKey(id),
    });
  } catch (err) {
    // PaymentUnavailableError (brak / zły klucz), StripeError (API, sieć, timeout) — klient dostaje 503.
    console.error(`[checkout] Nie udało się utworzyć sesji Stripe dla ${id}:`, err);
    // Równoległe „Zapłać” mogło w międzyczasie zapisać tę samą sesję (Stripe odpowiada 409 na
    // jednoczesne żądania z jednym kluczem) — wtedy oddajemy jej url zamiast 503.
    const again = await getCheckoutCandidate(id);
    if (!again.ok) return again;
    if (again.reservation.payment?.url) {
      return { ok: true, url: again.reservation.payment.url, pointsUsed, cardAmount };
    }
    return { ok: false, error: "PAYMENT_UNAVAILABLE" };
  }
  if (!session.url) {
    console.error(`[checkout] Sesja Stripe ${session.id} bez url.`);
    return { ok: false, error: "PAYMENT_UNAVAILABLE" };
  }

  await saveCheckoutSession(id, { sessionId: session.id, url: session.url, pointsUsed, cardAmount });
  return { ok: true, url: session.url, pointsUsed, cardAmount };
}
