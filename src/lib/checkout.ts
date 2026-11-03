// Przejście do płatności Stripe Checkout — CONTRACT.md §3, D9, D10.
// STUB — implementuje Kamil: sesja Stripe z kwotą z rezerwacji, idempotency key, APP_URL.
import { getCheckoutCandidate, saveCheckoutSession } from "@/lib/reservations";

export type CreateCheckoutResult =
  | { ok: true; url: string }
  | { ok: false; error: "RESERVATION_NOT_FOUND" | "RESERVATION_EXPIRED" | "ALREADY_PAID" | "PAYMENT_UNAVAILABLE" };

export function appUrl(): string | null {
  const url = process.env.APP_URL?.trim().replace(/\/+$/, "");
  return url ? url : null;
}

export async function createCheckout(reservationId: string): Promise<CreateCheckoutResult> {
  const candidate = await getCheckoutCandidate(reservationId);
  if (!candidate.ok) return candidate;
  if (candidate.reservation.payment?.url) return { ok: true, url: candidate.reservation.payment.url };

  const base = appUrl();
  if (!base) return { ok: false, error: "PAYMENT_UNAVAILABLE" };
  // Zaślepka bez Stripe: od razu „strona powrotu”, żeby frontend miał dokąd przejść.
  const url = `${base}/payment/success?reservationId=${encodeURIComponent(reservationId)}`;
  await saveCheckoutSession(reservationId, { sessionId: `cs_stub_${reservationId}`, url });
  return { ok: true, url };
}
