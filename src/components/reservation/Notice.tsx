"use client";
import Link from "next/link";
import { useEffect, useRef } from "react";

type Tone = "info" | "warning" | "error" | "success";

const TONES: Record<Tone, string> = {
  info: "border-neutral-200 bg-neutral-50 text-neutral-800",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  error: "border-red-200 bg-red-50 text-red-900",
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
};

export type NoticeAction = { href: string; label: string; primary?: boolean };

type Props = {
  tone?: Tone;
  title: string;
  children?: React.ReactNode;
  actions?: NoticeAction[];
  /** Przenieś fokus na komunikat (po błędzie), żeby czytnik ekranu go przeczytał. */
  autoFocus?: boolean;
};

export function Notice({ tone = "info", title, children, actions = [], autoFocus = false }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role={tone === "error" || tone === "warning" ? "alert" : "status"}
      className={`rounded-xl border p-5 outline-none ${TONES[tone]}`}
    >
      <h2 className="text-lg font-semibold">{title}</h2>
      {children && <div className="mt-1 text-sm leading-relaxed">{children}</div>}
      {actions.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-3">
          {actions.map((a) => (
            <Link
              key={a.href + a.label}
              href={a.href}
              className={
                a.primary
                  ? "rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
                  : "rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-800 hover:border-neutral-500"
              }
            >
              {a.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export const TIMETABLE_ACTION: NoticeAction = { href: "/", label: "Rozkład jazdy" };

export function mapAction(eventId: string, primary = true): NoticeAction {
  return { href: `/events/${encodeURIComponent(eventId)}`, label: "Wróć do mapy wagonu", primary };
}
