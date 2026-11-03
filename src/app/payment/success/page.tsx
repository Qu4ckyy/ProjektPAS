import type { Metadata } from "next";
import { Suspense } from "react";
import { PaymentReturn } from "@/components/payment/PaymentReturn";

export const metadata: Metadata = { title: "Płatność w toku" };

export default function PaymentSuccessPage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="text-neutral-600">
          Ładowanie…
        </p>
      }
    >
      <PaymentReturn mode="success" />
    </Suspense>
  );
}
