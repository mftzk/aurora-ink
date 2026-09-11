import "./globals.css";

export const metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: "Aurora Ink",
  description: "A calm generative aurora of liquid ink, soft nebula and slow light trails.",
  applicationName: "Aurora Ink",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#05070c",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
