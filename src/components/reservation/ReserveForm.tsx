"use client";
// STUB — pełny formularz w karcie B+C frontend (Mateusz).
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { seatLabel } from "@/lib/seats";
import type { ApiError, CreateReservationResponse } from "@/lib/types";

export function ReserveForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const eventId = searchParams.get("eventId") ?? "";
  const seatId = searchParams.get("seatId") ?? "";
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          eventId,
          seatId,
          customerName: form.get("customerName"),
          email: form.get("email"),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError((data as ApiError).message);
        return;
      }
      router.push(`/reservations/${(data as CreateReservationResponse).reservationId}`);
    } catch {
      setError("Coś poszło nie tak, spróbuj ponownie.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-sm space-y-3">
      <h1 className="text-2xl font-bold">Rezerwacja: {seatLabel(seatId)}</h1>
      <p className="text-neutral-600">Kurs: {eventId}</p>
      <label className="block">
        Imię i nazwisko
        <input name="customerName" required maxLength={100} className="block w-full rounded border p-2" />
      </label>
      <label className="block">
        E-mail
        <input name="email" type="email" required maxLength={254} className="block w-full rounded border p-2" />
      </label>
      {error && <p className="text-red-600">{error}</p>}
      <button disabled={submitting} className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50">
        Rezerwuję
      </button>
    </form>
  );
}
