// Punkty lojalnościowe — stałe i rachunki w jednym miejscu (CONTRACT.md §3 [E3]). Właściciel: Mateusz.
// Nikt nie liczy punktów inaczej: 1 pkt = 1 grosz, 10 pkt za każdy pełny złoty zapłacony kartą.

/** Saldo e-maila, który jeszcze nic nie kupił (D14). */
export const WELCOME_POINTS = 1000;

/** Punkty za każdy pełny złoty zapłacony kartą (D18). */
export const POINTS_PER_ZLOTY = 10;

/** Najwięcej punktów na bilet: połowa ceny w groszach, w dół. */
export function maxPointsFor(amount: number): number {
  return Math.floor(amount / 2);
}

/** Punkty za zakup — tylko od części zapłaconej kartą, od pełnych złotych. */
export function pointsEarnedFor(cardAmount: number): number {
  return Math.floor(cardAmount / 100) * POINTS_PER_ZLOTY;
}

/** "1000 pkt" — liczba bez separatorów tysięcy, jak w PDF. */
export function formatPoints(points: number): string {
  return `${points} pkt`;
}
