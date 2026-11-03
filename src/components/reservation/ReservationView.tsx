"use client";
// /reservations/:param — reservationId → licznik i zakup (karta B + C); kod → bilet (karta C).
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { apiFetch, NETWORK_MESSAGE } from "@/components/reservation/api";
import { HoldView } from "@/components/reservation/HoldView";
import { mapAction, Notice, TIMETABLE_ACTION } from "@/components/reservation/Notice";
import { TicketView } from "@/components/reservation/TicketView";
import { TripSummary } from "@/components/reservation/TripSummary";
import { RESERVATION_ID_REGEX, TICKET_CODE_REGEX, type ReservationResponse, type TicketResponse } from "@/lib/types";

type State =
  | { kind: "loading" }
  | { kind: "notFound" }
  | { kind: "loadError"; message: string }
  | { kind: "held"; reservation: ReservationResponse; receivedAt: number }
  | { kind: "expired"; eventId: string; reservation?: ReservationResponse }
  | { kind: "ticket"; ticket: TicketResponse };

type Target = { kind: "reservation"; id: string } | { kind: "ticket"; code: string } | null;

function parseParam(param: string): Target {
  if (RESERVATION_ID_REGEX.test(param)) return { kind: "reservation", id: param };
  const code = param.trim().toUpperCase();
  if (TICKET_CODE_REGEX.test(code)) return { kind: "ticket", code };
  return null;
}

export function ReservationView({ param }: { param: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    const t = parseParam(param);
    if (!t) return setState({ kind: "notFound" });
    setState({ kind: "loading" });

    if (t.kind === "ticket") {
      const res = await apiFetch<TicketResponse>(`/api/tickets/${encodeURIComponent(t.code)}`);
      if (res.kind === "ok") return setState({ kind: "ticket", ticket: res.data });
      if (res.kind === "error" && res.status === 404) return setState({ kind: "notFound" });
      return setState({ kind: "loadError", message: res.kind === "network" ? NETWORK_MESSAGE : res.error.message });
    }

    const res = await apiFetch<ReservationResponse>(`/api/reservations/${encodeURIComponent(t.id)}`);
    const receivedAt = Date.now();
    if (res.kind === "network") return setState({ kind: "loadError", message: NETWORK_MESSAGE });
    if (res.kind === "error") {
      return setState(res.status === 404 ? { kind: "notFound" } : { kind: "loadError", message: res.error.message });
    }
    const reservation = res.data;
    if (reservation.status === "paid" && reservation.code) {
      router.replace(`/reservations/${encodeURIComponent(reservation.code)}`);
      return;
    }
    if (reservation.status === "expired") {
      return setState({ kind: "expired", eventId: reservation.eventId, reservation });
    }
    setState({ kind: "held", reservation, receivedAt });
  }, [param, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const onExpired = useCallback(() => {
    setState((s) => (s.kind === "held" ? { kind: "expired", eventId: s.reservation.eventId, reservation: s.reservation } : s));
  }, []);
  const onNotFound = useCallback(() => setState({ kind: "notFound" }), []);

  switch (state.kind) {
    case "loading":
      return (
        <p role="status" className="text-neutral-600">
          Ładowanie…
        </p>
      );
    case "notFound":
      return (
        <div className="mx-auto max-w-xl">
          <Notice tone="error" title="Nie znaleziono rezerwacji ani biletu" actions={[{ ...TIMETABLE_ACTION, primary: true }]}>
            Sprawdź adres. Kod biletu ma postać XXXX-XXXX.
          </Notice>
        </div>
      );
    case "loadError":
      return (
        <div className="mx-auto max-w-xl space-y-3">
          <Notice tone="error" title="Nie udało się wczytać rezerwacji">
            {state.message}
          </Notice>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
          >
            Spróbuj ponownie
          </button>
        </div>
      );
    case "expired":
      return (
        <div className="mx-auto max-w-xl space-y-4">
          <h1 className="text-2xl font-bold">Twoja rezerwacja</h1>
          <Notice
            tone="warning"
            title="Rezerwacja wygasła, miejsce wróciło do puli"
            actions={[mapAction(state.eventId), TIMETABLE_ACTION]}
            autoFocus
          >
            Czas na zakup biletu minął. Jeśli miejsce jest nadal wolne, możesz zarezerwować je ponownie.
          </Notice>
          {state.reservation && <TripSummary event={state.reservation.event} seatId={state.reservation.seatId} />}
        </div>
      );
    case "held":
      return (
        <div className="mx-auto max-w-xl space-y-6">
          <h1 className="text-2xl font-bold">Twoja rezerwacja</h1>
          <HoldView
            reservation={state.reservation}
            receivedAt={state.receivedAt}
            onExpired={onExpired}
            onNotFound={onNotFound}
          />
        </div>
      );
    case "ticket":
      return <TicketView ticket={state.ticket} />;
  }
}
