// STUB — implementuje Kamil (czytanie z kolekcji events). Szkielet czyta dane z pamięci, bez bazy.
import { sampleEvents } from "@/data/events";
import type { TrainEvent } from "@/lib/types";

export async function getEvents(): Promise<TrainEvent[]> {
  return [...sampleEvents].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export async function getEvent(id: string): Promise<TrainEvent | null> {
  if (typeof id !== "string" || id.length === 0 || id.length > 100) return null;
  return sampleEvents.find((e) => e._id === id) ?? null;
}
