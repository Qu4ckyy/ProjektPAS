export default function Loading() {
  return (
    <div role="status" className="space-y-4">
      <div className="h-6 w-32 animate-pulse rounded bg-neutral-200" />
      <div className="h-8 w-72 animate-pulse rounded bg-neutral-200" />
      <div className="mx-auto h-96 max-w-xs animate-pulse rounded-3xl bg-neutral-100" />
      <span className="sr-only">Ładowanie mapy wagonu…</span>
    </div>
  );
}
