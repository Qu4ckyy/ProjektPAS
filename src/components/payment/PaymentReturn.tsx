"use client";
// Strony powrotu ze Stripe (karta C) — CONTRACT.md §5. Szkielet M1: jeden odczyt statusu na wejściu
// i „Sprawdź ponownie”. Odpytywanie co 2 s, licznik i „Zapłać ponownie” dokłada M2.
// Bilet pokazujemy WYŁĄCZNIE przy status "paid" z serwera — nigdy na podstawie samego adresu (Z30).
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { apiFetch, NETWORK_MESSAGE } from "@/components/reservation/api";
import { mapAction, Notice, TIMETABLE_ACTION } from "@/components/reservation/Notice";
import { RESERVATION_ID_REGEX, type ReservationResponse } from "@/lib/types";

type Mode = "success" | "cancel";

type State =
  | { kind: "loading" }
  | { kind: "badUrl" }
  | { kind: "error"; message: string }
  | { kind: "reservation"; reservation: ReservationResponse };

export function PaymentReturn({ mode }: { mode: Mode }) {
  const router = useRouter();
  const reservationId = useSearchParams().get("reservationId") ?? "";
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!RESERVATION_ID_REGEX.test(reservationId)) return setState({ kind: "badUrl" });
    setState({ kind: "loading" });
    const res = await apiFetch<ReservationResponse>(`/api/reservations/${encodeURIComponent(reservationId)}`);
    if (res.kind === "network") return setState({ kind: "error", message: NETWORK_MESSAGE });
    if (res.kind === "error") {
      return setState(res.status === 404 ? { kind: "badUrl" } : { kind: "error", message: res.error.message });
    }
    if (res.data.status === "paid" && res.data.code) {
      router.replace(`/reservations/${encodeURIComponent(res.data.code)}`);
      return;
    }
    setState({ kind: "reservation", reservation: res.data });
  }, [reservationId, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = (
    <button
      type="button"
      onClick={() => void load()}
      className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
    >
      Sprawdź ponownie
    </button>
  );

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-2xl font-bold">{mode === "success" ? "Płatność w toku…" : "Płatność przerwana"}</h1>
      {state.kind === "loading" && (
        <p role="status" className="text-neutral-600">
          Sprawdzam status płatności…
        </p>
      )}
      {state.kind === "badUrl" && (
        <Notice tone="error" title="Nie znaleziono rezerwacji" actions={[{ ...TIMETABLE_ACTION, primary: true }]}>
          Sprawdź adres albo zacznij od rozkładu jazdy.
        </Notice>
      )}
      {state.kind === "error" && (
        <>
          <Notice tone="error" title="Nie udało się sprawdzić płatności">
            {state.message}
          </Notice>
          {retry}
        </>
      )}
      {state.kind === "reservation" && state.reservation.status === "expired" && (
        <Notice
          tone="warning"
          title="Rezerwacja wygasła, miejsce wróciło do puli"
          actions={[mapAction(state.reservation.eventId), TIMETABLE_ACTION]}
        >
          Jeśli pobraliśmy płatność po czasie, zwrócimy ją automatycznie.
        </Notice>
      )}
      {state.kind === "reservation" && state.reservation.status === "held" && (
        <>
          <Notice
            tone="info"
            title={mode === "success" ? "Czekamy na potwierdzenie od Stripe" : "Rezerwacja wciąż czeka na płatność"}
            actions={[
              {
                href: `/reservations/${encodeURIComponent(state.reservation.reservationId)}`,
                label: mode === "success" ? "Wróć do rezerwacji" : "Zapłać ponownie",
                primary: true,
              },
            ]}
          >
            {mode === "success"
              ? "Bilet pojawi się tutaj, gdy Stripe potwierdzi płatność."
              : "Możesz spróbować zapłacić jeszcze raz, dopóki rezerwacja jest ważna."}
          </Notice>
          {mode === "success" && retry}
        </>
      )}
    </div>
  );
}
