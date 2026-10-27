// Miejsca w wagonie — CONTRACT.md §2. Właściciel: Kamil.
import type { Wagon } from "@/lib/types";

export const SEAT_ID_REGEX = /^[1-9]\d{0,2}-[1-9]\d{0,2}$/;

/** Miejsc w rzędzie (układ 2+2). */
export const SEATS_PER_ROW = 4;

export type ParsedSeat = { wagon: number; seat: number };

export type SeatPosition = "window" | "aisle";

/** "2-14" → { wagon: 2, seat: 14 }; złe wejście → null. */
export function parseSeatId(seatId: unknown): ParsedSeat | null {
  if (typeof seatId !== "string" || !SEAT_ID_REGEX.test(seatId)) return null;
  const [wagon, seat] = seatId.split("-").map(Number);
  return { wagon, seat };
}

export function toSeatId(wagon: number, seat: number): string {
  return `${wagon}-${seat}`;
}

/** Okno: n % 4 ∈ {0, 1}; korytarz: n % 4 ∈ {2, 3}. */
export function isWindow(seat: number): boolean {
  return seat % 4 === 0 || seat % 4 === 1;
}

export function seatPosition(seat: number): SeatPosition {
  return isWindow(seat) ? "window" : "aisle";
}

/** "2-14" → "Wagon 2, miejsce 14"; złe wejście → oryginalny tekst. */
export function seatLabel(seatId: string): string {
  const parsed = parseSeatId(seatId);
  return parsed ? `Wagon ${parsed.wagon}, miejsce ${parsed.seat}` : seatId;
}

/**
 * Rzędy wagonu w układzie 2+2: [[1, 2], [3, 4]], [[5, 6], [7, 8]], …
 * Lewa para to okno + korytarz, prawa para to korytarz + okno.
 */
export function wagonRows(wagon: Wagon): [number[], number[]][] {
  const rows: [number[], number[]][] = [];
  for (let first = 1; first <= wagon.seats; first += SEATS_PER_ROW) {
    const row = [first, first + 1, first + 2, first + 3].filter((n) => n <= wagon.seats);
    rows.push([row.slice(0, 2), row.slice(2)]);
  }
  return rows;
}

/** "1 wolne miejsce", "3 wolne miejsca", "12 wolnych miejsc". */
export function freeSeatsLabel(n: number): string {
  if (n === 1) return "1 wolne miejsce";
  const lastDigit = n % 10;
  const lastTwo = n % 100;
  const few = lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14);
  return few ? `${n} wolne miejsca` : `${n} wolnych miejsc`;
}

/** Liczba wolnych miejsc w wagonie (albo w całym kursie, gdy wagon nie podany). */
export function countFree(seats: string[], takenSeats: Iterable<string>, wagon?: number): number {
  const taken = new Set(takenSeats);
  return seats.filter((s) => !taken.has(s) && (wagon === undefined || parseSeatId(s)?.wagon === wagon)).length;
}
