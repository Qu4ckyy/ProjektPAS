import type { Metadata } from "next";
import { Suspense } from "react";
import { PaymentReturn } from "@/components/payment/PaymentReturn";

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
      <PaymentReturn mode="cancel" />
    </Suspense>
  );
}
