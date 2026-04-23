import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Futures Monitor",
  description: "Realtime dashboard for multi-exchange futures positions, PnL and risk",
  openGraph: {
    title: "Futures Monitor",
    description: "Realtime dashboard for multi-exchange futures positions, PnL and risk",
    url: "https://nothenndii-diary.vercel.app",
    siteName: "Futures Monitor",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Futures Monitor",
    description: "Realtime dashboard for multi-exchange futures positions, PnL and risk",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} min-h-full antialiased`}
    >
      <body className="min-h-full overflow-x-clip">{children}</body>
    </html>
  );
}
