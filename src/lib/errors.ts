// Format błędów — CONTRACT.md §4.
import { NextResponse } from "next/server";
import type { ErrorCode } from "@/lib/types";

export function jsonError(status: number, error: ErrorCode, message: string) {
  return NextResponse.json({ error, message }, { status });
}

export function internalError(err: unknown, context: string) {
  // Szczegóły tylko w logach serwera — nigdy w odpowiedzi (Z12).
  console.error(`[${context}]`, err);
  return jsonError(500, "INTERNAL_ERROR", "Wystąpił nieoczekiwany błąd. Spróbuj ponownie.");
}

/**
 * Owija handler w try/catch: każdy nieobsłużony wyjątek → 500 INTERNAL_ERROR.
 * Użycie: export const GET = withErrorHandling("GET /api/events", async () => { ... });
 */
export function withErrorHandling<Args extends unknown[]>(
  context: string,
  handler: (...args: Args) => Promise<Response>,
) {
  return async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      return internalError(err, context);
    }
  };
}
