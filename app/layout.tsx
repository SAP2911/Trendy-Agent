import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { THEME_INIT_SCRIPT } from '@/components/theme';
import './globals.css';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

const DESCRIPTION =
  'Agentic customer-support assistant for Trendly. Deterministic policy engine, '
  + 'real tool-calling, and a live reasoning trace — every answer grounded in the '
  + 'shipping and returns policy.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Trendly Support Assistant',
  description: DESCRIPTION,
  applicationName: 'Trendly Support Assistant',
  openGraph: {
    type: 'website',
    siteName: 'Trendly Support Assistant',
    title: 'Trendly Support Assistant',
    description: DESCRIPTION,
    url: SITE_URL,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trendly Support Assistant',
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf9f7' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1917' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/*
          Runs synchronously, before <body> paints, so the correct theme is
          applied on the very first frame — this is what prevents a flash of
          the wrong theme when the stored preference (or the OS) is dark.
          See components/theme.ts for the shared logic ThemeToggle.tsx uses
          after hydration.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
