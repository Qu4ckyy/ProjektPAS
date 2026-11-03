import Link from "next/link";
import { formatDuration, formatPrice, formatTime } from "@/lib/format";
import { freeSeatsLabel } from "@/lib/seats";
import type { TrainEvent } from "@/lib/types";

type Props = { event: TrainEvent; freeSeats: number; departed: boolean };

export function TimetableRow({ event, freeSeats, departed }: Props) {
  const soldOut = freeSeats === 0;
  const content = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-4">
        <div className="text-center">
          <div className="text-2xl font-bold tabular-nums">{formatTime(event.startsAt)}</div>
          <div className="text-xs text-neutral-500">odjazd</div>
        </div>
        <div className="flex flex-col items-center text-xs text-neutral-500">
          <span>{formatDuration(event.startsAt, event.arrivesAt)}</span>
          <span aria-hidden className="text-lg leading-none">⟶</span>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold tabular-nums">{formatTime(event.arrivesAt)}</div>
          <div className="text-xs text-neutral-500">przyjazd</div>
        </div>
      </div>

      <div className="min-w-0 flex-1 sm:px-6">
        <div className="font-semibold">
          {event.from} → {event.to}
        </div>
        <div className="mt-1 inline-block rounded bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-700">
          {event.trainNumber}
        </div>
      </div>

      <div className="text-sm font-medium sm:text-right">
        <div className="text-lg font-bold tabular-nums text-neutral-900">{formatPrice(event.price)}</div>
        {departed ? (
          <span className="text-neutral-500">Odjechał</span>
        ) : soldOut ? (
          <span className="text-red-700">Brak wolnych miejsc</span>
        ) : (
          <span className="text-emerald-700">{freeSeatsLabel(freeSeats)}</span>
        )}
      </div>
    </div>
  );

  if (departed) {
    return (
      <div className="rounded-lg border border-neutral-200 p-4 opacity-60" aria-disabled>
        {content}
      </div>
    );
  }

  return (
    <Link
      href={`/events/${encodeURIComponent(event._id)}`}
      className="block rounded-lg border border-neutral-200 p-4 transition hover:border-neutral-400 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
    >
      {content}
    </Link>
  );
}
