// Mail z biletem przez Resend (karta C) — CONTRACT.md §0a D19, D21, §3 „Mail z biletem”, Z46–Z48. Właściciel: Mateusz.
// Wysyłka raz na rezerwację: atomowe zajęcie ticketEmail + Idempotency-Key w Resend. Błąd maila nigdy nie psuje biletu.
import { ObjectId, type Collection } from "mongodb";
import { getDb, RESERVATIONS_COLLECTION } from "@/lib/db";
import { getEvent } from "@/lib/events";
import { formatDate, formatPrice, formatTime } from "@/lib/format";
import { formatPoints } from "@/lib/points";
import { seatLabel } from "@/lib/seats";
import type { Reservation, TrainEvent } from "@/lib/types";

export type MailProvider = "resend" | "log";

const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "Konduktor <onboarding@resend.dev>";
const SEND_TIMEOUT_MS = 10_000;

/** Po tylu próbach zostaje "failed" (CONTRACT.md §3). */
export const MAX_EMAIL_ATTEMPTS = 5;

/** Wysyłka "sending" dłużej niż tyle = przerwana (padła funkcja); Idempotency-Key i tak nie wyśle drugi raz. */
const STALE_SENDING_MS = 2 * 60_000;

/** Ile zaległych maili na jeden przebieg crona. */
const RETRY_BATCH = 20;

/** log tylko poza produkcją Vercela (D21); domyślnie log lokalnie, resend na produkcji. */
export function mailProvider(): MailProvider {
  const raw = process.env.MAIL_PROVIDER?.trim().toLowerCase();
  if (process.env.VERCEL_ENV === "production") {
    if (raw && raw !== "resend") console.error(`[mail] MAIL_PROVIDER=${raw} jest niedozwolone na produkcji — używam resend.`);
    return "resend";
  }
  return raw === "resend" ? "resend" : "log";
}

async function reservationsCollection(): Promise<Collection<Reservation>> {
  return (await getDb()).collection<Reservation>(RESERVATIONS_COLLECTION);
}

/** Klucz idempotencji Resend — ten sam przy każdej próbie (Z46). */
export function ticketEmailIdempotencyKey(reservationId: string): string {
  return `ticket-${reservationId}`;
}

/**
 * Adres aplikacji do linku w mailu — z APP_URL, nigdy z nagłówka Host (D10). Celowo nie z checkout.ts:
 * checkout → reservations → payments → mail zrobiłoby cykl importów.
 */
function ticketBaseUrl(): string | null {
  const raw = process.env.APP_URL?.trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? raw : null;
  } catch {
    return null;
  }
}

// --- Treść (Z48) ---

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape wszystkiego, co pochodzi od klienta albo z bazy — imię nie może wstrzyknąć HTML ani linku. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

export type TicketEmailContent = { subject: string; html: string; text: string };

type TicketEmailData = Pick<
  Reservation,
  "code" | "customerName" | "seatId" | "amount" | "pointsUsed" | "cardAmount" | "pointsEarned"
>;

