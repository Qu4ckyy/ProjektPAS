// STUB — implementuje Kamil (karta A: mapa wagonu).
import Link from "next/link";
import { notFound } from "next/navigation";
import { getEvent } from "@/lib/events";
import { formatDate, formatTime } from "@/lib/format";
import { getTakenSeats } from "@/lib/reservations";
import { parseSeatId } from "@/lib/seats";

export const dynamic = "force-dynamic";

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await getEvent(id);
  if (!event) notFound();
  const taken = new Set(await getTakenSeats(event._id));

  return (
    <div>
      <h1 className="text-2xl font-bold">{event.title}</h1>
      <p className="mb-4 text-neutral-600">
        {formatDate(event.startsAt)} · {formatTime(event.startsAt)}–{formatTime(event.arrivesAt)}
      </p>
      {event.wagons.map((w) => (
        <section key={w.number} className="mb-4">
          <h2 className="mb-2 font-semibold">Wagon {w.number}</h2>
          <div className="grid max-w-xs grid-cols-4 gap-2">
            {event.seats
              .filter((s) => parseSeatId(s)?.wagon === w.number)
              .map((seatId) =>
                taken.has(seatId) ? (
                  <span key={seatId} className="rounded bg-neutral-300 p-2 text-center text-neutral-500">
                    {parseSeatId(seatId)?.seat}
                  </span>
                ) : (
                  <Link
                    key={seatId}
                    href={`/reserve?eventId=${encodeURIComponent(event._id)}&seatId=${encodeURIComponent(seatId)}`}
                    className="rounded border p-2 text-center hover:bg-neutral-100"
                  >
                    {parseSeatId(seatId)?.seat}
                  </Link>
                ),
              )}
          </div>
        </section>
      ))}
    </div>
  );
}
