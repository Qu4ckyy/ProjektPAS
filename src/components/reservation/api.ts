// Wywołania API z przeglądarki: zawsze no-store, nigdy wyjątek do komponentu.
import type { ApiError } from "@/lib/types";

export type ApiResult<T> =
  | { kind: "ok"; status: number; data: T }
  | { kind: "error"; status: number; error: ApiError; retryAfterSeconds?: number }
  | { kind: "network" };

const GENERIC_ERROR: ApiError = {
  error: "INTERNAL_ERROR",
  message: "Coś poszło nie tak. Spróbuj ponownie za chwilę.",
};

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: "no-store" });
  } catch {
    return { kind: "network" };
  }

  // Body może nie być JSON-em (np. 400 HTML od Next.js przy zepsutym %-kodowaniu w adresie).
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.ok) return { kind: "ok", status: res.status, data: body as T };
  const error = isApiError(body) ? body : GENERIC_ERROR;
  const retryAfter = Number(res.headers.get("retry-after"));
  return {
    kind: "error",
    status: res.status,
    error,
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: Math.ceil(retryAfter) } : {}),
  };
}

function isApiError(body: unknown): body is ApiError {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as ApiError).error === "string" &&
    typeof (body as ApiError).message === "string"
  );
}

export const NETWORK_MESSAGE = "Brak połączenia z serwerem. Sprawdź internet i spróbuj ponownie.";
