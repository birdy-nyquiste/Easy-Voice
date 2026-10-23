import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter, Roboto_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { BCP47 } from "@/i18n/locales";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// Geist has no Vietnamese glyphs, and falling back per letter mixes typefaces mid-word, so Vietnamese
// pages use Inter throughout. Not preloaded: other languages never download it.
const vietnameseSans = Inter({ variable: "--font-vietnamese-sans", subsets: ["latin", "vietnamese"], preload: false });
// The same for monospace (the instructions field): Geist Mono has no Vietnamese subset either.
const vietnameseMono = Roboto_Mono({ variable: "--font-vietnamese-mono", subsets: ["latin", "vietnamese"], preload: false });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  // Pages set their own title, so tabs and history tell them apart, and screen readers announce a
  // client navigation (Next only does so when the title changes).
  return { title: { template: "%s · Easy Voice", default: "Easy Voice" }, description: t("description") };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await getLocale();
  return (
    <html lang={BCP47[locale]}>
      <body className={`${geistSans.variable} ${geistMono.variable} ${locale === "vi" ? `${vietnameseSans.variable} ${vietnameseMono.variable}` : ""} font-sans`}>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
