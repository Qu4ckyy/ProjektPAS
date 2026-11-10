"use client";
// Podpowiedź do pola „Użyj punktów”: GET /api/reservations/:id/points (CONTRACT.md §3 [E3]).
// Jedno żądanie przy wejściu (sandbox Voucherify: 100 wywołań na godzinę) i ponownie tylko na żądanie.
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/components/reservation/api";
import type { ReservationPointsResponse } from "@/lib/types";

export type PointsHint =
  | { kind: "loading" }
  | { kind: "ok"; data: ReservationPointsResponse }
  /** 503, 429, sieć — pole znika, płatność bez punktów działa jak w Etapie II (D20). */
  | { kind: "unavailable" };

export function usePointsHint(reservationId: string): { hint: PointsHint; reload: () => void } {
  const [hint, setHint] = useState<PointsHint>({ kind: "loading" });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const res = await apiFetch<ReservationPointsResponse>(
        `/api/reservations/${encodeURIComponent(reservationId)}/points`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setHint(res.kind === "ok" ? { kind: "ok", data: res.data } : { kind: "unavailable" });
    })();
    return () => controller.abort();
  }, [reservationId, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { hint, reload };
}
