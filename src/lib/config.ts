// Konfiguracja czytana w czasie żądania, nie przy buildzie — CONTRACT.md §1.

export const DEFAULT_RESERVATION_TTL_SECONDS = 900;

/** Górna granica: dłuższa rezerwacja nie ma sensu, a ogromna liczba dałaby Invalid Date (Z17). */
export const MAX_RESERVATION_TTL_SECONDS = 24 * 60 * 60;

// Ostatnia zła wartość, o której ostrzegliśmy — warning raz, nie przy każdym żądaniu.
let warnedFor: string | null = null;

/**
 * RESERVATION_TTL_SECONDS: dodatnia liczba całkowita (same cyfry, 1–86400).
 * Brak zmiennej → 900. Zła wartość → 900 + jednorazowy warning (Z17).
 */
export function getReservationTtlSeconds(): number {
  const raw = process.env.RESERVATION_TTL_SECONDS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RESERVATION_TTL_SECONDS;

  const trimmed = raw.trim();
  if (/^\d{1,9}$/.test(trimmed)) {
    const value = Number(trimmed);
    if (value >= 1 && value <= MAX_RESERVATION_TTL_SECONDS) return value;
  }

  if (warnedFor !== raw) {
    warnedFor = raw;
    console.warn(
      `[config] RESERVATION_TTL_SECONDS=${JSON.stringify(raw)} jest nieprawidłowe ` +
        `(oczekiwano liczby całkowitej 1–${MAX_RESERVATION_TTL_SECONDS}) — używam ${DEFAULT_RESERVATION_TTL_SECONDS}.`,
    );
  }
  return DEFAULT_RESERVATION_TTL_SECONDS;
}
