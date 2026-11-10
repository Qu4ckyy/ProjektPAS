// Konto punktowe klienta (karta A) — CONTRACT.md §0a D12–D14, D17, D18, D20, §3, §6. Właściciel: Eryk.
// STUB — implementuje Eryk: pamięć podręczna i blokady w loyalty_members, zwroty punktów (settleLoyalty),
// ponowienia, sprawdzanie transakcji po reason. Ta wersja jest prosta, ale poprawna dla providera "memory".
import { ObjectId, type Collection } from "mongodb";
import { getDb, RESERVATIONS_COLLECTION } from "@/lib/db";
import { WELCOME_POINTS } from "@/lib/points";
import type { Reservation } from "@/lib/types";
import { getLoyaltyClient, type MemberRef } from "@/lib/voucherify";

export type ApplyPointsResult = "done" | "rejected" | "retry";

async function reservationsCollection(): Promise<Collection<Reservation>> {
  return (await getDb()).collection<Reservation>(RESERVATIONS_COLLECTION);
}

/** Klient = e-mail po trim i małymi literami (D13). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Saldo dla GET /api/loyalty i podpowiedzi punktów: najpierw zaległe zwroty (D17), potem saldo. */
export async function getPoints(email: string): Promise<number> {
  const normalized = normalizeEmail(email);
  await settleLoyalty({ email: normalized });
  return getFreshBalance(normalized);
}

/** Saldo prosto z Voucherify; e-mail bez karty ma 1000 i karty NIE zakładamy (D14). */
export async function getFreshBalance(email: string): Promise<number> {
  const member = await getLoyaltyClient().findMember(normalizeEmail(email));
  return member ? member.balance : WELCOME_POINTS;
}

/** Członek programu z kartą; nowy dostaje 1000 punktów powitalnych dokładnie raz (Z51). */
export async function ensureMember(email: string): Promise<MemberRef> {
  const client = getLoyaltyClient();
  const normalized = normalizeEmail(email);
  const member = await client.createMember(normalized);
  if (member.created) {
    await client.addPoints(member.memberId, member.cardId, WELCOME_POINTS, `welcome-${normalized}`);
  }
  return { memberId: member.memberId, cardId: member.cardId };
}

/**
 * Zmiana punktów z unikalnym reason (spend-<id>, refund-<id>, earn-<id>). waitForApproval: pobranie
 * liczy się dopiero po APPROVED (Z55). STUB: bez sprawdzania po reason przed ponowieniem.
 */
export async function applyPoints(
  email: string,
  points: number,
  reason: string,
  options: { waitForApproval: boolean },
): Promise<ApplyPointsResult> {
  const client = getLoyaltyClient();
  const { memberId, cardId } = await ensureMember(email);
  const { transactionId } = await client.addPoints(memberId, cardId, points, reason);
  if (!options.waitForApproval) return "done";
  const { status } = await client.getTransaction(memberId, cardId, transactionId);
  if (status === "APPROVED") return "done";
  if (status === "REJECTED") return "rejected";
  return "retry";
}

/** Blokada wydawania punktów tego e-maila na 15 s (Z36). STUB: zawsze się udaje. */
export async function acquireSpendLock(email: string): Promise<boolean> {
  void email;
  return true;
}

export async function releaseSpendLock(email: string): Promise<void> {
  void email;
}

/** Zwrot punktów za nieopłacone rezerwacje (D17, Z39, Z40). STUB — implementuje Eryk. */
export async function settleLoyalty(target: { reservationId: string } | { email: string }): Promise<void> {
  void target;
}

/**
 * Naliczenie pointsEarned po opłaceniu (D18). Woła je ten, kto przyjął płatność (acceptPayment ustawił
 * earn: pending). STUB: bez zajęcia kroku dla ponowień — implementuje Eryk.
 */
export async function earnForPurchase(reservationId: string): Promise<void> {
  const reservations = await reservationsCollection();
  const _id = new ObjectId(reservationId);
  const doc = await reservations.findOne({ _id, status: "paid", "loyalty.earn.status": "pending" });
  if (!doc) return;
  const points = doc.pointsEarned ?? 0;
  const result = points > 0 ? await applyPoints(doc.email, points, `earn-${reservationId}`, { waitForApproval: false }) : "done";
  await reservations.updateOne(
    { _id, "loyalty.earn.status": "pending" },
    { $set: { "loyalty.earn.status": result === "done" ? "done" : "retry", "loyalty.earn.at": new Date() } },
  );
}

/** Dzienny cron: zaległe zwroty i naliczenia. STUB — implementuje Eryk. */
export async function runLoyaltyRetries(): Promise<{ refunded: number; earned: number }> {
  return { refunded: 0, earned: 0 };
}
