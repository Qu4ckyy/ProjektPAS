// STUB — implementuje Kamil (dane przykładowe, CONTRACT.md §2).
import type { TrainEvent, Wagon } from "@/lib/types";

const WAGONS: Wagon[] = [
  { number: 1, seats: 20 },
  { number: 2, seats: 20 },
];

function seatsFor(wagons: Wagon[]): string[] {
  return wagons.flatMap((w) => Array.from({ length: w.seats }, (_, i) => `${w.number}-${i + 1}`));
}

// Godziny w UTC; w grudniu Warszawa = UTC+1 (07:15Z = 08:15 w Warszawie).
export const sampleEvents: TrainEvent[] = [
  {
    _id: "ic-1500-2026-12-04",
    title: "IC 1500 Warszawa Centralna → Kraków Główny",
    trainNumber: "IC 1500",
    from: "Warszawa Centralna",
    to: "Kraków Główny",
    startsAt: "2026-12-04T07:15:00.000Z",
    arrivesAt: "2026-12-04T09:42:00.000Z",
    wagons: WAGONS,
    seats: seatsFor(WAGONS),
  },
  {
    _id: "eip-5300-2026-12-04",
    title: "EIP 5300 Gdańsk Główny → Warszawa Centralna",
    trainNumber: "EIP 5300",
    from: "Gdańsk Główny",
    to: "Warszawa Centralna",
    startsAt: "2026-12-04T13:05:00.000Z",
    arrivesAt: "2026-12-04T15:52:00.000Z",
    wagons: WAGONS,
    seats: seatsFor(WAGONS),
  },
  {
    _id: "tlk-3820-2026-12-05",
    title: "TLK 3820 Wrocław Główny → Poznań Główny",
    trainNumber: "TLK 3820",
    from: "Wrocław Główny",
    to: "Poznań Główny",
    startsAt: "2026-12-05T16:30:00.000Z",
    arrivesAt: "2026-12-05T19:01:00.000Z",
    wagons: WAGONS,
    seats: seatsFor(WAGONS),
  },
];
