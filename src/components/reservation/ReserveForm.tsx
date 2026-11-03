"use client";
// Karta B: formularz rezerwacji wybranego miejsca (/reserve?eventId=…&seatId=…).
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { apiFetch, NETWORK_MESSAGE } from "@/components/reservation/api";
import { type FieldErrors, type FormFields, validateFields } from "@/components/reservation/fields";
import { mapAction, Notice, TIMETABLE_ACTION } from "@/components/reservation/Notice";
import { TripSummary } from "@/components/reservation/TripSummary";
import { formatPrice } from "@/lib/format";
import { parseSeatId } from "@/lib/seats";
import type { CreateReservationResponse, EventDetailsResponse, TrainEvent } from "@/lib/types";
import { FIELD_LIMITS, validateReservationBody } from "@/lib/validation";

type LoadState =
  | { kind: "loading" }
  | { kind: "badUrl" }
  | { kind: "eventNotFound" }
  | { kind: "loadError"; message: string }
  | { kind: "departed"; event: TrainEvent }
  | { kind: "invalidSeat"; event: TrainEvent }
  | { kind: "seatTaken"; event: TrainEvent }
  | { kind: "form"; event: TrainEvent };

export function ReserveForm() {
  const searchParams = useSearchParams();
  const eventId = searchParams.get("eventId") ?? "";
  const seatId = searchParams.get("seatId") ?? "";
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!eventId || eventId.length > FIELD_LIMITS.eventId || !parseSeatId(seatId)) {
      return setState({ kind: "badUrl" });
    }
    setState({ kind: "loading" });
    const res = await apiFetch<EventDetailsResponse>(`/api/events/${encodeURIComponent(eventId)}`);
    if (res.kind === "network") return setState({ kind: "loadError", message: NETWORK_MESSAGE });
    if (res.kind === "error") {
      return setState(
        res.status === 404 ? { kind: "eventNotFound" } : { kind: "loadError", message: res.error.message },
      );
    }
    const { event, takenSeats } = res.data;
    if (new Date(event.startsAt).getTime() <= Date.now()) return setState({ kind: "departed", event });
    if (!event.seats.includes(seatId)) return setState({ kind: "invalidSeat", event });
    if (takenSeats.includes(seatId)) return setState({ kind: "seatTaken", event });
    setState({ kind: "form", event });
  }, [eventId, seatId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="text-2xl font-bold">Rezerwacja miejsca</h1>
      {renderState(state, seatId, load)}
    </div>
  );
}

function renderState(state: LoadState, seatId: string, retry: () => void) {
  switch (state.kind) {
    case "loading":
      return (
        <p role="status" className="text-neutral-600">
          Ładowanie kursu…
        </p>
      );
    case "badUrl":
      return (
        <Notice tone="error" title="Nieprawidłowy adres rezerwacji" actions={[{ ...TIMETABLE_ACTION, primary: true }]}>
          Wybierz kurs i miejsce na mapie wagonu.
        </Notice>
      );
    case "eventNotFound":
      return (
        <Notice tone="error" title="Nie ma takiego kursu" actions={[{ ...TIMETABLE_ACTION, primary: true }]}>
          Sprawdź adres albo wybierz kurs z rozkładu jazdy.
        </Notice>
      );
    case "loadError":
      return (
        <div className="space-y-3">
          <Notice tone="error" title="Nie udało się wczytać kursu" actions={[TIMETABLE_ACTION]}>
            {state.message}
          </Notice>
          <button
            type="button"
            onClick={retry}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
          >
            Spróbuj ponownie
          </button>
        </div>
      );
    case "departed":
      return (
        <Notice tone="warning" title="Ten pociąg już odjechał" actions={[{ ...TIMETABLE_ACTION, primary: true }]}>
          Nie można już zarezerwować miejsca na ten kurs. Wybierz inny z rozkładu jazdy.
        </Notice>
      );
    case "invalidSeat":
      return (
        <Notice tone="error" title="W tym pociągu nie ma takiego miejsca" actions={[mapAction(state.event._id)]}>
          Wybierz miejsce na mapie wagonu.
        </Notice>
      );
    case "seatTaken":
      return (
        <div className="space-y-4">
          <TripSummary event={state.event} seatId={seatId} />
          <Notice tone="warning" title="To miejsce jest już zajęte" actions={[mapAction(state.event._id)]}>
            Wybierz inne wolne miejsce na mapie wagonu.
          </Notice>
        </div>
      );
    case "form":
      return <ReservationForm event={state.event} seatId={seatId} />;
  }
}

type SubmitOutcome =
  | { kind: "idle" }
  | { kind: "seatTaken" }
  | { kind: "departed"; message: string }
  | { kind: "error"; message: string };

