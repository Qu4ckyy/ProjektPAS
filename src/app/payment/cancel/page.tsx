import type { Metadata } from "next";
import { Suspense } from "react";
import { PaymentCancel } from "@/components/payment/PaymentCancel";

export const metadata: Metadata = { title: "Płatność przerwana" };

export default function PaymentCancelPage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="text-neutral-600">
          Ładowanie…
        </p>
      }
    >
      <PaymentCancel />
    </Suspense>
  );
}
