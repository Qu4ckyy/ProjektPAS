// Pobranie punktów przy „Zapłać” (karta B) — CONTRACT.md §3 „Checkout z punktami” kroki 4–7, D15, D16, Z36–Z38,
// Z44, Z55. Właściciel: Kamil.
// STUB — implementuje Kamil: czekanie przegranego na url (SPEND_IN_PROGRESS), blokada e-maila, pełna obsługa błędów.
import { applyPoints, getFreshBalance } from "@/lib/loyalty";
import { claimPointsSpend, finishPointsSpend } from "@/lib/reservations";
import type { Reservation } from "@/lib/types";
import { LoyaltyUnavailableError } from "@/lib/voucherify";

export type SpendResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; error: "RESERVATION_NOT_FOUND" | "RESERVATION_EXPIRED" | "ALREADY_PAID" | "LOYALTY_BUSY" | "LOYALTY_UNAVAILABLE" }
  | { ok: false; error: "POINTS_LOCKED"; pointsUsed: number }
  | { ok: false; error: "INSUFFICIENT_POINTS"; balance: number };

/** Zajmuje rezerwację i zdejmuje points z karty klienta; sesję Stripe wolno tworzyć tylko po ok: true. */
export async function spendPointsForCheckout(reservationId: string, points: number): Promise<SpendResult> {
  const claim = await claimPointsSpend(reservationId, points);
  if (!claim.ok) {
    if (claim.error === "POINTS_LOCKED") return { ok: false, error: "POINTS_LOCKED", pointsUsed: claim.pointsUsed ?? 0 };
    // STUB: przegrany równoległego „Zapłać” powinien poczekać na url zwycięzcy (Kamil).
    if (claim.error === "SPEND_IN_PROGRESS") return { ok: false, error: "LOYALTY_BUSY" };
    return { ok: false, error: claim.error };
  }
  const { reservation } = claim;
  if (claim.alreadySpent) return { ok: true, reservation };

  try {
    const balance = await getFreshBalance(reservation.email);
    if (balance < points) {
      await finishPointsSpend(reservationId, "failed");
      return { ok: false, error: "INSUFFICIENT_POINTS", balance };
    }
    const result = await applyPoints(reservation.email, -points, `spend-${reservationId}`, { waitForApproval: true });
    if (result === "done") {
      await finishPointsSpend(reservationId, "done");
      return { ok: true, reservation };
    }
    if (result === "rejected") {
      await finishPointsSpend(reservationId, "failed");
      return { ok: false, error: "INSUFFICIENT_POINTS", balance };
    }
    await finishPointsSpend(reservationId, "retry");
    return { ok: false, error: "LOYALTY_UNAVAILABLE" };
  } catch (err) {
    if (!(err instanceof LoyaltyUnavailableError)) throw err;
    console.error(`[spend] Voucherify niedostępny dla ${reservationId}:`, err);
    await finishPointsSpend(reservationId, "retry");
    return { ok: false, error: "LOYALTY_UNAVAILABLE" };
  }
}
