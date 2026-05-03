'use client'

/**
 * UIContext -- global state for UI overlays and notifications.
 *
 * Manages:
 *   byokDrawerOpen -- whether the BYOK settings drawer is visible
 *   toasts         -- queue of transient notification messages
 *
 * Both are stored in the root layout so they persist across route navigations
 * and can be triggered from any component in the tree.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useReducer,
  type ReactNode,
} from 'react'

// ---------------------------------------------------------------------------
// Toast types
// ---------------------------------------------------------------------------

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface Toast {
  id: string
  type: ToastType
  message: string
}

type ToastAction =
  | { type: 'ADD'; toast: Toast }
  | { type: 'DISMISS'; id: string }

function toastReducer(state: Toast[], action: ToastAction): Toast[] {
  switch (action.type) {
    case 'ADD':
      // Keep at most 3 toasts visible; drop oldest when the queue overflows
      return [...state, action.toast].slice(-3)
    case 'DISMISS':
      return state.filter(t => t.id !== action.id)
    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// Context type
// ---------------------------------------------------------------------------

interface UIContextValue {
  byokDrawerOpen: boolean
  openBYOKDrawer: () => void
  closeBYOKDrawer: () => void
  toasts: Toast[]
  /**
   * Add a toast notification. It auto-dismisses after `duration` ms
   * (default 4000). The returned id can be used to dismiss it early.
   */
  addToast: (type: ToastType, message: string, duration?: number) => string
  dismissToast: (id: string) => void
}

const UIContext = createContext<UIContextValue>({
  byokDrawerOpen: false,
  openBYOKDrawer:  () => {},
  closeBYOKDrawer: () => {},
  toasts:          [],
  addToast:        () => '',
  dismissToast:    () => {},
})

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function UIContextProvider({ children }: { children: ReactNode }) {
  const [byokDrawerOpen, setByokDrawerOpen] = useState(false)
  const [toasts, dispatch] = useReducer(toastReducer, [])

  const openBYOKDrawer  = useCallback(() => setByokDrawerOpen(true),  [])
  const closeBYOKDrawer = useCallback(() => setByokDrawerOpen(false), [])

  const dismissToast = useCallback((id: string) => {
    dispatch({ type: 'DISMISS', id })
  }, [])

  const addToast = useCallback(
    (type: ToastType, message: string, duration = 4000): string => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      dispatch({ type: 'ADD', toast: { id, type, message } })
      setTimeout(() => dispatch({ type: 'DISMISS', id }), duration)
      return id
    },
    []
  )

  return (
    <UIContext.Provider
      value={{
        byokDrawerOpen,
        openBYOKDrawer,
        closeBYOKDrawer,
        toasts,
        addToast,
        dismissToast,
      }}
    >
      {children}
    </UIContext.Provider>
  )
}

export function useUI() {
  return useContext(UIContext)
}
