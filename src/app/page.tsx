// Rozkład jazdy — karta A. Właściciel: Kamil.
import { TimetableRow } from "@/components/events/TimetableRow";
import { getEvents, hasDeparted } from "@/lib/events";
import { formatDate } from "@/lib/format";
import { getTakenSeats } from "@/lib/reservations";
import { countFree } from "@/lib/seats";
import type { TrainEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

type Row = { event: TrainEvent; freeSeats: number; departed: boolean };

async function loadRows(): Promise<Row[]> {
  const events = await getEvents();
  const now = new Date();
  return Promise.all(
    events.map(async (event) => ({
      event,
      freeSeats: countFree(event.seats, await getTakenSeats(event._id)),
      departed: hasDeparted(event, now),
    })),
  );
}

export default async function TimetablePage() {
  let rows: Row[];
  try {
    rows = await loadRows();
  } catch (err) {
    console.error("[page /]", err);
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
        Nie udało się wczytać rozkładu jazdy. Odśwież stronę za chwilę.
      </div>
    );
  }

  // Grupujemy po dniu (w strefie Europe/Warsaw).
  const byDay = new Map<string, Row[]>();
  for (const row of rows) {
    const day = formatDate(row.event.startsAt);
    byDay.set(day, [...(byDay.get(day) ?? []), row]);
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Rozkład jazdy</h1>
      {rows.length === 0 ? (
        <p className="text-neutral-600">Brak kursów w rozkładzie.</p>
      ) : (
        <div className="space-y-8">
          {[...byDay].map(([day, dayRows]) => (
            <section key={day} aria-labelledby={`day-${day}`}>
              <h2 id={`day-${day}`} className="mb-3 text-sm font-semibold tracking-wide text-neutral-500 uppercase">
                {day}
              </h2>
              <ul className="space-y-3">
                {dayRows.map((row) => (
                  <li key={row.event._id}>
                    <TimetableRow {...row} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
