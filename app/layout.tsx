import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Caregiver Monitor | SereniSound",
  description: "Live location and wellness status for the SereniSound wearable.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
