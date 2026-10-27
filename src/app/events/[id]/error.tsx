"use client";
import Link from "next/link";

export default function EventError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="space-y-3">
      <h1 className="text-2xl font-bold">Nie udało się wczytać mapy wagonu</h1>
      <p className="text-neutral-600">To może być chwilowy problem z połączeniem.</p>
      <div className="flex gap-3">
        <button onClick={reset} className="rounded-lg bg-neutral-900 px-4 py-2 text-white">
          Spróbuj ponownie
        </button>
        <Link href="/" className="rounded-lg border border-neutral-300 px-4 py-2">
          Rozkład jazdy
        </Link>
      </div>
    </div>
  );
}
