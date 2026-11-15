// app/layout.tsx — add the tag once, in the root layout.
import Script from "next/script";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Script
          src="{{TAG_URL}}"
          data-site-key={process.env.NEXT_PUBLIC_UHONEY_SITE_KEY}
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
