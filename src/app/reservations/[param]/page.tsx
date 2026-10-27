import { ReservationView } from "@/components/reservation/ReservationView";

export default async function ReservationPage({ params }: { params: Promise<{ param: string }> }) {
  const { param } = await params;
  return <ReservationView param={param} />;
}
