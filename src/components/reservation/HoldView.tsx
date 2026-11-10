"use client";
// Licznik „Trzymamy Twoje miejsce jeszcze 14:32” i przycisk „Zapłać 89,00 zł” (Etap II: Stripe Checkout).
// Używa go ekran rezerwacji i /payment/cancel („Zapłać ponownie” — ten sam checkout, ten sam url, D9).
// [E3] Pole „Użyj punktów” z podpowiedzią z serwera; po pierwszym „Zapłać” punkty są zablokowane (D16).
import { useEffect, useRef, useState } from "react";
import { parsePointsInput, PointsPicker } from "@/components/loyalty/PointsPicker";
import { usePointsHint } from "@/components/loyalty/usePointsHint";
import { apiFetch, NETWORK_MESSAGE } from "@/components/reservation/api";
import { Notice } from "@/components/reservation/Notice";
import { TripSummary } from "@/components/reservation/TripSummary";
import { useCountdown } from "@/components/reservation/useCountdown";
import { formatCountdown, formatPrice } from "@/lib/format";
import { formatPoints } from "@/lib/points";
import type { CheckoutResponse, ReservationResponse } from "@/lib/types";

type Props = {
  reservation: ReservationResponse;
  receivedAt: number;
  onExpired: () => void;
  onNotFound: () => void;
  /** 409 ALREADY_PAID — np. zapłacone w drugiej karcie; rodzic odświeża stan i pokazuje bilet. */
  onAlreadyPaid: () => void;
  /** Etykieta przycisku zamiast „Zapłać” (np. „Zapłać ponownie”); kwota zawsze na końcu. */
  payLabel?: string;
};

type PayError = {
  title: string;
  message: string;
  /** Punkty nie działają albo trwa inna płatność punktami — można zapłacić bez nich. */
  offerWithoutPoints?: boolean;
};

