// Klient Stripe (karta A, Kamil) — D11, Z32. Bez sieci: tylko konstrukcja klienta.
import { afterEach, describe, expect, it } from "vitest";
import { getStripe, PaymentUnavailableError } from "@/lib/stripe";

const ORIGINAL_KEY = process.env.STRIPE_SECRET_KEY;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
});

describe("getStripe()", () => {
  it.each([undefined, "", "   "])("brak klucza (%j) → PaymentUnavailableError", (key) => {
    if (key === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = key;
    expect(() => getStripe()).toThrow(PaymentUnavailableError);
  });

  it.each(["sk_live_abc123zz", "rk_live_abc123zz", "pk_test_abc123zz", "whsec_abc123zz"])(
    "klucz %j (nie sk_test_) → PaymentUnavailableError, klucz nie trafia do komunikatu",
    (key) => {
      process.env.STRIPE_SECRET_KEY = key;
      let error: unknown;
      try {
        getStripe();
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(PaymentUnavailableError);
      expect((error as Error).message).not.toContain("abc123zz");
    },
  );

  it("sk_test_ → jeden klient na proces, z ponowieniami", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_unit_only_not_real";
    const first = getStripe();
    expect(getStripe()).toBe(first);
    expect(first.getMaxNetworkRetries()).toBe(2);
  });

  it("zmiana klucza → nowy klient", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_unit_only_a";
    const a = getStripe();
    process.env.STRIPE_SECRET_KEY = "sk_test_unit_only_b";
    expect(getStripe()).not.toBe(a);
  });
});
