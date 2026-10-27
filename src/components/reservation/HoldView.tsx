"use client";
// Karta B + C: licznik „Trzymamy Twoje miejsce jeszcze 14:32” i przycisk „Kupuję bilet”.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { apiFetch, NETWORK_MESSAGE } from "@/components/reservation/api";
import { Notice } from "@/components/reservation/Notice";
import { TripSummary } from "@/components/reservation/TripSummary";
import { useCountdown } from "@/components/reservation/useCountdown";
import { formatCountdown } from "@/lib/format";
import type { PurchaseResponse, ReservationResponse } from "@/lib/types";

type Props = {
  reservation: ReservationResponse;
  receivedAt: number;
  onExpired: () => void;
  onNotFound: () => void;
};

export function HoldView({ reservation, receivedAt, onExpired, onNotFound }: Props) {
  const router = useRouter();
  const secondsLeft = useCountdown(reservation.expiresAt, reservation.serverNow, receivedAt);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buyingRef = useRef(false);
  const expired = secondsLeft <= 0;
  const lastMinute = secondsLeft <= 60;
  const minutesLeft = Math.ceil(secondsLeft / 60);

  async function buy() {
    // Ref chroni przed podwójnym kliknięciem, zanim React zablokuje przycisk (Z4).
    if (buyingRef.current) return;
    buyingRef.current = true;
    setBuying(true);
    setError(null);
    const res = await apiFetch<PurchaseResponse>(
      `/api/reservations/${encodeURIComponent(reservation.reservationId)}/purchase`,
      { method: "POST" },
    );
    if (res.kind === "ok") {
      router.replace(`/reservations/${encodeURIComponent(res.data.code)}`);
      return;
    }
    buyingRef.current = false;
    setBuying(false);
    if (res.kind === "network") return setError(NETWORK_MESSAGE);
    if (res.error.error === "RESERVATION_EXPIRED") return onExpired();
    if (res.error.error === "RESERVATION_NOT_FOUND") return onNotFound();
    setError(res.error.message);
  }

  useEffect(() => {
    // Serwer i tak odrzuci zakup po czasie — pokazujemy to od razu, bez przeładowania.
    // Trwający zakup rozstrzygnie serwer (200 albo 410).
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
            ? "Została mniej niż minuta na zakup biletu."
            : `Trzymamy Twoje miejsce jeszcze ${minutesLeft} min.`}
        </p>
        {lastMinute && <p className="mt-2 text-sm text-amber-900">Ostatnia minuta — kup bilet, zanim miejsce wróci do puli.</p>}
      </div>

      <TripSummary event={reservation.event} seatId={reservation.seatId} />

      <div className="rounded-xl border border-neutral-200 bg-white p-5">
        <p className="text-sm text-neutral-600">
          Rezerwacja na: <strong className="text-neutral-900">{reservation.customerName}</strong>
        </p>
        <p className="mt-1 text-sm text-neutral-600">Płatność online pojawi się w kolejnym etapie — teraz bilet jest od razu Twój.</p>

        {error && (
          <div className="mt-4">
            <Notice tone="error" title="Nie udało się kupić biletu" autoFocus>
              {error} Możesz bezpiecznie spróbować ponownie — nie kupisz biletu dwa razy.
            </Notice>
          </div>
        )}

        <button
          type="button"
          onClick={() => void buy()}
          disabled={buying}
          className="mt-4 w-full rounded-lg bg-emerald-700 px-4 py-3 text-lg font-semibold text-white transition hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-wait disabled:opacity-60"
        >
          {buying ? "Kupuję…" : error ? "Spróbuj ponownie" : "Kupuję bilet"}
        </button>
      </div>
    </div>
  );
}
