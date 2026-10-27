// Nazwa i logo firmy: Konduktor — bilet z dziurką po kasowniku.
export const COMPANY_NAME = "Konduktor";
export const COMPANY_TAGLINE = "bilety kolejowe";

type Props = { className?: string; title?: string };

/** Bilet z wcięciami po bokach i dziurką po kasowniku. */
export function Logo({ className = "h-8 w-8", title }: Props) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <path
        d="M5 7h22a2 2 0 0 1 2 2v4a3 3 0 0 0 0 6v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a3 3 0 0 0 0-6V9a2 2 0 0 1 2-2Z"
        fill="#047857"
      />
      <circle cx="10" cy="13" r="2.25" fill="#ffffff" />
      <path d="M15 12.5h8M15 16h8M9 20.5h14" stroke="#a7f3d0" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

/** Logo + nazwa + podpis — nagłówek strony i bilet. */
export function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <Logo className="h-9 w-9" />
      <span className="leading-tight">
        <span className="block text-lg font-bold tracking-tight text-neutral-900">{COMPANY_NAME}</span>
        <span className="block text-xs text-neutral-500">{COMPANY_TAGLINE}</span>
      </span>
    </span>
  );
}
