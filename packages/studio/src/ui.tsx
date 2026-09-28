// Local Geist components (@vercel/geistcn is not on npm; see NOTES.md). Each follows its
// /geist/<component>.md spec. Styles live in app.css and use Geist tokens only.
import {
  type ButtonHTMLAttributes,
  cloneElement,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'

// ------------------------------------------------------------------------------------ icons

type IconProps = { size?: number; className?: string }
function Svg({ size = 16, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  )
}
export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8.5 6.25 11.75 13 5" />
  </Svg>
)
export const IconFlag = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 14.25V1.75" />
    <path d="M3.5 2.25h8.75L10.25 5.5l2 3.25H3.5" />
  </Svg>
)
export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
)
export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.75" y="5.75" width="8" height="8" rx="1.5" />
    <path d="M10.25 5.75V3.75a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h2" />
  </Svg>
)
export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.75" />
    <path d="M8 1.25v1.5M8 13.25v1.5M1.25 8h1.5M13.25 8h1.5M3.2 3.2l1.07 1.07M11.73 11.73l1.07 1.07M3.2 12.8l1.07-1.07M11.73 4.27l1.07-1.07" />
  </Svg>
)
export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.25 9.6A5.5 5.5 0 0 1 6.4 2.75a5.5 5.5 0 1 0 6.85 6.85Z" />
  </Svg>
)
export const IconMonitor = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5" />
    <path d="M5.5 14.25h5M8 11.25v3" />
  </Svg>
)
export const IconRestart = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.75 8a5.25 5.25 0 1 0 1.54-3.71" />
    <path d="M2.75 1.75v3h3" />
  </Svg>
)
export const IconWarning = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7.13 2.25a1 1 0 0 1 1.74 0l5.4 9.5a1 1 0 0 1-.87 1.5H2.6a1 1 0 0 1-.87-1.5Z" />
    <path d="M8 6v3" />
    <path d="M8 11.25h.01" />
  </Svg>
)
export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 7.25v4" />
    <path d="M8 4.75h.01" />
  </Svg>
)
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
  </Svg>
)
export const IconList = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />
  </Svg>
)

// ----------------------------------------------------------------------------------- button

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'prefix'> & {
  variant?: 'default' | 'secondary' | 'tertiary'
  size?: 'tiny' | 'small'
  /** Icon-only: pass an aria-label that names the action and its target. */
  svgOnly?: boolean
  prefix?: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'small',
  svgOnly = false,
  prefix,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = ['btn', `btn-${variant}`, `btn-${size}`, svgOnly && 'btn-icon', className]
  return (
    <button type={type} className={classes.filter(Boolean).join(' ')} {...rest}>
      {prefix}
      {children !== undefined && !svgOnly ? (
        <span className="btn-label">{children}</span>
      ) : (
        children
      )}
    </button>
  )
}

// ------------------------------------------------------------------------------------ badge

export type BadgeVariant = 'gray' | 'blue' | 'red' | 'amber' | 'green' | 'purple'

export function Badge({
  variant = 'gray',
  icon,
  title,
  children,
}: {
  variant?: BadgeVariant
  icon?: ReactNode
  title?: string
  children: ReactNode
}) {
  return (
    <span className={`badge badge-${variant}`} title={title}>
      {icon}
      <span className="badge-text">{children}</span>
    </span>
  )
}

// ------------------------------------------------------------------------------------- tabs

