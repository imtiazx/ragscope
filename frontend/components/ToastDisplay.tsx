'use client'

/**
 * ToastDisplay -- renders the global toast notification queue.
 *
 * Fixed to the bottom-right of the viewport. Reads from UIContext so any
 * component can call addToast() without knowing about the display layer.
 * Each toast slides in from the right and fades out on dismiss or auto-timeout.
 */

import { AnimatePresence, motion } from 'framer-motion'
import { X, CheckCircle2, AlertCircle, Info, AlertTriangle, type LucideProps } from 'lucide-react'
import { useUI, type ToastType } from '@/context/UIContext'

type LucideIcon = React.ForwardRefExoticComponent<
  Omit<LucideProps, 'ref'> & React.RefAttributes<SVGSVGElement>
>

const TOAST_STYLES: Record<ToastType, {
  bg: string
  border: string
  icon: LucideIcon
  iconColor: string
}> = {
  success: {
    bg:        'rgba(74,222,128,0.08)',
    border:    'rgba(74,222,128,0.25)',
    icon:      CheckCircle2,
    iconColor: '#4ADE80',
  },
  error: {
    bg:        'rgba(255,107,107,0.08)',
    border:    'rgba(255,107,107,0.25)',
    icon:      AlertCircle,
    iconColor: '#FF6B6B',
  },
  info: {
    bg:        'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.08)',
    border:    'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.25)',
    icon:      Info,
    iconColor: 'var(--color-accent)',
  },
  warning: {
    bg:        'rgba(255,179,71,0.08)',
    border:    'rgba(255,179,71,0.25)',
    icon:      AlertTriangle,
    iconColor: '#FFB347',
  },
}

export default function ToastDisplay() {
  const { toasts, dismissToast } = useUI()

  return (
    <div
      className="fixed bottom-6 right-6 z-[200] flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-atomic="false"
      role="region"
      aria-label="Notifications"
    >
      <AnimatePresence>
        {toasts.map(toast => {
          const style = TOAST_STYLES[toast.type]
          const Icon  = style.icon

          return (
            <motion.div
              key={toast.id}
              className="pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl shadow-xl max-w-xs w-full"
              style={{
                background:    'var(--color-surface)',
                border:        `1px solid ${style.border}`,
                backdropFilter: 'blur(8px)',
              }}
              initial={{ opacity: 0, x: 48, scale: 0.95 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 48, scale: 0.95 }}
              transition={{ type: 'spring', damping: 28, stiffness: 380 }}
              role="status"
            >
              <Icon
                size={16}
                aria-hidden="true"
                style={{ color: style.iconColor, flexShrink: 0, marginTop: '1px' }}
              />
              <p
                className="flex-1 text-xs leading-relaxed"
                style={{ color: 'var(--color-text-primary)' }}
              >
                {toast.message}
              </p>
              <button
                onClick={() => dismissToast(toast.id)}
                className="flex-shrink-0 transition-colors"
                style={{ color: 'var(--color-text-secondary)' }}
                aria-label="Dismiss notification"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
