import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sentinel — Canlı Güvenlik Paneli",
  description:
    "Sentinel: otonom ödeme yapan AI ajanlarını x402 saldırılarına karşı koruyan güvenlik proxy'si. Taranan ödemeler, bloklanan saldırılar ve korunan USDC canlı.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
