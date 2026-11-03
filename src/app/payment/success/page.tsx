import type { Metadata } from "next";
import { Suspense } from "react";
import { PaymentSuccess } from "@/components/payment/PaymentSuccess";

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
      <PaymentSuccess />
    </Suspense>
  );
}
