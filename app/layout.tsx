import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Zora — temporary file sharing",
  description:
    "Share small files with a direct link. Up to 10 MB, automatically expires in 10 days.",
  robots: { index: false, follow: false },
  other: { "page-type": "software", "site-kind": "software" },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-type="software" data-radius="soft">
      <body>{children}</body>
    </html>
  );
}
