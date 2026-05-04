'use client'

/**
 * Global navigation bar.
 *
 * Used on both the landing page and the docs page. Becomes translucent with a
 * backdrop blur on scroll to keep content readable without covering it.
 * Exposes: theme toggle (dark / light / system), audio toggle, GitHub link,
 * and a Docs navigation link.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTheme } from '@/components/ThemeProvider'
import { useAudio } from '@/components/AudioManager'
import { useUI } from '@/context/UIContext'
import {
  Moon,
  Sun,
  Monitor,
  Music,
  Volume1,
  VolumeX,
  Github,
  BookOpen,
  Settings,
} from 'lucide-react'
import type { AudioLevel } from '@/components/AudioManager'

export default function Nav() {
  const { theme, setTheme } = useTheme()
  const { audioLevel, cycleAudio } = useAudio()
  const { openBYOKDrawer } = useUI()
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Cycle: dark -> light -> system -> dark
  const cycleTheme = () => {
    if (theme === 'dark') setTheme('light')
    else if (theme === 'light') setTheme('system')
    else setTheme('dark')
  }

  const ThemeIcon =
    theme === 'light' ? Sun : theme === 'system' ? Monitor : Moon

  const themeLabel =
    theme === 'light'
      ? 'Switch to system theme'
      : theme === 'system'
      ? 'Switch to dark theme'
      : 'Switch to light theme'

  return (
    <nav
      className={[
        'fixed top-0 left-0 right-0 z-50 transition-all duration-300',
        scrolled
          ? 'bg-background/80 backdrop-blur-md border-b border-border/50'
          : 'bg-transparent',
      ].join(' ')}
    >
      <div className="max-w-[1400px] mx-auto px-8 2xl:px-16 h-16 flex items-center justify-between">
        {/* Logo */}
        <Link
          href="/"
          className="flex items-center gap-2 group"
          aria-label="RAGScope home"
        >
          {/* Accent circle mark */}
          <span
            className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-black"
            style={{ background: 'var(--color-accent)', color: '#000' }}
            aria-hidden="true"
          >
            R
          </span>
          <span className="text-text-primary font-semibold text-base tracking-tight group-hover:text-accent transition-colors">
            RAGScope
          </span>
        </Link>

        {/* Right controls */}
        <div className="flex items-center gap-2">
          <Link
            href="/docs"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-text-secondary hover:text-text-primary text-sm font-medium transition-colors"
            aria-label="Documentation"
          >
            <BookOpen size={15} aria-hidden="true" />
            <span className="hidden sm:inline">Docs</span>
          </Link>

          <button
            onClick={openBYOKDrawer}
            className="p-2 rounded-lg text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Open API key settings"
          >
            <Settings size={18} aria-hidden="true" />
          </button>

          <a
            href="https://github.com/imtiazx/ragscope"
            target="_blank"
            rel="noopener noreferrer"
            className="p-2 rounded-lg text-text-secondary hover:text-text-primary transition-colors"
            aria-label="View source on GitHub"
          >
            <Github size={18} aria-hidden="true" />
          </a>

          <button
            onClick={cycleTheme}
            className="p-2 rounded-lg text-text-secondary hover:text-text-primary transition-colors"
            aria-label={themeLabel}
          >
            <ThemeIcon size={18} aria-hidden="true" />
          </button>

          <button
            onClick={cycleAudio}
            className="p-2 rounded-lg text-text-secondary hover:text-text-primary transition-colors"
            aria-label={
              audioLevel === 2
                ? 'Audio: music + clicks on. Click to mute clicks (keep music)'
                : audioLevel === 1
                ? 'Audio: click sounds on. Click to mute everything'
                : 'Audio: muted. Click to enable music + sounds'
            }
          >
            {audioLevel === 2 ? (
              // Level 2: music + clicks -- music note icon
              <Music size={18} aria-hidden="true" />
            ) : audioLevel === 1 ? (
              // Level 1: clicks only -- single wave speaker
              <Volume1 size={18} aria-hidden="true" />
            ) : (
              // Level 0: everything off -- muted speaker
              <VolumeX size={18} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </nav>
  )
}
