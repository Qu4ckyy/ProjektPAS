import type { Metadata } from "next";
import Link from "next/link";
import { COMPANY_NAME, Logo } from "@/components/brand/Logo";
import "./globals.css";

export const metadata: Metadata = {
  title: COMPANY_NAME,
  description: "Rezerwacja miejsc w pociągach",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pl">
      <body className="min-h-screen antialiased">
        <header className="border-b border-neutral-200">
          <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3">
            <Link href="/" className="flex items-center gap-3 font-semibold">
              <Logo />
              {COMPANY_NAME}
            </Link>
          </div>
        </header>
        <main className="mx-auto max-w-4xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
