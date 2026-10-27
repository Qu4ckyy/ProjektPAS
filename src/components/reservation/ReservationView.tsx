"use client";
// STUB — licznik, zakup i bilet w karcie B+C frontend (Mateusz).
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { seatLabel } from "@/lib/seats";
import {
  RESERVATION_ID_REGEX,
  TICKET_CODE_REGEX,
  type ApiError,
  type PurchaseResponse,
  type ReservationResponse,
  type TicketResponse,
} from "@/lib/types";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "reservation"; data: ReservationResponse }
  | { kind: "ticket"; data: TicketResponse };

export function ReservationView({ param }: { param: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [buying, setBuying] = useState(false);

  useEffect(() => {
    const code = param.trim().toUpperCase();
    const url = RESERVATION_ID_REGEX.test(param)
      ? `/api/reservations/${param}`
      : TICKET_CODE_REGEX.test(code)
        ? `/api/tickets/${code}`
        : null;
    if (!url) {
      setState({ kind: "error", message: "Nie znaleziono rezerwacji ani biletu." });
      return;
    }
    fetch(url, { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) return setState({ kind: "error", message: (data as ApiError).message });
        setState(url.startsWith("/api/tickets") ? { kind: "ticket", data } : { kind: "reservation", data });
      })
      .catch(() => setState({ kind: "error", message: "Błąd sieci, odśwież stronę." }));
  }, [param]);

  async function buy(id: string) {
    setBuying(true);
    try {
      const res = await fetch(`/api/reservations/${id}/purchase`, { method: "POST", cache: "no-store" });
      const data = await res.json();
      if (!res.ok) return setState({ kind: "error", message: (data as ApiError).message });
      router.replace(`/reservations/${(data as PurchaseResponse).code}`);
    } catch {
      setState({ kind: "error", message: "Błąd sieci, spróbuj ponownie." });
    } finally {
      setBuying(false);
    }
  }

  if (state.kind === "loading") return <p>Ładowanie…</p>;
  if (state.kind === "error") return <p className="text-red-600">{state.message}</p>;
  if (state.kind === "ticket") {
    const t = state.data;
    return (
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">Bilet {t.code}</h1>
        <p>{t.event.title}</p>
        <p>{seatLabel(t.seatId)}</p>
        <p>{t.customerName}</p>
      </div>
    );
  }
  const r = state.data;
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-bold">Rezerwacja</h1>
      <p>{r.event.title}</p>
      <p>
        {seatLabel(r.seatId)} · status: {r.status} · ważna do {new Date(r.expiresAt).toLocaleTimeString("pl-PL")}
      </p>
      <button
        onClick={() => buy(r.reservationId)}
        disabled={buying || r.status !== "held"}
        className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
      >
        Kupuję bilet
      </button>
    </div>
  );
}
