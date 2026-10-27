// RESERVATION_TTL_SECONDS (Z17) — bez bazy.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DEFAULT_RESERVATION_TTL_SECONDS, getReservationTtlSeconds } from "@/lib/config";

describe("getReservationTtlSeconds", () => {
  const original = process.env.RESERVATION_TTL_SECONDS;
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (original === undefined) delete process.env.RESERVATION_TTL_SECONDS;
    else process.env.RESERVATION_TTL_SECONDS = original;
    warn.mockRestore();
  });

  it("brak zmiennej → 900 bez ostrzeżenia", () => {
    delete process.env.RESERVATION_TTL_SECONDS;
    expect(getReservationTtlSeconds()).toBe(DEFAULT_RESERVATION_TTL_SECONDS);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["120", 120],
    ["900", 900],
    ["1", 1],
    [" 30 ", 30],
    ["86400", 86400],
  ])("poprawna wartość %j → %d", (raw, expected) => {
    process.env.RESERVATION_TTL_SECONDS = raw;
    expect(getReservationTtlSeconds()).toBe(expected);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["0", "-5", "abc", "1.5", "1e3", "0x10", "12abc", "86401", "99999999999999999999", "Infinity", "NaN"])(
    "zła wartość %j → 900 + ostrzeżenie",
    (raw) => {
      process.env.RESERVATION_TTL_SECONDS = raw;
      expect(getReservationTtlSeconds()).toBe(DEFAULT_RESERVATION_TTL_SECONDS);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it("ostrzega tylko raz dla tej samej złej wartości", () => {
    process.env.RESERVATION_TTL_SECONDS = "raz-tylko";
    for (let i = 0; i < 5; i++) getReservationTtlSeconds();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("czyta env przy każdym wywołaniu, nie przy imporcie", () => {
    process.env.RESERVATION_TTL_SECONDS = "2";
    expect(getReservationTtlSeconds()).toBe(2);
    process.env.RESERVATION_TTL_SECONDS = "120";
    expect(getReservationTtlSeconds()).toBe(120);
  });
});
