import type { Metadata } from "next";
import { Suspense } from "react";
import { ReserveForm } from "@/components/reservation/ReserveForm";

export const metadata: Metadata = { title: "Rezerwacja miejsca" };

export default function ReservePage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="text-neutral-600">
          Ładowanie…
        </p>
      }
    >
      <ReserveForm />
    </Suspense>
  );
}
