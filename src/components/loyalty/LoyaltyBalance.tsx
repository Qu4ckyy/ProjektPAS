"use client";
// Karta A — frontend: saldo punktów pod polem e-mail w /reserve (CONTRACT.md §5 [E3]).
// Tylko podpowiedź: błąd albo brak punktów niczego nie blokuje, rezerwacja działa jak w Etapie II.
import { useEffect, useState } from "react";
import { apiFetch } from "@/components/reservation/api";
import { validateEmail } from "@/components/reservation/fields";
import { formatPrice } from "@/lib/format";
import { formatPoints, maxPointsFor } from "@/lib/points";
import type { LoyaltyResponse } from "@/lib/types";

/** Odczekaj, aż klient przestanie pisać — sandbox Voucherify ma 100 wywołań na godzinę. */
const DEBOUNCE_MS = 500;

export function LoyaltyBalance({ email, price }: { email: string; price: number }) {
  const [balance, setBalance] = useState<{ email: string; points: number } | null>(null);
  const normalized = email.trim().toLowerCase();
  const valid = validateEmail(email) === undefined;

  useEffect(() => {
    if (!valid) return;
    // Jedno żądanie naraz: nowy e-mail przerywa poprzednie.
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const res = await apiFetch<LoyaltyResponse>(`/api/loyalty?email=${encodeURIComponent(normalized)}`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setBalance(res.kind === "ok" ? { email: normalized, points: res.data.points } : null);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [normalized, valid]);

  // Saldo innego (wcześniej wpisanego) e-maila nie może zostać na ekranie.
  const shown = valid && balance?.email === normalized ? balance.points : null;
  return (
    <p aria-live="polite" className="min-h-5 text-sm text-emerald-800">
      {shown !== null && shown > 0 && (
        <>
          Masz <strong>{formatPoints(shown)}</strong> ({formatPrice(shown)}). Przy tym bilecie zapłacisz nimi najwyżej{" "}
          {formatPoints(Math.min(shown, maxPointsFor(price)))} — wybierzesz to przed płatnością.
        </>
      )}
    </p>
  );
}
