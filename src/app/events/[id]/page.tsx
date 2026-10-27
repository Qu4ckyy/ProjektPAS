// Mapa wagonu — karta A. Właściciel: Kamil.
import Link from "next/link";
import { notFound } from "next/navigation";
import { SeatMap } from "@/components/events/SeatMap";
import { getEvent, hasDeparted } from "@/lib/events";
import { formatDate, formatDuration, formatTime } from "@/lib/format";
import { getTakenSeats } from "@/lib/reservations";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ wagon?: string | string[] }>;
};

export default async function EventPage({ params, searchParams }: Props) {
  const [{ id }, { wagon }] = await Promise.all([params, searchParams]);
  const event = await getEvent(id);
  if (!event) notFound();

  const takenSeats = await getTakenSeats(event._id);
  const departed = hasDeparted(event);
  const requestedWagon = Number(Array.isArray(wagon) ? wagon[0] : wagon);
  const initialWagon = event.wagons.some((w) => w.number === requestedWagon)
    ? requestedWagon
    : (event.wagons[0]?.number ?? 1);

  return (
    <div className="space-y-6">
      <Link href="/" className="text-sm text-neutral-600 hover:underline">
        ← Rozkład jazdy
      </Link>

      <header>
        <div className="mb-1 inline-block rounded bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-700">
          {event.trainNumber}
        </div>
        <h1 className="text-2xl font-bold">
          {event.from} → {event.to}
        </h1>
        <p className="mt-1 text-neutral-600">
          {formatDate(event.startsAt)} · odjazd <strong>{formatTime(event.startsAt)}</strong> · przyjazd{" "}
          <strong>{formatTime(event.arrivesAt)}</strong> · {formatDuration(event.startsAt, event.arrivesAt)}
        </p>
      </header>

      {departed && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900">
          Ten pociąg już odjechał — mapa jest tylko do podglądu.
        </div>
      )}

      <p className="text-sm text-neutral-600">Wybierz wolne miejsce, żeby je zarezerwować.</p>

      <SeatMap event={event} initialTakenSeats={takenSeats} initialWagon={initialWagon} departed={departed} />
    </div>
  );
}