/** Temat, HTML i wersja tekstowa maila z biletem. baseUrl null → bez linku. */
export function buildTicketEmail(doc: TicketEmailData, event: TrainEvent, baseUrl: string | null): TicketEmailContent {
  const code = doc.code ?? "";
  const pointsUsed = doc.pointsUsed ?? 0;
  const cardAmount = doc.cardAmount ?? doc.amount - pointsUsed;
  const pointsEarned = doc.pointsEarned ?? 0;
  const ticketUrl = baseUrl ? `${baseUrl}/reservations/${encodeURIComponent(code)}` : null;

  const rows: [string, string][] = [
    ["Pociąg", `${event.trainNumber} ${event.from} → ${event.to}`],
    ["Odjazd", `${formatDate(event.startsAt)}, ${formatTime(event.startsAt)}`],
    ["Przyjazd", formatTime(event.arrivesAt)],
    ["Miejsce", seatLabel(doc.seatId)],
    ["Pasażer", doc.customerName],
  ];
  const payment: [string, string][] = [
    ["Zapłacono kartą", formatPrice(cardAmount)],
    ...(pointsUsed > 0
      ? ([["Zapłacono punktami", `${formatPoints(pointsUsed)} (${formatPrice(pointsUsed)})`]] as [string, string][])
      : []),
    ["Zebrane punkty", formatPoints(pointsEarned)],
  ];

  const subject = `Bilet ${code} — ${event.trainNumber} ${event.from} → ${event.to}`;

  const text = [
    "Dziękujemy za zakup biletu w Konduktorze.",
    "",
    `Kod biletu: ${code}`,
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    ...payment.map(([label, value]) => `${label}: ${value}`),
    ...(ticketUrl ? ["", `Bilet online: ${ticketUrl}`] : []),
    "",
    "Pokaż kod biletu konduktorowi.",
  ].join("\n");

  const tableRows = (items: [string, string][]) =>
    items
      .map(
        ([label, value]) =>
          `<tr><td style="padding:4px 12px 4px 0;color:#525252">${escapeHtml(label)}</td>` +
          `<td style="padding:4px 0;font-weight:600;color:#171717">${escapeHtml(value)}</td></tr>`,
      )
      .join("");

  const html = `<!doctype html>
<html lang="pl">
<body style="margin:0;padding:24px;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e5e5">
    <div style="background:#047857;color:#ffffff;padding:16px 20px;font-size:18px;font-weight:700">Konduktor · bilet kolejowy</div>
    <div style="padding:20px">
      <p style="margin:0 0 16px;color:#171717">Dziękujemy za zakup biletu.</p>
      <p style="margin:0;color:#525252;font-size:12px;text-transform:uppercase;letter-spacing:1px">Kod biletu</p>
      <p style="margin:4px 0 16px;font-family:'Courier New',monospace;font-size:28px;font-weight:700;letter-spacing:4px;color:#171717">${escapeHtml(code)}</p>
      <table style="border-collapse:collapse;font-size:14px">${tableRows(rows)}</table>
      <hr style="border:none;border-top:1px dashed #d4d4d4;margin:16px 0">
      <table style="border-collapse:collapse;font-size:14px">${tableRows(payment)}</table>
      ${
        ticketUrl
          ? `<p style="margin:20px 0 0"><a href="${escapeHtml(ticketUrl)}" style="display:inline-block;background:#047857;color:#ffffff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Otwórz bilet</a></p>`
          : ""
      }
      <p style="margin:20px 0 0;color:#737373;font-size:12px">Pokaż kod biletu konduktorowi.</p>
    </div>
  </div>
