// Pobranie punktów przy „Zapłać” (karta B) — CONTRACT.md §3 „Checkout z punktami” kroki 4–7, D15, D16, Z36–Z38,
// Z43, Z44, Z55. Właściciel: Kamil.
//
// Kolejność (każdy krok tylko po sukcesie poprzedniego):
//   4. claimPointsSpend — atomowe zajęcie loyalty.spend; Voucherify woła tylko zwycięzca (Z38),
//   5. acquireSpendLock — jedna płatność punktami na e-mail naraz (Z36),
//   6. getFreshBalance — świeże saldo z Voucherify, nigdy z pamięci podręcznej,
//   7. applyPoints(−points) z czekaniem na APPROVED (Z55) → spend: done.
// Sesję Stripe ze zniżką wolno utworzyć tylko po ok: true, a ok: true oznacza spend: done w bazie (Z44).
import { acquireSpendLock, applyPoints, getFreshBalance, releaseSpendLock } from "@/lib/loyalty";
import { claimPointsSpend, finishPointsSpend, getCheckoutCandidate } from "@/lib/reservations";
import type { Reservation } from "@/lib/types";
import { LoyaltyUnavailableError } from "@/lib/voucherify";

export type SpendResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; error: "RESERVATION_NOT_FOUND" | "RESERVATION_EXPIRED" | "ALREADY_PAID" | "LOYALTY_BUSY" | "LOYALTY_UNAVAILABLE" }
  | { ok: false; error: "POINTS_LOCKED"; pointsUsed: number }
  | { ok: false; error: "INSUFFICIENT_POINTS"; balance: number };

/** Ile przegrany równoległego „Zapłać” czeka na zwycięzcę (§3 krok 4) i jak często sprawdza rezerwację. */
export const SPEND_WAIT_MS = 8_000;
export const SPEND_POLL_MS = 300;

