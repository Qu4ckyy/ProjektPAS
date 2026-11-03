"use client";
// Karta C: bilet z kodem — relacja, odjazd, wagon i miejsce, kod.
import Link from "next/link";
import { COMPANY_NAME, Logo } from "@/components/brand/Logo";
import { formatDate, formatDuration, formatPrice, formatTime } from "@/lib/format";
import { isWindow, parseSeatId } from "@/lib/seats";
import type { TicketResponse } from "@/lib/types";

export function TicketView({ ticket }: { ticket: TicketResponse }) {
  const { event } = ticket;
  const seat = parseSeatId(ticket.seatId);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900 print:hidden">
        <p className="font-semibold">Bilet opłacony. Szczęśliwej podróży!</p>
        <p className="text-sm">Zachowaj kod — pokażesz go konduktorowi. Ten adres możesz zapisać lub wydrukować.</p>
      </div>

      <article
        aria-label={`Bilet ${ticket.code}`}
        className="overflow-hidden rounded-2xl border-2 border-neutral-900 bg-white print:border-black"
      >
        <header className="flex items-center justify-between bg-emerald-700 px-5 py-3 text-white print:bg-white print:text-black">
          <span className="flex items-center gap-2 font-bold">
            <Logo className="h-7 w-7 rounded bg-white p-0.5" />
            {COMPANY_NAME}
          </span>
          <span className="text-sm font-medium">Bilet · {event.trainNumber}</span>
        </header>

        <div className="space-y-5 p-5">
          <div>
            <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Relacja</p>
            <p className="text-xl font-bold">
              {event.from} → {event.to}
            </p>
            <p className="text-sm text-neutral-600">Bilet ważny na całą trasę</p>
          </div>

          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <TicketField label="Data" value={formatDate(event.startsAt)} wide />
            <TicketField label="Odjazd" value={formatTime(event.startsAt)} />
            <TicketField label="Przyjazd" value={formatTime(event.arrivesAt)} />
            <TicketField label="Wagon" value={seat ? String(seat.wagon) : "—"} />
            <TicketField label="Miejsce" value={seat ? String(seat.seat) : ticket.seatId} />
            <TicketField
              label="Położenie"
              value={seat ? (isWindow(seat.seat) ? "przy oknie" : "przy korytarzu") : "—"}
            />
            <TicketField label="Czas przejazdu" value={formatDuration(event.startsAt, event.arrivesAt)} />
            <TicketField label="Pasażer" value={ticket.customerName} wide />
          </dl>
        </div>

        <div className="border-t-2 border-dashed border-neutral-300 bg-neutral-50 px-5 py-4 text-center print:bg-white">
          <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Kod biletu</p>
          <p className="mt-1 font-mono text-4xl font-bold tracking-[0.2em] text-neutral-900">{ticket.code}</p>
          <p className="mt-1 text-xs text-neutral-500">
            Zapłacono {formatPrice(ticket.amount)} · {formatDate(ticket.paidAt)}, {formatTime(ticket.paidAt)}
          </p>
        </div>
      </article>

      <div className="flex flex-wrap gap-3 print:hidden">
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Drukuj bilet
        </button>
        <Link
          href="/"
          className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 hover:border-neutral-500"
        >
          Rozkład jazdy
        </Link>
      </div>
    </div>
  );
}

function TicketField({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2" : undefined}>
      <dt className="text-xs font-medium tracking-wide text-neutral-500 uppercase">{label}</dt>
      <dd className="font-semibold text-neutral-900">{value}</dd>
    </div>
  );
}
