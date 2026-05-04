/**
 * Root layout -- wraps every page in the application.
 *
 * Responsibilities:
 *   - Defines the <html> and <body> shell
 *   - Loads the Inter typeface via next/font (zero layout shift)
 *   - Injects an inline script that applies the stored theme before React
 *     hydrates, preventing a flash of the wrong colour palette
 *   - Wraps all children in ThemeProvider and AudioManagerProvider
 *   - Sets default Open Graph metadata
 */

import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { ThemeProvider } from '@/components/ThemeProvider'
import { AudioManagerProvider } from '@/components/AudioManager'
import { UIContextProvider } from '@/context/UIContext'
import BYOKDrawer from '@/components/BYOKDrawer'
import ToastDisplay from '@/components/ToastDisplay'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  title: {
    default: 'RAGScope',
    template: '%s | RAGScope',
  },
  description: 'Ground truth for your retrieval pipeline. Benchmark four RAG strategies head to head using RAGAS metrics.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'),
  openGraph: {
    title: 'RAGScope',
    description: 'Ground truth for your retrieval pipeline.',
    type: 'website',
  },
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    /*
     * suppressHydrationWarning is required because the inline script below
     * sets data-theme before React mounts, so the attribute React sees during
     * hydration may differ from the server-rendered attribute. Suppressing the
     * warning on <html> is the recommended pattern for theme systems.
     */
    <html lang="en" suppressHydrationWarning className={inter.variable}>
      <head>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        {/*
         * This script runs synchronously before any CSS or React code.
         * It reads the stored theme from localStorage and sets data-theme
         * on <html> immediately, so the correct palette is applied before
         * the first paint - no flash of dark-on-light or light-on-dark.
         */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var stored = localStorage.getItem('ragscope_theme') || 'light';
                  var resolved = stored;
                  if (stored === 'system') {
                    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches
                      ? 'dark' : 'light';
                  }
                  document.documentElement.setAttribute('data-theme', resolved);
                } catch (e) {
                  document.documentElement.setAttribute('data-theme', 'dark');
                }
              })();
            `,
          }}
        />
      </head>
      <body className="antialiased">
        <ThemeProvider>
          <AudioManagerProvider>
            <UIContextProvider>
              {children}
              {/* BYOKDrawer lives at root so it is reachable from nav, modals,
                  and any page without prop-drilling a drawer open/close callback. */}
              <BYOKDrawer />
              <ToastDisplay />
            </UIContextProvider>
          </AudioManagerProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
