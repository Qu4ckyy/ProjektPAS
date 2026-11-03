// Kursy z kolekcji events — CONTRACT.md §2. Właściciel: Kamil.
import { getDb } from "@/lib/db";
import type { TrainEvent } from "@/lib/types";

export const EVENTS_COLLECTION = "events";

const MAX_ID_LENGTH = 100;

// Zwracamy tylko pola z kontraktu, nawet jeśli w bazie leży coś więcej.
const PROJECTION = {
  _id: 1,
  title: 1,
  startsAt: 1,
  seats: 1,
  price: 1,
  trainNumber: 1,
  from: 1,
  to: 1,
  arrivesAt: 1,
  wagons: 1,
} as const;

async function eventsCollection() {
  return (await getDb()).collection<TrainEvent>(EVENTS_COLLECTION);
}

export async function getEvents(): Promise<TrainEvent[]> {
  const events = await eventsCollection();
  return events.find({}, { projection: PROJECTION }).sort({ startsAt: 1, _id: 1 }).toArray();
}

export async function getEvent(id: string): Promise<TrainEvent | null> {
  // typeof chroni przed NoSQL injection ({"$ne": null}), limit długości przed śmieciami (Z7).
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) return null;
  const events = await eventsCollection();
  return events.findOne({ _id: id }, { projection: PROJECTION });
}

/** Kurs już odjechał — nie da się na niego rezerwować. */
export function hasDeparted(event: Pick<TrainEvent, "startsAt">, now: Date = new Date()): boolean {
  return new Date(event.startsAt).getTime() <= now.getTime();
}
