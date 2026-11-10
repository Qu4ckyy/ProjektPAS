// Podsumowanie płatności na bilecie (karta C — frontend, CONTRACT.md §5 [E3]): ile kartą, ile punktami, ile zebrano.
import { formatPrice } from "@/lib/format";
import { formatPoints } from "@/lib/points";

type Props = { cardAmount: number; pointsUsed: number; pointsEarned: number };

export function PaymentSummary({ cardAmount, pointsUsed, pointsEarned }: Props) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-neutral-50 px-4 py-3 text-sm print:bg-white">
      <dt className="text-neutral-600">Zapłacono kartą</dt>
      <dd className="text-right font-semibold text-neutral-900">{formatPrice(cardAmount)}</dd>
      {pointsUsed > 0 && (
        <>
          <dt className="text-neutral-600">Zapłacono punktami</dt>
          <dd className="text-right font-semibold text-neutral-900">
            {formatPoints(pointsUsed)} ({formatPrice(pointsUsed)})
          </dd>
        </>
      )}
      <dt className="text-neutral-600">Zebrane punkty</dt>
      <dd className="text-right font-semibold text-emerald-800">+{formatPoints(pointsEarned)}</dd>
    </dl>
  );
}