</body>
</html>`;

  return { subject, html, text };
}

// --- Wysyłka ---

type SendOutcome =
  | { status: "sent"; resendId: string }
  | { status: "retry" | "failed"; error: string };

/** Odpowiedź Resend → wynik (CONTRACT.md §3): 2xx sent, 409 idempotencji = już wysłany, 429/5xx retry, inne 4xx failed. */
async function sendViaResend(reservationId: string, to: string, content: TicketEmailContent): Promise<SendOutcome> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { status: "failed", error: "Brak RESEND_API_KEY" };

  let res: Response;
  try {
    res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": ticketEmailIdempotencyKey(reservationId),
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM?.trim() || DEFAULT_FROM,
        to: [to],
        subject: content.subject,
        html: content.html,
        text: content.text,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    return { status: "retry", error: `Sieć: ${err instanceof Error ? err.name : "błąd"}` };
  }

  let body: { id?: unknown; name?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Treść błędu bywa pusta — liczy się kod HTTP.
  }
  const name = typeof body.name === "string" ? body.name : "";
  if (res.ok) return { status: "sent", resendId: typeof body.id === "string" ? body.id : "" };
  // Ten sam klucz już wysłał mail (albo wysyła go równolegle) — drugiego nie będzie.
  if (res.status === 409 && (name === "invalid_idempotent_request" || name === "concurrent_idempotent_requests")) {
    return { status: "sent", resendId: "" };
  }
  const error = `HTTP ${res.status}${name ? ` ${name}` : ""}`;
  if (res.status === 429 || res.status >= 500) return { status: "retry", error };
  return { status: "failed", error };
}

/** Atomowe zajęcie wysyłki: brak, retry albo przerwane sending — tylko dla opłaconej (Z46). */
async function claimTicketEmail(reservations: Collection<Reservation>, _id: ObjectId): Promise<Reservation | null> {
  const now = new Date();
  return reservations.findOneAndUpdate(
    {
      _id,
      status: "paid",
      $or: [
        { ticketEmail: { $exists: false } },
        { "ticketEmail.status": "retry", "ticketEmail.attempts": { $lt: MAX_EMAIL_ATTEMPTS } },
        {
          "ticketEmail.status": "sending",
          "ticketEmail.at": { $lt: new Date(now.getTime() - STALE_SENDING_MS) },
          "ticketEmail.attempts": { $lt: MAX_EMAIL_ATTEMPTS },
        },
      ],
    },
    { $set: { "ticketEmail.status": "sending", "ticketEmail.at": now }, $inc: { "ticketEmail.attempts": 1 } },
    { returnDocument: "after" },
  );
}

/** Mail z biletem dla opłaconej rezerwacji — raz (Z46). Nigdy nie rzuca: bilet działa bez maila (Z47). */
export async function sendTicketEmail(reservationId: string): Promise<void> {
  try {
    if (!ObjectId.isValid(reservationId)) return;
    const reservations = await reservationsCollection();
    const _id = new ObjectId(reservationId);
    const doc = await claimTicketEmail(reservations, _id);
    if (!doc?.code) return;

    const event = await getEvent(doc.eventId);
    if (!event) {
      await reservations.updateOne(
        { _id },
        { $set: { "ticketEmail.status": "failed", "ticketEmail.lastError": "Brak kursu" } },
      );
      return;
    }
    const content = buildTicketEmail(doc, event, ticketBaseUrl());

    let outcome: SendOutcome;
    if (mailProvider() === "log") {
      console.log(`[mail] (log) do ${doc.email}: ${content.subject}\n${content.text}`);
      outcome = { status: "sent", resendId: "log" };
    } else {
      outcome = await sendViaResend(reservationId, doc.email, content);
    }

    if (outcome.status === "sent") {
      await reservations.updateOne(
        { _id },
        { $set: { "ticketEmail.status": "sent", "ticketEmail.resendId": outcome.resendId, "ticketEmail.at": new Date() } },
      );
      return;
    }
    const status = outcome.status === "retry" && doc.ticketEmail!.attempts < MAX_EMAIL_ATTEMPTS ? "retry" : "failed";
    console.error(`[mail] Bilet ${reservationId}: ${outcome.error} → ${status} (próba ${doc.ticketEmail!.attempts}).`);
    await reservations.updateOne(
      { _id },
      { $set: { "ticketEmail.status": status, "ticketEmail.lastError": outcome.error, "ticketEmail.at": new Date() } },
    );
  } catch (err) {
    console.error(`[mail] Nie udało się wysłać biletu ${reservationId}:`, err);
  }
}

/** Dzienny cron (i ponowienia): zaległe retry i przerwane sending. Zwraca liczbę wysłanych. */
export async function retryTicketEmails(): Promise<number> {
  const reservations = await reservationsCollection();
  const staleBefore = new Date(Date.now() - STALE_SENDING_MS);
  const pending = await reservations
    .find(
      {
        status: "paid",
        "ticketEmail.attempts": { $lt: MAX_EMAIL_ATTEMPTS },
        $or: [
          { "ticketEmail.status": "retry" },
          { "ticketEmail.status": "sending", "ticketEmail.at": { $lt: staleBefore } },
        ],
      },
      { projection: { _id: 1 } },
    )
    .limit(RETRY_BATCH)
    .toArray();

  let sent = 0;
  for (const { _id } of pending) {
    await sendTicketEmail(_id.toHexString());
    const after = await reservations.findOne({ _id }, { projection: { ticketEmail: 1 } });
    if (after?.ticketEmail?.status === "sent") sent++;
  }
  return sent;
}
