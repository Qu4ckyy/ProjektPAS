// POST /api/reservations/:id/checkout — CONTRACT.md §3, [E3] body { points }. Właściciel: Kamil.
// Z body liczy się tylko points (D22) — kwota zawsze z bazy (Z29, Z53).
import { NextResponse } from "next/server";
import { createCheckout } from "@/lib/checkout";
import { jsonError, rateLimited, withErrorHandling } from "@/lib/errors";
import { formatPoints } from "@/lib/points";
import { rateLimit } from "@/lib/rateLimit";
import { RESERVATION_ERRORS } from "@/lib/reservations";
import type { CheckoutResponse } from "@/lib/types";
import { MAX_BODY_BYTES, readBodyBytes, type Validation } from "@/lib/validation";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

type Ctx = { params: Promise<{ id: string }> };

/**
 * Body puste albo bez points → undefined (jak w Etapie II). points: liczba całkowita ≥ 0 (Z37).
 * STUB walidacji — dopracowuje Kamil (PROMPTY K3, punkt 1).
 */
async function readPoints(req: Request): Promise<Validation<number | undefined>> {
  const body = await readBodyBytes(req, MAX_BODY_BYTES);
  if (!body.ok) return body;
  if (body.value.length === 0) return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.value));
  } catch {
    return { ok: false, message: "Nieprawidłowy JSON w treści żądania." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: "Oczekiwano obiektu JSON, np. { \"points\": 1000 }." };
  }
  const points = (parsed as Record<string, unknown>).points;
  if (points === undefined) return { ok: true, value: undefined };
  if (typeof points !== "number" || !Number.isSafeInteger(points) || points < 0) {
    return { ok: false, message: "Pole points musi być liczbą całkowitą nie mniejszą niż 0." };
  }
  return { ok: true, value: points };
}

export const POST = withErrorHandling(
  "POST /api/reservations/:id/checkout",
  async (req: Request, { params }: Ctx) => {
    const limit = await rateLimit(req, "checkout");
    if (!limit.ok) return rateLimited(limit.retryAfterSeconds);

    const points = await readPoints(req);
    if (!points.ok) return jsonError(400, "VALIDATION_ERROR", points.message);

    const { id } = await params;
    const result = await createCheckout(id, points.value);
    if (!result.ok) {
      switch (result.error) {
        case "PAYMENT_UNAVAILABLE":
          return jsonError(503, "PAYMENT_UNAVAILABLE", "Płatności są chwilowo niedostępne. Spróbuj za chwilę.");
        case "LOYALTY_UNAVAILABLE":
          return jsonError(503, "LOYALTY_UNAVAILABLE", "Punkty chwilowo nie działają. Możesz zapłacić bez punktów.");
        case "LOYALTY_BUSY":
          return jsonError(409, "LOYALTY_BUSY", "Trwa inna płatność punktami tego klienta. Spróbuj za chwilę.");
        case "POINTS_OVER_LIMIT":
          return jsonError(
            400,
            "POINTS_OVER_LIMIT",
            `Punktami zapłacisz najwyżej połowę ceny: ${formatPoints(result.maxPoints)}.`,
            { maxPoints: result.maxPoints },
          );
        case "INSUFFICIENT_POINTS":
          return jsonError(409, "INSUFFICIENT_POINTS", `Masz za mało punktów: ${formatPoints(result.balance)}.`, {
            balance: result.balance,
          });
        case "POINTS_LOCKED":
          return jsonError(
            409,
            "POINTS_LOCKED",
            `Punkty dla tej płatności są już ustalone: ${formatPoints(result.pointsUsed)}.`,
            { pointsUsed: result.pointsUsed },
          );
        default: {
          const { status, message } = RESERVATION_ERRORS[result.error];
          return jsonError(status, result.error, message);
        }
      }
    }
    const res: CheckoutResponse = { url: result.url, pointsUsed: result.pointsUsed, cardAmount: result.cardAmount };
    return NextResponse.json(res, { headers: NO_STORE });
  },
);
