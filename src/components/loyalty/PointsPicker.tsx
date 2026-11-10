"use client";
// Pole „Użyj punktów” na ekranie rezerwacji (karta B — frontend, CONTRACT.md §5 [E3], D16).
// Walidacja jak na serwerze (liczba całkowita 0…maxPoints), ale ostatnie słowo ma serwer.
import { useId } from "react";
import { formatPrice } from "@/lib/format";
import { formatPoints } from "@/lib/points";

type Props = {
  value: string;
  onChange: (value: string) => void;
  maxPoints: number;
  balance: number;
  /** Punkty ustalone przy pierwszym „Zapłać” — pole tylko do odczytu (D16). */
  lockedPoints: number | null;
  error: string | null;
  disabled: boolean;
};

export function PointsPicker({ value, onChange, maxPoints, balance, lockedPoints, error, disabled }: Props) {
  const id = useId();

  if (lockedPoints !== null) {
    return (
      <div className="mt-4 rounded-lg bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
        Punkty dla tej płatności: <strong>{formatPoints(lockedPoints)}</strong> ({formatPrice(lockedPoints)}). Są już
        ustalone — zmienić ich nie można.
      </div>
    );
  }
  if (maxPoints <= 0) {
    return (
      <p className="mt-4 text-sm text-neutral-500">
        {balance > 0 ? `Masz ${formatPoints(balance)}.` : "Nie masz jeszcze punktów."} Za ten zakup zbierzesz 10 pkt za
        każdy złoty zapłacony kartą.
      </p>
    );
  }
  return (
    <div className="mt-4">
      <label htmlFor={id} className="block text-sm font-medium text-neutral-800">
        Użyj punktów
      </label>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          max={maxPoints}
          step={1}
          placeholder="0"
          value={value}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
          onChange={(e) => onChange(e.target.value)}
          className={`w-36 rounded-lg border px-3 py-2 tabular-nums outline-none focus:ring-2 ${
            error ? "border-red-400 focus:ring-red-200" : "border-neutral-300 focus:border-neutral-500 focus:ring-neutral-200"
          }`}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(String(maxPoints))}
          className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-800 hover:border-neutral-500 disabled:opacity-60"
        >
          Użyj wszystkich
        </button>
        {value !== "" && value !== "0" && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange("")}
            className="px-1 text-sm text-neutral-600 underline hover:text-neutral-900 disabled:opacity-60"
          >
            Bez punktów
          </button>
        )}
      </div>
      <p id={`${id}-hint`} className="mt-1 text-xs text-neutral-500">
        Najwięcej: {formatPoints(maxPoints)} (masz {formatPoints(balance)}). 100 pkt = 1 zł, punktami zapłacisz do
        połowy ceny.
      </p>
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

/** Pole → liczba punktów albo komunikat błędu. Puste = 0. */
export function parsePointsInput(raw: string, maxPoints: number): { points: number; error: string | null } {
  if (raw.trim() === "") return { points: 0, error: null };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return { points: 0, error: "Wpisz liczbę całkowitą punktów." };
  if (value > maxPoints) return { points: 0, error: `Najwięcej możesz użyć ${formatPoints(maxPoints)}.` };
  return { points: value, error: null };
}
