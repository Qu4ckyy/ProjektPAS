import Link from "next/link";

export default function NotFound() {
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">Nie ma takiej strony</h1>
      <p className="text-neutral-600">Sprawdź adres albo zacznij od rozkładu jazdy.</p>
      <Link href="/" className="inline-block rounded-lg bg-neutral-900 px-4 py-2 text-white">
        Rozkład jazdy
      </Link>
    </div>
  );
}
