import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SiteNav } from "@/components/site-nav";
import { SiteFooter } from "@/components/site-footer";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "KeyLehr H2H",
    template: "%s · KeyLehr H2H",
  },
  description:
    "KeyLehr H2H — a 32-owner head-to-head Daily Fantasy Football league. Each owner plays their NFL team's schedule; weekly scores come from their DraftKings lineup. Standings, playoff picture, and league history.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="relative flex min-h-full flex-col bg-background text-foreground">
        {/* Decorative stadium backdrop — anchored to the top of the viewport and
            faded into the page background so content stays readable. Most visible
            behind the hero; dissolves to the solid background lower down. */}
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
        >
          {/* The image is inset from every edge and feathered with a radial mask so
              it floats like a painting rather than bleeding to the screen edges. */}
          <div className="absolute inset-x-[8%] top-[6%] h-[72vh] bg-[url('/stadium.jpg')] bg-cover bg-top opacity-25 dark:opacity-40 [mask-image:radial-gradient(ellipse_62%_58%_at_50%_38%,_#000_22%,_transparent_72%)] [-webkit-mask-image:radial-gradient(ellipse_62%_58%_at_50%_38%,_#000_22%,_transparent_72%)]" />
          <div className="absolute inset-0 bg-gradient-to-b from-background/45 via-background/80 to-background" />
        </div>
        <SiteNav />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
