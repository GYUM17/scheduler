import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Meet Grid",
  description: "Drag to mark availability and find common meeting times.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
