import { seatPosition, toSeatId, wagonRows } from "@/lib/seats";
import type { Wagon as WagonType } from "@/lib/types";

type Props = {
  wagon: WagonType;
  taken: Set<string>;
  disabled: boolean;
  onSelect: (seatId: string) => void;
};

/** Wagon narysowany jak w pociągu: układ 2+2, korytarz pośrodku, okna po bokach. */
export function Wagon({ wagon, taken, disabled, onSelect }: Props) {
  return (
    <div className="mx-auto w-full max-w-xs">
      <div className="mb-2 flex items-center justify-center gap-2 text-xs font-medium text-neutral-500">
        <span aria-hidden>▲</span> Kierunek jazdy
      </div>
      <div
        role="group"
        aria-label={`Wagon ${wagon.number}`}
        className="rounded-t-[2.5rem] rounded-b-2xl border-4 border-neutral-300 bg-neutral-50 px-3 pt-8 pb-4"
      >
        <div className="space-y-2">
          {wagonRows(wagon).map(([left, right], i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_1.25rem_1fr_1fr] items-center gap-2">
              {left.map((n) => (
                <Seat key={n} wagon={wagon.number} seat={n} taken={taken} disabled={disabled} onSelect={onSelect} />
              ))}
              {left.length < 2 && <span />}
              <span aria-hidden className="h-full border-x border-dashed border-neutral-200" />
              {right.map((n) => (
                <Seat key={n} wagon={wagon.number} seat={n} taken={taken} disabled={disabled} onSelect={onSelect} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type SeatProps = {
  wagon: number;
  seat: number;
  taken: Set<string>;
  disabled: boolean;
  onSelect: (seatId: string) => void;
};

function Seat({ wagon, seat, taken, disabled, onSelect }: SeatProps) {
  const seatId = toSeatId(wagon, seat);
  const isTaken = taken.has(seatId);
  const position = seatPosition(seat);
  const unavailable = isTaken || disabled;
  const label = `Wagon ${wagon}, miejsce ${seat}, ${position === "window" ? "okno" : "korytarz"}, ${
    isTaken ? "zajęte" : "wolne"
  }`;
  // Okno po zewnętrznej stronie: lewa para → okno z lewej, prawa para → okno z prawej.
  const windowSide =
    seat % 4 === 1 ? "border-l-4 border-l-sky-400" : seat % 4 === 0 ? "border-r-4 border-r-sky-400" : "";

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={unavailable}
      onClick={() => onSelect(seatId)}
      className={[
        "relative flex aspect-square items-center justify-center rounded-md border-2 text-sm font-semibold tabular-nums transition",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900",
        windowSide,
        isTaken
          ? "cursor-not-allowed border-neutral-200 bg-neutral-200 text-neutral-400 line-through"
          : disabled
            ? "cursor-not-allowed border-neutral-300 bg-white text-neutral-500"
            : "cursor-pointer border-emerald-500 bg-white text-emerald-800 hover:bg-emerald-50 active:bg-emerald-100",
      ].join(" ")}
    >
      {seat}
    </button>
  );
}
