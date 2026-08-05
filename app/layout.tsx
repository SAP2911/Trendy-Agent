import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { THEME_INIT_SCRIPT } from '@/components/theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'Trendly Support Assistant',
  description: 'Agentic customer-support assistant for Trendly.',
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
