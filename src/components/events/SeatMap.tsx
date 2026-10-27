"use client";
// Mapa wagonu z przełącznikiem wagonów i odświeżaniem zajętości (Z13).
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SeatLegend } from "@/components/events/SeatLegend";
import { Wagon } from "@/components/events/Wagon";
import { formatTime } from "@/lib/format";
import { countFree } from "@/lib/seats";
import type { EventDetailsResponse, TrainEvent } from "@/lib/types";

const REFRESH_INTERVAL_MS = 10_000;

type Props = {
  event: TrainEvent;
  initialTakenSeats: string[];
  initialWagon: number;
  departed: boolean;
};

type RefreshState = "idle" | "loading" | "error" | "gone";

export function SeatMap({ event, initialTakenSeats, initialWagon, departed }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [wagon, setWagon] = useState(initialWagon);
  const [takenSeats, setTakenSeats] = useState(initialTakenSeats);
  const [refreshState, setRefreshState] = useState<RefreshState>("idle");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  const taken = useMemo(() => new Set(takenSeats), [takenSeats]);
  const currentWagon = event.wagons.find((w) => w.number === wagon) ?? event.wagons[0];

  const refresh = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setRefreshState("loading");
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(event._id)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (res.status === 404) return setRefreshState("gone");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as EventDetailsResponse;
      setTakenSeats(Array.isArray(data.takenSeats) ? data.takenSeats : []);
      setUpdatedAt(new Date());
      setRefreshState("idle");
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error("[SeatMap] odświeżanie nie powiodło się", err);
      setRefreshState("error");
    }
  }, [event._id]);

  // Co ~10 s (tylko gdy karta jest widoczna) i od razu po powrocie na kartę.
  useEffect(() => {
    setUpdatedAt(new Date());
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      inFlight.current?.abort();
    };
  }, [refresh]);

  function selectWagon(number: number) {
    setWagon(number);
    // Wybrany wagon w URL, żeby odświeżenie strony go nie gubiło.
    router.replace(`${pathname}?wagon=${number}`, { scroll: false });
  }

  function selectSeat(seatId: string) {
    if (departed || taken.has(seatId)) return;
    router.push(`/reserve?eventId=${encodeURIComponent(event._id)}&seatId=${encodeURIComponent(seatId)}`);
  }

  if (refreshState === "gone") {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
        Ten kurs nie jest już dostępny.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="Wagony" className="flex flex-wrap gap-2">
        {event.wagons.map((w) => {
          const active = w.number === currentWagon.number;
          return (
            <button
              key={w.number}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => selectWagon(w.number)}
              className={[
                "rounded-lg border px-4 py-2 text-left transition",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900",
                active
                  ? "border-neutral-900 bg-neutral-900 text-white"
                  : "border-neutral-300 bg-white text-neutral-800 hover:border-neutral-500",
              ].join(" ")}
            >
              <span className="block font-semibold">Wagon {w.number}</span>
              <span className={`block text-xs ${active ? "text-neutral-300" : "text-neutral-500"}`}>
                wolne: {countFree(event.seats, taken, w.number)} / {w.seats}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="text-neutral-500" aria-live="polite">
          {refreshState === "error" ? (
            <span className="text-red-700">Nie udało się odświeżyć mapy. Sprawdź połączenie.</span>
          ) : updatedAt ? (
            `Zaktualizowano o ${formatTime(updatedAt)}`
          ) : null}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshState === "loading"}
          className="rounded-lg border border-neutral-300 px-3 py-1.5 font-medium hover:border-neutral-500 disabled:opacity-50"
        >
          {refreshState === "loading" ? "Odświeżanie…" : refreshState === "error" ? "Spróbuj ponownie" : "Odśwież"}
        </button>
      </div>

      <div role="tabpanel" aria-label={`Wagon ${currentWagon.number}`}>
        <Wagon wagon={currentWagon} taken={taken} disabled={departed} onSelect={selectSeat} />
      </div>

      <SeatLegend />
    </div>
  );
}
