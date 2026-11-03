// Potwierdzanie płatności ze Stripe — CONTRACT.md §3 (webhook), D8, Z24–Z31.
// STUB — implementuje Eryk: atomowe held → paid, zwroty, log w stripe_events, synchronizacja sesji.
import type Stripe from "stripe";

export type StripeEventOutcome = "paid" | "refunded" | "ignored";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function handleStripeEvent(event: Stripe.Event): Promise<StripeEventOutcome> {
  return "ignored";
}

/** Dla GET /api/reservations/:id: jeśli sesja jest opłacona w Stripe, przyjmij płatność (Z31). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function syncCheckoutSession(reservationId: string): Promise<void> {}
