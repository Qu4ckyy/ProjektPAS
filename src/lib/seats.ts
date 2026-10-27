// Miejsca w wagonie — CONTRACT.md §2. Właściciel: Kamil (szkielet daje działającą wersję).

export const SEAT_ID_REGEX = /^[1-9]\d{0,2}-[1-9]\d{0,2}$/;

export type ParsedSeat = { wagon: number; seat: number };

/** "2-14" → { wagon: 2, seat: 14 }; złe wejście → null. */
export function parseSeatId(seatId: unknown): ParsedSeat | null {
  if (typeof seatId !== "string" || !SEAT_ID_REGEX.test(seatId)) return null;
  const [wagon, seat] = seatId.split("-").map(Number);
  return { wagon, seat };
}

/** Okno: n % 4 ∈ {0, 1}; korytarz: n % 4 ∈ {2, 3}. */
export function isWindow(seat: number): boolean {
  return seat % 4 === 0 || seat % 4 === 1;
}

/** "2-14" → "Wagon 2, miejsce 14"; złe wejście → oryginalny tekst. */
export function seatLabel(seatId: string): string {
  const parsed = parseSeatId(seatId);
  return parsed ? `Wagon ${parsed.wagon}, miejsce ${parsed.seat}` : seatId;
}
