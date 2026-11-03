// Kody biletów (Z10) — bez bazy.
import { describe, expect, it } from "vitest";
import { CODE_ALPHABET, generateCode } from "@/lib/payments";
import { TICKET_CODE_REGEX } from "@/lib/types";

describe("generateCode", () => {
  it("alfabet ma 32 różne znaki bez 0, 1, I, O", () => {
    expect(new Set(CODE_ALPHABET).size).toBe(32);
    expect(CODE_ALPHABET).not.toMatch(/[01IO]/);
  });

  it("1000 kodów: wszystkie w formacie XXXX-XXXX i unikalne", () => {
    const codes = Array.from({ length: 1000 }, generateCode);
    for (const code of codes) expect(code).toMatch(TICKET_CODE_REGEX);
    expect(new Set(codes).size).toBe(1000);
  });

  it("losuje z całego alfabetu (każdy z 32 znaków pojawia się w 1000 kodach)", () => {
    const used = new Set(Array.from({ length: 1000 }, generateCode).join("").replaceAll("-", ""));
    expect([...used].sort().join("")).toBe([...CODE_ALPHABET].sort().join(""));
  });
});
