// Mail z biletem przez Resend (karta C) — CONTRACT.md §0a D19, D21, §3 „Mail z biletem”, Z46–Z48. Właściciel: Mateusz.
// STUB — implementuje Mateusz (M2): provider "resend", treść HTML, ponowienia. Provider "log" działa.
import { ObjectId, type Collection } from "mongodb";
import { getDb, RESERVATIONS_COLLECTION } from "@/lib/db";
import { formatPrice } from "@/lib/format";
import { formatPoints } from "@/lib/points";
import type { Reservation } from "@/lib/types";

export type MailProvider = "resend" | "log";

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

/** Mail z biletem dla opłaconej rezerwacji — raz (Z46). Nigdy nie rzuca: bilet działa bez maila (Z47). */
export async function sendTicketEmail(reservationId: string): Promise<void> {
  try {
    const reservations = await reservationsCollection();
    const _id = new ObjectId(reservationId);
    // Atomowe zajęcie: tylko jeden wysyłający.
    const doc = await reservations.findOneAndUpdate(
      {
        _id,
        status: "paid",
        $or: [{ ticketEmail: { $exists: false } }, { "ticketEmail.status": "retry" }],
      },
      { $set: { "ticketEmail.status": "sending", "ticketEmail.at": new Date() }, $inc: { "ticketEmail.attempts": 1 } },
      { returnDocument: "after" },
    );
    if (!doc?.code) return;

    if (mailProvider() === "log") {
      const pointsUsed = doc.pointsUsed ?? 0;
      console.log(
        `[mail] (log) do ${doc.email}: Bilet ${doc.code} — kartą ${formatPrice(doc.cardAmount ?? doc.amount)}` +
          (pointsUsed > 0 ? `, punktami ${formatPoints(pointsUsed)}` : "") +
          `, zebrane punkty: ${doc.pointsEarned ?? 0}`,
      );
      await reservations.updateOne({ _id }, { $set: { "ticketEmail.status": "sent", "ticketEmail.resendId": "log" } });
      return;
    }

    // STUB — implementuje Mateusz (M2): POST https://api.resend.com/emails z Idempotency-Key ticket-<id>.
    await reservations.updateOne(
      { _id },
      { $set: { "ticketEmail.status": "failed", "ticketEmail.lastError": "Resend jeszcze niepodłączony (STUB)" } },
    );
  } catch (err) {
    console.error(`[mail] Nie udało się wysłać biletu ${reservationId}:`, err);
  }
}

/** Dzienny cron: zaległe maile. STUB — implementuje Mateusz (M2). */
export async function retryTicketEmails(): Promise<number> {
  return 0;
}