export function HoldView({ reservation, receivedAt, onExpired, onNotFound, onAlreadyPaid, payLabel }: Props) {
  const secondsLeft = useCountdown(reservation.expiresAt, reservation.serverNow, receivedAt);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<PayError | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const buyingRef = useRef(false);
  const expired = secondsLeft <= 0;
  const lastMinute = secondsLeft <= 60;
  const minutesLeft = Math.ceil(secondsLeft / 60);
  const { hint, reload: reloadHint } = usePointsHint(reservation.reservationId);
  const [pointsInput, setPointsInput] = useState("");
  // Punkty ustalone przy pierwszym „Zapłać” są zablokowane (D16): z rezerwacji, z podpowiedzi albo z 409.
  const [lockedByServer, setLockedByServer] = useState<number | null>(null);
  const hintData = hint.kind === "ok" ? hint.data : null;
  const lockedPoints =
    lockedByServer ??
    (reservation.pointsUsed > 0 ? reservation.pointsUsed : null) ??
    (hintData?.locked && hintData.pointsUsed > 0 ? hintData.pointsUsed : null);
  const maxPoints = hintData?.maxPoints ?? 0;
  const parsed =
    lockedPoints !== null
      ? { points: lockedPoints, error: null }
      : hintData
        ? parsePointsInput(pointsInput, maxPoints)
        : { points: 0, error: null };
  const points = parsed.points;
  const toPay = reservation.amount - points;

  async function pay() {
    // Ref chroni przed podwójnym kliknięciem, zanim React zablokuje przycisk (Z4).
    if (buyingRef.current || parsed.error) return;
    buyingRef.current = true;
    setBuying(true);
    setError(null);
    const res = await apiFetch<CheckoutResponse>(
      `/api/reservations/${encodeURIComponent(reservation.reservationId)}/checkout`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Bez podpowiedzi punktów (Voucherify nie działa) — body bez points, jak w Etapie II.
        body: JSON.stringify(lockedPoints !== null || hintData ? { points } : {}),
      },
    );
    if (res.kind === "ok") {
      // Przycisk zostaje zablokowany aż do przejścia na stronę płatności.
      window.location.assign(res.data.url);
      return;
    }
    buyingRef.current = false;
    setBuying(false);
    if (res.kind === "network") {
      return setError({ title: "Brak połączenia", message: `${NETWORK_MESSAGE} Nie zapłacisz dwa razy.` });
    }
    switch (res.error.error) {
      case "RESERVATION_EXPIRED":
        return onExpired();
      case "RESERVATION_NOT_FOUND":
        return onNotFound();
      case "ALREADY_PAID":
        return onAlreadyPaid();
      case "RATE_LIMITED":
        setCooldown(res.retryAfterSeconds ?? 10);
        return setError({ title: "Za dużo prób", message: "Odczekaj chwilę i spróbuj ponownie." });
      case "PAYMENT_UNAVAILABLE":
        return setError({
          title: "Płatności chwilowo nie działają",
          message: "Twoja rezerwacja jest bezpieczna. Spróbuj ponownie za chwilę.",
        });
      case "POINTS_OVER_LIMIT":
        setPointsInput(String(res.error.maxPoints ?? 0));
        reloadHint();
        return setError({ title: "Za dużo punktów", message: res.error.message });
      case "INSUFFICIENT_POINTS":
        setPointsInput(String(Math.min(res.error.balance ?? 0, maxPoints)));
        reloadHint();
        return setError({ title: "Masz za mało punktów", message: `${res.error.message} Poprawiliśmy liczbę w polu.` });
      case "POINTS_LOCKED":
        setLockedByServer(res.error.pointsUsed ?? 0);
        return setError({ title: "Punkty są już ustalone", message: res.error.message });
      case "LOYALTY_BUSY":
      case "LOYALTY_UNAVAILABLE":
        return setError({ title: "Punkty chwilowo nie działają", message: res.error.message, offerWithoutPoints: true });
      default:
        return setError({ title: "Nie udało się przejść do płatności", message: res.error.message });
    }
  }

  // 429: przycisk wraca po czasie z Retry-After.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  // „Wstecz” ze strony Stripe może przywrócić tę stronę z pamięci przeglądarki (bfcache)
  // z zablokowanym przyciskiem — odblokuj go.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      buyingRef.current = false;
      setBuying(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  useEffect(() => {
    // Serwer i tak odrzuci zakup po czasie — pokazujemy to od razu, bez przeładowania.
    // Trwające przejście do płatności rozstrzygnie serwer (200 albo 410).
    if (expired && !buyingRef.current) onExpired();
  }, [expired, onExpired]);

  return (
    <div className="space-y-6">
      <div
        className={`rounded-xl border p-5 text-center ${
          lastMinute ? "border-amber-300 bg-amber-50" : "border-emerald-200 bg-emerald-50"
        }`}
      >
        <p className={`text-sm font-medium ${lastMinute ? "text-amber-900" : "text-emerald-900"}`}>
          Trzymamy Twoje miejsce jeszcze
        </p>
        <p
          aria-hidden
          className={`mt-1 text-5xl font-bold tabular-nums ${lastMinute ? "text-amber-700" : "text-emerald-800"}`}
        >
          {formatCountdown(secondsLeft)}
        </p>
        {/* Czytnik ekranu dostaje komunikat co minutę, nie co sekundę. */}
        <p className="sr-only" aria-live="polite">
          {lastMinute
            ? "Została mniej niż minuta na opłacenie biletu."
            : `Trzymamy Twoje miejsce jeszcze ${minutesLeft} min.`}
        </p>
        {lastMinute && <p className="mt-2 text-sm text-amber-900">Ostatnia minuta — zapłać, zanim miejsce wróci do puli.</p>}
      </div>

      <TripSummary event={reservation.event} seatId={reservation.seatId} />

      <div className="rounded-xl border border-neutral-200 bg-white p-5">
        <p className="text-sm text-neutral-600">
          Rezerwacja na: <strong className="text-neutral-900">{reservation.customerName}</strong>
        </p>
        <p className="mt-1 text-sm text-neutral-600">
          Do zapłaty: <strong className="text-neutral-900">{formatPrice(toPay)}</strong>
          {points > 0 && <> (w tym {formatPoints(points)} = {formatPrice(points)} punktami)</>}. Płatność obsługuje
          Stripe — bilet z kodem dostaniesz zaraz po potwierdzeniu płatności.
        </p>

        {hint.kind === "loading" && lockedPoints === null && (
          <p role="status" className="mt-4 text-sm text-neutral-500">
            Sprawdzam Twoje punkty…
          </p>
        )}
        {(lockedPoints !== null || hintData) && (
          <PointsPicker
            value={pointsInput}
            onChange={(value) => {
              setPointsInput(value);
              if (error) setError(null);
            }}
            maxPoints={maxPoints}
            balance={hintData?.balance ?? 0}
            lockedPoints={lockedPoints}
            error={parsed.error}
            disabled={buying}
          />
        )}

        {error && (
          <div className="mt-4 space-y-2">
            <Notice tone="error" title={error.title} autoFocus>
              {error.message}
            </Notice>
            {error.offerWithoutPoints && lockedPoints === null && (
              <button
                type="button"
                onClick={() => {
                  setPointsInput("");
                  setError(null);
                }}
                className="text-sm font-medium text-emerald-800 underline hover:text-emerald-950"
              >
                Zapłać bez punktów
              </button>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => void pay()}
          disabled={buying || cooldown > 0 || Boolean(parsed.error)}
          className="mt-4 w-full rounded-lg bg-emerald-700 px-4 py-3 text-lg font-semibold text-white transition hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-wait disabled:opacity-60"
        >
          {buying
            ? "Przechodzę do płatności…"
            : cooldown > 0
              ? `Spróbuj ponownie za ${cooldown} s`
              : error
                ? "Spróbuj ponownie"
                : `${payLabel ?? "Zapłać"} ${formatPrice(toPay)}`}
        </button>
        <p className="mt-3 text-xs leading-relaxed text-neutral-500">
          Płatność obsługuje Stripe w trybie testowym — pieniądze nie są pobierane. Karta testowa: 4242 4242 4242
          4242, dowolna przyszła data ważności i dowolne CVC.
        </p>
      </div>
    </div>
  );
}
