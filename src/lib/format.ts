// Formatowanie dat dla klienta — zawsze Europe/Warsaw, pl-PL (Z20).

const TIME_ZONE = "Europe/Warsaw";

const dateFormatter = new Intl.DateTimeFormat("pl-PL", {
  timeZone: TIME_ZONE,
  weekday: "short",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const timeFormatter = new Intl.DateTimeFormat("pl-PL", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
});

/** "czw., 4 grudnia 2026" */
export function formatDate(iso: string | Date): string {
  return dateFormatter.format(new Date(iso));
}

/** "08:15" */
export function formatTime(iso: string | Date): string {
  return timeFormatter.format(new Date(iso));
}

/** "2 godz. 27 min" */
export function formatDuration(startsAt: string | Date, arrivesAt: string | Date): string {
  const minutes = Math.max(0, Math.round((new Date(arrivesAt).getTime() - new Date(startsAt).getTime()) / 60000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} godz.` : `${h} godz. ${m} min`;
}

/** Licznik "14:32" z liczby sekund. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
