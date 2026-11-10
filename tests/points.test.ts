import { describe, expect, it } from "vitest";
import { WELCOME_POINTS, formatPoints, maxPointsFor, pointsEarnedFor } from "@/lib/points";

describe("points (CONTRACT.md §3 [E3])", () => {
  it("najwięcej punktów to połowa ceny w dół", () => {
    expect(maxPointsFor(8900)).toBe(4450);
    expect(maxPointsFor(5900)).toBe(2950);
    expect(maxPointsFor(12900)).toBe(6450);
    expect(maxPointsFor(1)).toBe(0);
  });

  it("punkty za zakup tylko od pełnych złotych zapłaconych kartą (Z42)", () => {
    expect(pointsEarnedFor(7900)).toBe(790);
    expect(pointsEarnedFor(8900)).toBe(890);
    expect(pointsEarnedFor(4450)).toBe(440);
    expect(pointsEarnedFor(99)).toBe(0);
    expect(pointsEarnedFor(0)).toBe(0);
  });

  it("przykład z PDF: nowy klient wydaje 1000 pkt na bilet za 89 zł", () => {
    const cardAmount = 8900 - WELCOME_POINTS;
    expect(cardAmount).toBe(7900);
    expect(pointsEarnedFor(cardAmount)).toBe(790);
  });

  it("formatPoints", () => {
    expect(formatPoints(1000)).toBe("1000 pkt");
  });
});
