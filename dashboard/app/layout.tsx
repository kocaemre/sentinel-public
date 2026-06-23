import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sentinel — Live Security Dashboard",
  description:
    "Sentinel is a security proxy that protects autonomous paying AI agents from x402 attacks. Payments screened, attacks blocked, and USDC protected — live.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
