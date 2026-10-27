import { Suspense } from "react";
import { ReserveForm } from "@/components/reservation/ReserveForm";

export default function ReservePage() {
  return (
    <Suspense fallback={<p>Ładowanie…</p>}>
      <ReserveForm />
    </Suspense>
  );
}
