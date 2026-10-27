// STUB — implementuje Eryk (CONTRACT.md §2, §3, §7). Szkielet zwraca dane na niby, bez bazy.
// Sygnatury poza getTakenSeats Eryk może zmienić — to jego plik.
import { getReservationTtlSeconds } from "@/lib/config";
import { getEvent } from "@/lib/events";
import type { CreateReservationBody, ReservationResponse, TicketResponse } from "@/lib/types";

const STUB_RESERVATION_ID = "a".repeat(24);
const STUB_CODE = "ABCD-EFGH";

/** Miejsca kupione i z ważną rezerwacją. Woła ją Kamil w GET /api/events/:id — sygnatura stała. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function getTakenSeats(eventId: string): Promise<string[]> {
  return [];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function createReservation(input: CreateReservationBody) {
  return {
    reservationId: STUB_RESERVATION_ID,
    expiresAt: new Date(Date.now() + getReservationTtlSeconds() * 1000),
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function purchaseReservation(id: string) {
  return { code: STUB_CODE };
}

export async function getReservation(id: string): Promise<ReservationResponse | null> {
  const event = await getEvent("ic-1500-2026-12-04");
  if (!event) return null;
  const now = new Date();
  return {
    reservationId: id,
    eventId: event._id,
    seatId: "1-1",
    customerName: "Jan Kowalski",
    status: "held",
    expiresAt: new Date(now.getTime() + getReservationTtlSeconds() * 1000).toISOString(),
    serverNow: now.toISOString(),
    event,
  };
}

export async function getTicketByCode(code: string): Promise<TicketResponse | null> {
  const event = await getEvent("ic-1500-2026-12-04");
  if (!event) return null;
  return {
    code,
    seatId: "1-1",
    customerName: "Jan Kowalski",
    purchasedAt: new Date().toISOString(),
    event,
  };
}
