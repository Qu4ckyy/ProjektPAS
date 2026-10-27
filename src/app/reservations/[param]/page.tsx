import type { Metadata } from "next";
import { ReservationView } from "@/components/reservation/ReservationView";

export const metadata: Metadata = { title: "Twoja rezerwacja" };

export default async function ReservationPage({ params }: { params: Promise<{ param: string }> }) {
  const { param } = await params;
  return <ReservationView param={param} />;
}
