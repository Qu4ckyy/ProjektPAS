// Walidacja pól formularza po stronie klienta — te same reguły co serwer (src/lib/validation.ts).
// Przy wysyłce i tak sprawdzamy całość przez validateReservationBody, a serwer ma ostatnie słowo.
import { FIELD_LIMITS } from "@/lib/validation";

// Kopia EMAIL_REGEX z src/lib/validation.ts (tam nie jest eksportowany) — zmieniaj oba naraz.
const EMAIL_REGEX =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/;

const CONTROL_CHARS = /\p{Cc}/u;

export type FormFields = { customerName: string; email: string };
export type FieldErrors = Partial<Record<keyof FormFields, string>>;

export function validateCustomerName(value: string): string | undefined {
  const name = value.trim();
  if (name === "") return "Podaj imię i nazwisko.";
  if (name.length > FIELD_LIMITS.customerName) {
    return `Imię i nazwisko może mieć najwyżej ${FIELD_LIMITS.customerName} znaków.`;
  }
  if (CONTROL_CHARS.test(name)) return "Imię i nazwisko zawiera niedozwolone znaki.";
  return undefined;
}

export function validateEmail(value: string): string | undefined {
  const email = value.trim();
  if (email === "") return "Podaj adres e-mail.";
  if (email.length > FIELD_LIMITS.email) return `Adres e-mail może mieć najwyżej ${FIELD_LIMITS.email} znaki.`;
  if (!EMAIL_REGEX.test(email)) return "Podaj poprawny adres e-mail, np. jan.kowalski@poczta.pl.";
  return undefined;
}

export function validateFields(fields: FormFields): FieldErrors {
  const errors: FieldErrors = {};
  const name = validateCustomerName(fields.customerName);
  const email = validateEmail(fields.email);
  if (name) errors.customerName = name;
  if (email) errors.email = email;
  return errors;
}
