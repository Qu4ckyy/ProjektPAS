import { formatDate, formatDuration, formatTime } from "@/lib/format";
import { isWindow, parseSeatId } from "@/lib/seats";
import type { TrainEvent } from "@/lib/types";

/** "Wagon 2, miejsce 14 · przy oknie" */
export function seatDescription(seatId: string): string {
  const parsed = parseSeatId(seatId);
  if (!parsed) return seatId;
  return `Wagon ${parsed.wagon}, miejsce ${parsed.seat} · ${isWindow(parsed.seat) ? "przy oknie" : "przy korytarzu"}`;
}

/** Relacja, data, odjazd/przyjazd i miejsce — nagłówek formularza i rezerwacji. */
export function TripSummary({ event, seatId }: { event: TrainEvent; seatId: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5">
      <div className="mb-1 inline-block rounded bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-700">
        {event.trainNumber}
      </div>
      <p className="text-xl font-bold">
        {event.from} → {event.to}
      </p>
      <p className="mt-1 text-sm text-neutral-600">
        {formatDate(event.startsAt)} · odjazd <strong>{formatTime(event.startsAt)}</strong> · przyjazd{" "}
        <strong>{formatTime(event.arrivesAt)}</strong> · {formatDuration(event.startsAt, event.arrivesAt)}
      </p>
      <p className="mt-3 inline-flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-800">
        {seatDescription(seatId)}
      </p>
    </div>
  );
}
