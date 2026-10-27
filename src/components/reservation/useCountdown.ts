"use client";
import { useEffect, useState } from "react";

/**
 * Sekundy do wygaśnięcia liczone zegarem serwera (Z15): offset = serverNow − czas klienta
 * w chwili odebrania odpowiedzi, więc przestawiony zegar w telefonie nie zmienia licznika.
 */
export function useCountdown(expiresAt: string, serverNow: string, receivedAt: number): number {
  const offset = Date.parse(serverNow) - receivedAt;
  const expiresMs = Date.parse(expiresAt);
  const compute = () => Math.max(0, Math.ceil((expiresMs - (Date.now() + offset)) / 1000));
  const [secondsLeft, setSecondsLeft] = useState(compute);

  useEffect(() => {
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((expiresMs - (Date.now() + offset)) / 1000)));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [expiresMs, offset]);

  return secondsLeft;
}
