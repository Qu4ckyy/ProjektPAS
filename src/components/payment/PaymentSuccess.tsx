"use client";
// /payment/success?reservationId=… — „Płatność w toku…”, która sama zamienia się w bilet (karta C).
// Bilet pokazujemy WYŁĄCZNIE przy status "paid" z serwera — nigdy na podstawie samego adresu powrotu (Z30).
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { usePaymentStatus } from "@/components/payment/usePaymentStatus";
import { mapAction, Notice, TIMETABLE_ACTION } from "@/components/reservation/Notice";
import { TripSummary } from "@/components/reservation/TripSummary";
import { formatPrice } from "@/lib/format";

export function PaymentSuccess() {
  const router = useRouter();
  const reservationId = useSearchParams().get("reservationId") ?? "";
  const { state, timedOut, refresh } = usePaymentStatus(reservationId, { poll: true });

  const paidCode = state.kind === "loaded" && state.reservation.status === "paid" ? state.reservation.code : undefined;
  useEffect(() => {
    if (paidCode) router.replace(`/reservations/${encodeURIComponent(paidCode)}`);
  }, [paidCode, router]);

  const checkAgain = (
    <button
      type="button"
      onClick={refresh}
      className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
    >
      Sprawdź ponownie
    </button>
  );

  if (state.kind === "notFound") {
    return (
      <Shell title="Nie znaleziono rezerwacji">
        <Notice tone="error" title="Nie znaleziono rezerwacji" actions={[{ ...TIMETABLE_ACTION, primary: true }]}>
          Adres powrotu z płatności jest niepełny albo nieprawidłowy. Zacznij od rozkładu jazdy.
        </Notice>
      </Shell>
    );
  }

  if (state.kind === "loaded" && state.reservation.status === "expired") {
    const { reservation } = state;
    return (
      <Shell title="Rezerwacja wygasła">
        <Notice
          tone="warning"
          title="Rezerwacja wygasła przed potwierdzeniem płatności"
          actions={[mapAction(reservation.eventId), TIMETABLE_ACTION]}
          autoFocus
        >
          Miejsce wróciło do puli. Jeśli pobraliśmy pieniądze, zwrócimy je automatycznie na Twoją kartę.
        </Notice>
        <TripSummary event={reservation.event} seatId={reservation.seatId} />
      </Shell>
    );
  }

  if (state.kind === "error" && timedOut) {
    return (
      <Shell title="Płatność w toku…">
        <Notice tone="error" title="Nie udało się sprawdzić płatności">
          {state.message}
        </Notice>
        {checkAgain}
      </Shell>
    );
  }

  if (timedOut && state.kind === "loaded") {
    const { reservation } = state;
    return (
      <Shell title="Płatność w toku…">
        <Notice tone="info" title="Wciąż czekamy na potwierdzenie od Stripe" autoFocus>
          Zwykle trwa to kilka sekund. Jeśli płatność się udała, bilet pojawi się tutaj — sprawdź ponownie za chwilę.
          Nie płać drugi raz.
        </Notice>
        <TripSummary event={reservation.event} seatId={reservation.seatId} />
        {checkAgain}
      </Shell>
    );
  }

  // Ładowanie, odpytywanie albo chwilowy błąd sieci w trakcie odpytywania.
  return (
    <Shell title="Płatność w toku…">
      <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-5">
        <span
          aria-hidden
          className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-emerald-700 border-t-transparent"
        />
        <div className="text-emerald-900">
          <p className="font-semibold">Czekamy na potwierdzenie płatności od Stripe…</p>
          <p className="text-sm">
            {state.kind === "loaded"
              ? `Kwota: ${formatPrice(state.reservation.amount)}. Bilet z kodem pojawi się tu sam — nie zamykaj strony.`
              : "Bilet z kodem pojawi się tu sam — nie zamykaj strony."}
          </p>
        </div>
      </div>
      {state.kind === "loaded" && <TripSummary event={state.reservation.event} seatId={state.reservation.seatId} />}
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="text-2xl font-bold">{title}</h1>
      {children}
    </div>
  );
}
