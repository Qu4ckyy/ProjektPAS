"use client";
// Stan rezerwacji na stronach powrotu ze Stripe (karta C). Opcjonalnie odpytuje GET /api/reservations/:id
// co 2 s, dopóki płatność czeka na potwierdzenie (webhook albo synchronizacja sesji po stronie serwera, Z31).
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, NETWORK_MESSAGE } from "@/components/reservation/api";
import { RESERVATION_ID_REGEX, type ReservationResponse } from "@/lib/types";

export const POLL_INTERVAL_MS = 2_000;
export const POLL_TIMEOUT_MS = 60_000;

export type PaymentStatusState =
  | { kind: "loading" }
  | { kind: "notFound" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; reservation: ReservationResponse; receivedAt: number };

type Options = {
  /** Odpytuj, dopóki status to "held" (strona sukcesu). */
  poll: boolean;
};

export function usePaymentStatus(reservationId: string, { poll }: Options) {
  const [state, setState] = useState<PaymentStatusState>({ kind: "loading" });
  const [timedOut, setTimedOut] = useState(false);
  const startedAt = useRef(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const fetchOnce = useCallback(async (): Promise<PaymentStatusState> => {
    if (!RESERVATION_ID_REGEX.test(reservationId)) return { kind: "notFound" };
    const res = await apiFetch<ReservationResponse>(`/api/reservations/${encodeURIComponent(reservationId)}`);
    if (res.kind === "network") return { kind: "error", message: NETWORK_MESSAGE };
    if (res.kind === "error") {
      return res.status === 404 ? { kind: "notFound" } : { kind: "error", message: res.error.message };
    }
    return { kind: "loaded", reservation: res.data, receivedAt: Date.now() };
  }, [reservationId]);

  const tick = useCallback(async () => {
    const next = await fetchOnce();
    if (!alive.current) return;
    setState(next);
    // setTimeout zamiast setInterval: następne pytanie dopiero po odpowiedzi na poprzednie.
    const waiting = next.kind === "loaded" ? next.reservation.status === "held" : next.kind === "error";
    if (!poll || !waiting) return;
    if (Date.now() - startedAt.current >= POLL_TIMEOUT_MS) {
      setTimedOut(true);
      return;
    }
    timer.current = setTimeout(() => void tick(), POLL_INTERVAL_MS);
  }, [fetchOnce, poll]);

  /** „Sprawdź ponownie” — nowe okno 60 s odpytywania. */
  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    startedAt.current = Date.now();
    setTimedOut(false);
    setState({ kind: "loading" });
    void tick();
  }, [tick]);

  useEffect(() => {
    alive.current = true;
    startedAt.current = Date.now();
    void tick();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [tick]);

  return { state, timedOut, refresh };
}
