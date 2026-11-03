import type { Metadata } from "next";
import Link from "next/link";
import { COMPANY_NAME, COMPANY_TAGLINE, Wordmark } from "@/components/brand/Logo";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: `${COMPANY_NAME} — ${COMPANY_TAGLINE}`, template: `%s · ${COMPANY_NAME}` },
  description: "Rezerwacja i zakup miejsc w pociągach: wybierz kurs, miejsce w wagonie i odbierz bilet z kodem.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pl">
      <body className="flex min-h-screen flex-col antialiased">
        <header className="border-b border-neutral-200 bg-white print:hidden">
          <div className="mx-auto flex max-w-4xl items-center px-4 py-3">
            <Link
              href="/"
              aria-label={`${COMPANY_NAME} — rozkład jazdy`}
              className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-neutral-900"
            >
              <Wordmark />
            </Link>
          </div>
        </header>
        <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">{children}</main>
        <footer className="border-t border-neutral-200 py-4 text-center text-xs text-neutral-500 print:hidden">
          {COMPANY_NAME} · bilet zawsze na całą trasę · płatności obsługuje Stripe (tryb testowy)
        </footer>
      </body>
    </html>
  );
}
