// STUB — implementuje Kamil (karta A: rozkład jazdy).
import Link from "next/link";
import { getEvents } from "@/lib/events";
import { formatDate, formatTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const events = await getEvents();
  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Rozkład jazdy</h1>
      <ul className="space-y-2">
        {events.map((e) => (
          <li key={e._id}>
            <Link href={`/events/${encodeURIComponent(e._id)}`} className="block rounded border p-3 hover:bg-neutral-50">
              <strong>{e.trainNumber}</strong> {e.from} → {e.to} · {formatDate(e.startsAt)} ·{" "}
              {formatTime(e.startsAt)}–{formatTime(e.arrivesAt)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
