// STUB — implementuje Eryk (CONTRACT.md §3: POST /api/reservations). Walidacja tylko podstawowa.
import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "@/lib/errors";
import { getEvent } from "@/lib/events";
import { createReservation } from "@/lib/reservations";
import type { CreateReservationBody, CreateReservationResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const FIELDS = ["eventId", "seatId", "customerName", "email"] as const;

export const POST = withErrorHandling("POST /api/reservations", async (req: Request) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "VALIDATION_ERROR", "Nieprawidłowy JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonError(400, "VALIDATION_ERROR", "Oczekiwano obiektu JSON.");
  }
  const record = body as Record<string, unknown>;
  for (const field of FIELDS) {
    if (typeof record[field] !== "string" || (record[field] as string).trim() === "") {
      return jsonError(400, "VALIDATION_ERROR", `Pole ${field} jest wymagane.`);
    }
  }
  const input = record as CreateReservationBody;
  const event = await getEvent(input.eventId);
  if (!event) return jsonError(404, "EVENT_NOT_FOUND", "Nie ma takiego kursu.");
  if (!event.seats.includes(input.seatId)) {
    return jsonError(400, "INVALID_SEAT", "W tym pociągu nie ma takiego miejsca.");
  }

  const { reservationId, expiresAt } = await createReservation(input);
  const res: CreateReservationResponse = { reservationId, expiresAt: expiresAt.toISOString() };
  return NextResponse.json(res, { status: 201 });
});
