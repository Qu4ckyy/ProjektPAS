"use client";
// /payment/cancel?reservationId=… — płatność przerwana; „Zapłać ponownie”, dopóki rezerwacja jest ważna (karta C).
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { usePaymentStatus } from "@/components/payment/usePaymentStatus";
import { HoldView } from "@/components/reservation/HoldView";
import { mapAction, Notice, TIMETABLE_ACTION } from "@/components/reservation/Notice";
import { TripSummary } from "@/components/reservation/TripSummary";

export function PaymentCancel() {
  const router = useRouter();
  const reservationId = useSearchParams().get("reservationId") ?? "";
  const { state, refresh } = usePaymentStatus(reservationId, { poll: false });
  // Licznik doszedł do zera na tej stronie — serwer i tak odrzuci płatność po czasie.
  const [expiredHere, setExpiredHere] = useState(false);

  const paidCode = state.kind === "loaded" && state.reservation.status === "paid" ? state.reservation.code : undefined;
  useEffect(() => {
    if (paidCode) router.replace(`/reservations/${encodeURIComponent(paidCode)}`);
  }, [paidCode, router]);

  if (state.kind === "loading" || paidCode) {
    return (
      <Shell>
        <p role="status" className="text-neutral-600">
          Sprawdzam rezerwację…
        </p>
      </Shell>
    );
  }

  if (state.kind === "notFound") {
    return (
      <Shell>
        <Notice tone="error" title="Nie znaleziono rezerwacji" actions={[{ ...TIMETABLE_ACTION, primary: true }]}>
          Adres powrotu z płatności jest niepełny albo nieprawidłowy. Zacznij od rozkładu jazdy.
        </Notice>
      </Shell>
    );
  }

  if (state.kind === "error") {
    return (
      <Shell>
        <Notice tone="error" title="Nie udało się wczytać rezerwacji">
          {state.message}
        </Notice>
        <button
          type="button"
          onClick={refresh}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Spróbuj ponownie
        </button>
      </Shell>
    );
  }

  const { reservation, receivedAt } = state;
  if (expiredHere || reservation.status === "expired") {
    return (
      <Shell>
        <Notice
          tone="warning"
          title="Rezerwacja wygasła, miejsce wróciło do puli"
          actions={[mapAction(reservation.eventId), TIMETABLE_ACTION]}
          autoFocus
        >
          Płatność nie została dokończona na czas. Jeśli miejsce jest nadal wolne, możesz zarezerwować je ponownie.
        </Notice>
        <TripSummary event={reservation.event} seatId={reservation.seatId} />
      </Shell>
    );
  }

  return (
    <Shell>
      <Notice tone="info" title="Płatność nie została dokończona">
        Nic nie pobraliśmy. Miejsce nadal na Ciebie czeka — możesz zapłacić ponownie, dopóki rezerwacja jest ważna.
      </Notice>
      <HoldView
        reservation={reservation}
        receivedAt={receivedAt}
        onExpired={() => setExpiredHere(true)}
        onNotFound={refresh}
        onAlreadyPaid={refresh}
        payLabel="Zapłać ponownie"
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="text-2xl font-bold">Płatność przerwana</h1>
      {children}
    </div>
  );
}
