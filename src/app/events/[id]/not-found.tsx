import Link from "next/link";

export default function EventNotFound() {
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">Nie ma takiego kursu</h1>
      <p className="text-neutral-600">Sprawdź adres albo wybierz kurs z rozkładu jazdy.</p>
      <Link href="/" className="inline-block rounded-lg bg-neutral-900 px-4 py-2 text-white">
        Rozkład jazdy
      </Link>
    </div>
  );
}
