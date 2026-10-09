import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Recipe to basket",
  description: "Photograph a recipe, buy only the missing ingredients.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