export function Tabs<T extends string>({
  tabs,
  selected,
  onSelect,
  label,
}: {
  tabs: Array<{ value: T; title: string }>
  selected: T
  onSelect: (value: T) => void
  label: string
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>())
  const move = (key: string) => {
    const i = tabs.findIndex((t) => t.value === selected)
    const n = tabs.length
    const next =
      key === 'ArrowRight'
        ? (i + 1) % n
        : key === 'ArrowLeft'
          ? (i - 1 + n) % n
          : key === 'Home'
            ? 0
            : key === 'End'
              ? n - 1
              : -1
    if (next === -1) return false
    const value = (tabs[next] as { value: T }).value
    onSelect(value)
    refs.current.get(value)?.focus()
    return true
  }
  return (
    <div
      role="tablist"
      aria-label={label}
      className="tabs"
      onKeyDown={(e) => {
        if (move(e.key)) e.preventDefault()
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.value}
          ref={(el) => {
            if (el) refs.current.set(t.value, el)
          }}
          type="button"
          role="tab"
          id={`tab-${t.value}`}
          aria-selected={t.value === selected}
          aria-controls={`panel-${t.value}`}
          tabIndex={t.value === selected ? 0 : -1}
          className="tab text-label-14"
          onClick={() => onSelect(t.value)}
        >
          {t.title}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------------- tooltip

/** Opens on hover (after ~150ms) and on keyboard focus; Escape closes it. */
export function Tooltip({
  text,
  children,
  side = 'top',
}: {
  text: string
  children: ReactElement<{ 'aria-describedby'?: string }>
  side?: 'top' | 'bottom'
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const show = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), 150)
  }
  const hide = () => {
    clearTimeout(timer.current)
    setOpen(false)
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover/focus wrapper; the child is the control
    <span
      className="tooltip-wrap"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={() => setOpen(true)}
      onBlur={hide}
      onKeyDown={(e) => {
        if (e.key === 'Escape') hide()
      }}
    >
      {cloneElement(children, { 'aria-describedby': id })}
      <span
        role="tooltip"
        id={id}
        className={`tooltip material-tooltip tooltip-${side}`}
        hidden={!open}
      >
        {text}
      </span>
    </span>
  )
}

// ------------------------------------------------------------------------------------ sheet

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Geist Sheet: a side panel for detail context. Slides from the right on desktop and from the
 * bottom on small screens. Traps focus, closes on Escape, and has an explicit Close button (in
 * its children). Outside clicks do not close it. The caller returns focus to the trigger.
 */
export function Sheet({
  open,
  onClose,
  labelledBy,
  children,
}: {
  open: boolean
  onClose: () => void
  labelledBy: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    const node = ref.current
    ;(node?.querySelector<HTMLElement>('[data-autofocus]') ?? node)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeRef.current()
        return
      }
      if (e.key !== 'Tab' || !node) return
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)]
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      if (!node.contains(document.activeElement)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelledBy}
      className="sheet material-modal"
      tabIndex={-1}
    >
      {children}
    </div>
  )
}

// ----------------------------------------------------------------------------- theme switcher

export type ThemePreference = 'system' | 'light' | 'dark'

const THEMES: Array<{ value: ThemePreference; icon: ReactNode }> = [
  { value: 'system', icon: <IconMonitor /> },
  { value: 'light', icon: <IconSun /> },
  { value: 'dark', icon: <IconMoon /> },
]

export function ThemeSwitcher({
  value,
  onChange,
}: {
  value: ThemePreference
  onChange: (value: ThemePreference) => void
}) {
  const name = useId()
  return (
    <fieldset className="theme-switcher">
      <legend className="sr-only">Select a display theme:</legend>
      {THEMES.map((t) => (
        <label
          key={t.value}
          className="theme-option"
          title={`${t.value[0]?.toUpperCase()}${t.value.slice(1)}`}
        >
          <input
            type="radio"
            name={name}
            value={t.value}
            aria-label={t.value}
            checked={value === t.value}
            onChange={() => onChange(t.value)}
          />
          {t.icon}
        </label>
      ))}
    </fieldset>
  )
}

// --------------------------------------------------------------------- select and switch

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <label className="select">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="text-label-14"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <IconChevronDown className="select-chevron" />
    </label>
  )
}

/** Geist Switch: a segmented control with radio semantics for 2–3 options. */
export function Switch<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  const name = useId()
  return (
    <fieldset className="switch">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <label key={o.value} className="switch-control text-label-13">
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={o.value === value}
            onChange={() => onChange(o.value)}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </fieldset>
  )
}

// ------------------------------------------------------------------- empty state, skeleton

export function EmptyState({
  icon,
  title,
  children,
  action,
  tone = 'default',
}: {
  icon: ReactNode
  title: string
  children: ReactNode
  action?: ReactNode
  tone?: 'default' | 'error'
}) {
  return (
    <div className={`empty-state empty-${tone}`}>
      <div className="empty-icon">{icon}</div>
      <h2 className="text-heading-16">{title}</h2>
      <div className="empty-body text-copy-14">{children}</div>
      {action}
    </div>
  )
}

export function Skeleton({ width, height = 16 }: { width: number | string; height?: number }) {
  return <span className="skeleton" style={{ width, height }} />
}

// ------------------------------------------------------------------------------------ hooks

export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(query).matches,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    const onChange = () => setReduced(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return reduced
}

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
