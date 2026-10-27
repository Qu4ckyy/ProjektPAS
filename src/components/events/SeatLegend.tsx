export function SeatLegend() {
  return (
    <ul className="flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-neutral-700">
      <li className="flex items-center gap-2">
        <span aria-hidden className="h-5 w-5 rounded border-2 border-emerald-500 bg-white" />
        wolne
      </li>
      <li className="flex items-center gap-2">
        <span aria-hidden className="h-5 w-5 rounded border-2 border-neutral-200 bg-neutral-200" />
        zajęte
      </li>
      <li className="flex items-center gap-2">
        <span aria-hidden className="h-5 w-5 rounded border-2 border-l-4 border-neutral-300 border-l-sky-400 bg-white" />
        przy oknie
      </li>
      <li className="flex items-center gap-2">
        <span aria-hidden className="h-5 w-5 rounded border-2 border-neutral-300 bg-white" />
        przy korytarzu
      </li>
    </ul>
  );
}