function ReservationForm({ event, seatId }: { event: TrainEvent; seatId: string }) {
  const router = useRouter();
  const formId = useId();
  const [fields, setFields] = useState<FormFields>({ customerName: "", email: "" });
  const [touched, setTouched] = useState<Record<keyof FormFields, boolean>>({ customerName: false, email: false });
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitOutcome>({ kind: "idle" });
  const submittingRef = useRef(false);

  const errors: FieldErrors = validateFields(fields);
  const visibleErrors: FieldErrors = {
    customerName: touched.customerName ? errors.customerName : undefined,
    email: touched.email ? errors.email : undefined,
  };

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Ref, nie tylko state: dwa szybkie kliknięcia trafiają, zanim React przerysuje przycisk.
    if (submittingRef.current) return;
    setTouched({ customerName: true, email: true });

    const body = { eventId: event._id, seatId, customerName: fields.customerName, email: fields.email };
    const fieldErrors = validateFields(fields);
    if (fieldErrors.customerName || fieldErrors.email) {
      const firstInvalid = fieldErrors.customerName ? "customerName" : "email";
      document.getElementById(`${formId}-${firstInvalid}`)?.focus();
      return;
    }
    const check = validateReservationBody(body);
    if (!check.ok) return setOutcome({ kind: "error", message: check.message });

    submittingRef.current = true;
    setSubmitting(true);
    setOutcome({ kind: "idle" });
    const res = await apiFetch<CreateReservationResponse>("/api/reservations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(check.value),
    });

    if (res.kind === "ok") {
      // Przycisk zostaje zablokowany aż do zmiany strony.
      router.push(`/reservations/${encodeURIComponent(res.data.reservationId)}`);
      return;
    }
    submittingRef.current = false;
    setSubmitting(false);
    if (res.kind === "network") return setOutcome({ kind: "error", message: NETWORK_MESSAGE });
    switch (res.error.error) {
      case "SEAT_TAKEN":
        return setOutcome({ kind: "seatTaken" });
      case "EVENT_DEPARTED":
        return setOutcome({ kind: "departed", message: res.error.message });
      default:
        return setOutcome({ kind: "error", message: res.error.message });
    }
  }

  if (outcome.kind === "seatTaken") {
    return (
      <div className="space-y-4">
        <TripSummary event={event} seatId={seatId} />
        <Notice
          tone="warning"
          title="Ktoś był szybszy — to miejsce właśnie zajęto"
          actions={[mapAction(event._id)]}
          autoFocus
        >
          Wybierz inne wolne miejsce na mapie wagonu.
        </Notice>
      </div>
    );
  }
  if (outcome.kind === "departed") {
    return (
      <Notice tone="warning" title="Ten pociąg już odjechał" actions={[{ ...TIMETABLE_ACTION, primary: true }]} autoFocus>
        {outcome.message}
      </Notice>
    );
  }

  return (
    <div className="space-y-6">
      <TripSummary event={event} seatId={seatId} />

      <form onSubmit={onSubmit} noValidate className="space-y-4 rounded-xl border border-neutral-200 bg-white p-5">
        <p className="text-sm text-neutral-600">
          Po rezerwacji trzymamy miejsce przez kilka minut. W tym czasie kupisz bilet jednym kliknięciem.
        </p>

        <Field
          id={`${formId}-customerName`}
          label="Imię i nazwisko"
          autoComplete="name"
          value={fields.customerName}
          error={visibleErrors.customerName}
          maxLength={FIELD_LIMITS.customerName}
          onChange={(v) => setFields((f) => ({ ...f, customerName: v }))}
          onBlur={() => setTouched((t) => ({ ...t, customerName: true }))}
        />
        <Field
          id={`${formId}-email`}
          label="E-mail"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={fields.email}
          error={visibleErrors.email}
          maxLength={FIELD_LIMITS.email}
          onChange={(v) => setFields((f) => ({ ...f, email: v }))}
          onBlur={() => setTouched((t) => ({ ...t, email: true }))}
        />

        {outcome.kind === "error" && (
          <Notice tone="error" title="Nie udało się zarezerwować miejsca" autoFocus>
            {outcome.message}
          </Notice>
        )}

        <p className="text-sm text-neutral-700">
          Cena miejsca: <strong className="text-neutral-900">{formatPrice(event.price)}</strong> — zapłacisz kartą po
          rezerwacji.
        </p>

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-emerald-700 px-4 py-3 font-semibold text-white transition hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-wait disabled:opacity-60"
        >
          {submitting ? "Rezerwuję…" : "Rezerwuję miejsce"}
        </button>
      </form>
    </div>
  );
}

type FieldProps = {
  id: string;
  label: string;
  value: string;
  error?: string;
  type?: "text" | "email";
  autoComplete: string;
  inputMode?: "email" | "text";
  maxLength: number;
  onChange: (value: string) => void;
  onBlur: () => void;
};

function Field({ id, label, value, error, type = "text", autoComplete, inputMode, maxLength, onChange, onBlur }: FieldProps) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-neutral-800">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        autoComplete={autoComplete}
        inputMode={inputMode}
        // Margines ponad limit, żeby komunikat o długości był widoczny, a nie ucięty tekst.
        maxLength={maxLength + 50}
        value={value}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className={`block w-full rounded-lg border px-3 py-2.5 text-base outline-none focus:ring-2 ${
          error ? "border-red-400 focus:ring-red-200" : "border-neutral-300 focus:border-neutral-500 focus:ring-neutral-200"
        }`}
      />
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
