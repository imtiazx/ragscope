'use client'

/**
 * ThemeProvider -- manages dark / light / system theme preference.
 *
 * Reads the initial value from localStorage on mount so the theme persists
 * across page refreshes. Falls back to 'dark' if nothing is stored.
 *
 * Applies the resolved theme as a data-theme attribute on <html> so CSS
 * variables defined in globals.css switch automatically. The ThemeProvider
 * does NOT cause a flash of wrong theme because layout.tsx injects a small
 * inline script that sets the attribute synchronously before React hydrates.
 */

import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import type { ReactNode } from 'react'

type ThemeMode = 'dark' | 'light' | 'system'
type ResolvedTheme = 'dark' | 'light'

interface ThemeContextValue {
  /** The user's explicit choice: dark, light, or follow-system. */
  theme: ThemeMode
  /** The actual rendered theme after resolving 'system'. */
  resolvedTheme: ResolvedTheme
  /** Update the stored preference and reapply immediately. */
  setTheme: (theme: ThemeMode) => void
}

const STORAGE_KEY = 'ragscope_theme'
const DEFAULT_THEME: ThemeMode = 'light'

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  resolvedTheme: 'light',
  setTheme: () => {},
})

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') {
    return typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }
  return mode
}

function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.setAttribute('data-theme', resolved)
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(DEFAULT_THEME)
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>('light')

  // Hydrate from localStorage on first render
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemeMode | null
    const initial: ThemeMode =
      stored && ['dark', 'light', 'system'].includes(stored) ? stored : DEFAULT_THEME
    const resolved = resolveTheme(initial)
    setThemeState(initial)
    setResolvedTheme(resolved)
    applyTheme(resolved)
  }, [])

  // Re-apply whenever the user's choice changes and watch system preference
  useEffect(() => {
    const resolved = resolveTheme(theme)
    setResolvedTheme(resolved)
    applyTheme(resolved)
    localStorage.setItem(STORAGE_KEY, theme)

    if (theme !== 'system') return

    // When 'system' is selected, track changes to the OS preference
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => {
      const r: ResolvedTheme = e.matches ? 'dark' : 'light'
      setResolvedTheme(r)
      applyTheme(r)
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  const setTheme = useCallback((t: ThemeMode) => setThemeState(t), [])

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
