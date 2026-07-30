import type { Metadata } from "next";
import { Inter, Cairo } from "next/font/google";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { SplashScreen } from "@/components/layout/splash-screen";
import "../globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const cairo = Cairo({ variable: "--font-cairo", subsets: ["arabic", "latin"] });

export const metadata: Metadata = {
  title: "FILEX — Showroom Capital & Deal Management",
  description: "Automotive showroom capital, inventory, and deal management system.",
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  const dir = locale === "ar" ? "rtl" : "ltr";

  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <body className={`${inter.variable} ${cairo.variable} antialiased`}>
        <NextIntlClientProvider>
          <SplashScreen>{children}</SplashScreen>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
