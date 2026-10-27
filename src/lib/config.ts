// Konfiguracja czytana w czasie żądania, nie przy buildzie — CONTRACT.md §1.

export const DEFAULT_RESERVATION_TTL_SECONDS = 900;

// STUB — walidację (dodatnia liczba całkowita + warning) dokłada Eryk.
export function getReservationTtlSeconds(): number {
  const value = Number(process.env.RESERVATION_TTL_SECONDS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_RESERVATION_TTL_SECONDS;
}
