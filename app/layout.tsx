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
  title: "Database Architect & Schema Visualizer",
  description: "Visualiza esquemas DDL relacionales de PostgreSQL en tiempo real",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable} h-full w-full antialiased`}
      suppressHydrationWarning
    >
      <body className="h-full w-full bg-background overflow-hidden m-0 p-0 font-sans">
        {children}
      </body>
    </html>
  );
}