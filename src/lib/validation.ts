// Walidacja wejścia z sieci — CONTRACT.md §3, §7 (Z6, Z7). Czyste funkcje, bez bazy.
import { TICKET_CODE_REGEX, type CreateReservationBody } from "@/lib/types";

export type Validation<T> = { ok: true; value: T } | { ok: false; message: string };

/** Body większe niż 10 kB → 400 (CONTRACT.md §3). */
export const MAX_BODY_BYTES = 10 * 1024;

export const FIELD_LIMITS = { eventId: 100, seatId: 100, customerName: 100, email: 254 } as const;

type Field = keyof typeof FIELD_LIMITS;

const FIELDS = Object.keys(FIELD_LIMITS) as Field[];

const FIELD_LABELS: Record<Field, string> = {
  eventId: "eventId (kurs)",
  seatId: "seatId (miejsce)",
  customerName: "customerName (imię i nazwisko)",
  email: "email (adres e-mail)",
};

/**
 * Rozsądny e-mail: znaki dozwolone w części lokalnej, domena z etykiet 1–63 znaków
 * i literowa końcówka (np. .pl). Długość sprawdzamy przed regexem.
 */
const EMAIL_REGEX =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/;

/** Znaki sterujące (\n, \t, \0…) nie mają czego szukać w imieniu na bilecie. */
const CONTROL_CHARS = /\p{Cc}/u;

/**
 * reservationId: dokładnie 24 znaki hex, małe litery — CONTRACT.md §3.
 * Nie ObjectId.isValid (przepuszcza dowolne 12 znaków). Ten sam wzorzec co RESERVATION_ID_REGEX w types.ts.
 */
const RESERVATION_ID_PATTERN = /^[0-9a-f]{24}$/;

/** Dłuższego „kodu” nawet nie normalizujemy. */
const MAX_CODE_INPUT_LENGTH = 64;

const INVALID_JSON: Validation<never> = { ok: false, message: "Nieprawidłowy JSON w treści żądania." };

/**
 * Czyta body jako bajty z limitem rozmiaru. Nie ufa nagłówkowi Content-Length (może go nie być
 * albo kłamać) — liczy bajty przy czytaniu i przerywa po przekroczeniu limitu.
 */
export async function readBodyBytes(req: Request, maxBytes: number): Promise<Validation<Uint8Array>> {
  const tooLarge: Validation<never> = {
    ok: false,
    message: `Treść żądania jest za duża (maksymalnie ${maxBytes / 1024} kB).`,
  };
  const declared = Number(req.headers.get("content-length"));
  if (declared > maxBytes) return tooLarge;
  if (!req.body) return { ok: true, value: new Uint8Array() };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return tooLarge;
      }
      chunks.push(value);
    }
  } catch {
    // Klient zerwał połączenie w trakcie wysyłania.
    return { ok: false, message: "Nie udało się odczytać treści żądania." };
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, value: bytes };
}

/**
 * Czyta body jako JSON z limitem rozmiaru.
 * Content-Type nie jest wymagany (curl -d wysyła application/x-www-form-urlencoded).
 */
export async function readJsonBody(req: Request, maxBytes: number = MAX_BODY_BYTES): Promise<Validation<unknown>> {
  const body = await readBodyBytes(req, maxBytes);
  if (!body.ok) return body;
  try {
    // fatal: niepoprawne UTF-8 to błąd, a nie ciche znaki zastępcze.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body.value);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return INVALID_JSON;
  }
}

/**
 * Body POST /api/reservations. Każde pole musi być stringiem (typeof — blokuje {"$ne": null}),
 * po trim niepuste i w limicie długości. Zwraca tylko 4 znane pola — reszta jest ignorowana.
 * E-mail wraca małymi literami: tak go zapisujemy i tak porównujemy powtórzone żądania (D6).
 */
export function validateReservationBody(body: unknown): Validation<CreateReservationBody> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "Oczekiwano obiektu JSON z polami eventId, seatId, customerName, email." };
  }
  const record = body as Record<string, unknown>;
  const value = {} as CreateReservationBody;

  for (const field of FIELDS) {
    const raw = Object.hasOwn(record, field) ? record[field] : undefined;
    const label = FIELD_LABELS[field];
    if (typeof raw !== "string") {
      return { ok: false, message: `Pole ${label} jest wymagane i musi być tekstem.` };
    }
    const trimmed = raw.trim();
    if (trimmed === "") {
      return { ok: false, message: `Pole ${label} nie może być puste.` };
    }
    if (trimmed.length > FIELD_LIMITS[field]) {
      return { ok: false, message: `Pole ${label} może mieć najwyżej ${FIELD_LIMITS[field]} znaków.` };
    }
    value[field] = trimmed;
  }

  if (CONTROL_CHARS.test(value.customerName)) {
    return { ok: false, message: "Imię i nazwisko zawiera niedozwolone znaki." };
  }
  if (!EMAIL_REGEX.test(value.email)) {
    return { ok: false, message: "Nieprawidłowy adres e-mail." };
  }
  value.email = value.email.toLowerCase();
  return { ok: true, value };
}

/** Czy :id z URL wygląda jak reservationId. Zły format → 404 bez zapytania do bazy (Z7). */
export function isReservationId(id: unknown): id is string {
  return typeof id === "string" && RESERVATION_ID_PATTERN.test(id);
}

/** Kod biletu z URL: trim + wielkie litery + format XXXX-XXXX. Zły format → null (Z7, Z10). */
export function normalizeTicketCode(code: unknown): string | null {
  if (typeof code !== "string" || code.length > MAX_CODE_INPUT_LENGTH) return null;
  const normalized = code.trim().toUpperCase();
  return TICKET_CODE_REGEX.test(normalized) ? normalized : null;
}