/** reason transakcji w Voucherify — nasz identyfikator operacji (§3 „Operacje na punktach”). */
export function spendReason(reservationId: string): string {
  return `spend-${reservationId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Zajmuje rezerwację i zdejmuje points z karty klienta. ok: true → w bazie jest spend: done z tą
 * liczbą punktów (pointsUsed === points), a reservation.payment?.url może już istnieć (równoległe
 * „Zapłać” zdążyło utworzyć sesję) — wtedy checkout oddaje ten url bez Stripe.
 */
export async function spendPointsForCheckout(reservationId: string, points: number): Promise<SpendResult> {
  const claim = await claimPointsSpend(reservationId, points);
  if (!claim.ok) {
    switch (claim.error) {
      case "POINTS_LOCKED":
        return { ok: false, error: "POINTS_LOCKED", pointsUsed: claim.pointsUsed ?? 0 };
      case "SPEND_IN_PROGRESS":
        return waitForWinner(reservationId, points);
      default:
        return { ok: false, error: claim.error };
    }
  }
  // Punkty już zeszły (np. Stripe padł po pobraniu) — nie pobieramy drugi raz (§3 krok 8).
  if (claim.alreadySpent) return { ok: true, reservation: claim.reservation };
  return spendClaimed(reservationId, claim.reservation.email, points);
}

/**
 * Przegrany z tą samą liczbą punktów (Z38): co ~300 ms czyta rezerwację, najwyżej 8 s.
 * - zwycięzca zapisał sesję → ok (checkout oddaje ten sam url),
 * - spend: done, a sesji jeszcze nie ma → czekamy dalej; po czasie ok i checkout sam woła Stripe
 *   z tym samym kluczem idempotencji (ta sama sesja — np. gdy zwycięzcy padł Stripe),
 * - zwycięzca skończył bez pobrania (retry/failed) → LOYALTY_BUSY: kolejne kliknięcie dostanie
 *   prawdziwą odpowiedź, a my nie zjadamy budżetu Voucherify (100/h) na N równoległych prób.
 */
async function waitForWinner(reservationId: string, points: number): Promise<SpendResult> {
  const deadline = Date.now() + SPEND_WAIT_MS;
  let spent: Reservation | null = null;
  while (Date.now() < deadline) {
    await sleep(SPEND_POLL_MS);
    const candidate = await getCheckoutCandidate(reservationId);
    if (!candidate.ok) return candidate;
    const { reservation } = candidate;
    const used = reservation.pointsUsed ?? 0;
    const status = reservation.loyalty?.spend?.status;
    if (reservation.payment?.url) {
      if (used !== points) return { ok: false, error: "POINTS_LOCKED", pointsUsed: used };
      return { ok: true, reservation };
    }
    if (status === "pending" && used === points) continue;
    if (status === "done" && used === points) {
      spent = reservation;
      continue;
    }
    if (used > 0 && used !== points) return { ok: false, error: "POINTS_LOCKED", pointsUsed: used };
    return { ok: false, error: "LOYALTY_BUSY" };
  }
  return spent ? { ok: true, reservation: spent } : { ok: false, error: "LOYALTY_BUSY" };
}

/** Kroki 5–7 dla zwycięzcy zajęcia. Każde wyjście kończy spend (done/retry/failed), blokada zawsze zwolniona. */
async function spendClaimed(reservationId: string, email: string, points: number): Promise<SpendResult> {
  let locked = false;
  let sent = false; // żądanie pobrania mogło dojść do Voucherify
  try {
    locked = await acquireSpendLock(email);
    if (!locked) {
      // Z36: ten sam klient płaci punktami za inną rezerwację — nie ruszamy salda.
      await finishPointsSpend(reservationId, "retry");
      return { ok: false, error: "LOYALTY_BUSY" };
    }

    const balance = await getFreshBalance(email);
    if (balance < points) {
      await finishPointsSpend(reservationId, "failed");
      return { ok: false, error: "INSUFFICIENT_POINTS", balance };
    }

    sent = true;
    const result = await applyPoints(email, -points, spendReason(reservationId), { waitForApproval: true });
    if (result === "rejected") {
      // Portfel nie pozwala zejść poniżej zera — saldo zmieniło się między odczytem a pobraniem.
      await finishPointsSpend(reservationId, "failed");
      return { ok: false, error: "INSUFFICIENT_POINTS", balance: await balanceAfterReject(email, balance) };
    }
    if (result === "retry") {
      // Wciąż PENDING albo bez pewności — następne kliknięcie sprawdzi transakcję po reason (Z44, Z55).
      await finishPointsSpend(reservationId, "retry");
      return { ok: false, error: "LOYALTY_UNAVAILABLE" };
    }

    await finishPointsSpend(reservationId, "done");
    return confirmSpent(reservationId, points);
  } catch (err) {
    if (err instanceof LoyaltyUnavailableError) {
      console.error(`[spend] Voucherify niedostępny przy pobraniu punktów dla ${reservationId}:`, err);
      await finishPointsSpend(reservationId, "retry");
      return { ok: false, error: "LOYALTY_UNAVAILABLE" };
    }
    // Błąd po naszej stronie (np. Mongo). Zanim cokolwiek poszło do Voucherify, oddajemy krok do
    // ponowienia; po wysłaniu zostawiamy pending — ponowienie po 2 min sprawdzi transakcję po reason.
    if (!sent) {
      await finishPointsSpend(reservationId, "retry").catch((finishErr) =>
        console.error(`[spend] Nie udało się oddać kroku spend ${reservationId} do ponowienia:`, finishErr),
      );
    }
    throw err;
  } finally {
    if (locked) {
      await releaseSpendLock(email).catch((releaseErr) =>
        // Blokada i tak wygasa sama po 15 s.
        console.error(`[spend] Nie udało się zwolnić blokady punktów:`, releaseErr),
      );
    }
  }
}

/** Saldo do odpowiedzi INSUFFICIENT_POINTS po REJECTED; gdy Voucherify nie odpowie — ostatni odczyt. */
async function balanceAfterReject(email: string, lastKnown: number): Promise<number> {
  try {
    return await getFreshBalance(email);
  } catch (err) {
    if (!(err instanceof LoyaltyUnavailableError)) throw err;
    console.error("[spend] Nie udało się odczytać salda po odrzuconym pobraniu:", err);
    return lastKnown;
  }
}

/**
 * Po finishPointsSpend("done") czytamy rezerwację jeszcze raz: sesję ze zniżką tworzymy tylko,
 * gdy baza naprawdę ma spend: done z tą liczbą punktów (Z44). Rezerwacja mogła w tym czasie wygasnąć —
 * wtedy 410, a punkty odda settleLoyalty (D17).
 */
async function confirmSpent(reservationId: string, points: number): Promise<SpendResult> {
  const candidate = await getCheckoutCandidate(reservationId);
  if (!candidate.ok) return candidate;
  const { reservation } = candidate;
  if (reservation.loyalty?.spend?.status === "done" && reservation.pointsUsed === points) {
    return { ok: true, reservation };
  }
  console.error(
    `[spend] Rezerwacja ${reservationId} po pobraniu punktów nie ma spend: done (${reservation.loyalty?.spend?.status}) — bez sesji Stripe.`,
  );
  return { ok: false, error: "LOYALTY_UNAVAILABLE" };
}
