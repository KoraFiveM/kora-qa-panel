import { createContext, useCallback, useContext, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2 } from "lucide-react"
import { Badge, type BadgeVariant } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/cn"
import { useSession } from "@/lib/session"
import type { Person as PersonT } from "@/lib/types"

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  open: "warning",
  info: "armour",
  confirmed: "primary",
  prompt_ready: "info",
  prompt_running: "armour",
  fix_initiated: "armour",
  fix_in_progress: "armour",
  fixed_awaiting_restart: "warning",
  awaiting_test: "primary",
  needs_manual_review: "destructive",
  fixed: "success",
  dup: "default",
  wontfix: "default",
}

export function StatusBadge({ status, label, className }: { status: string; label?: string; className?: string }) {
  const { statusLabel } = useSession()
  return <Badge variant={STATUS_VARIANT[status] ?? "default"} className={className}>{label ?? statusLabel(status)}</Badge>
}

const RUN_VARIANT: Record<string, BadgeVariant> = { passed: "success", failed: "destructive", running: "armour", aborted: "default", blocked: "warning" }
export function RunBadge({ status }: { status: string }) {
  return <Badge variant={RUN_VARIANT[status] ?? "default"}>{status}</Badge>
}

export function KindBadge({ kind }: { kind: string }) {
  return <Badge variant={kind === "suggestion" ? "armour" : "outline"}>{kind}</Badge>
}

export function RiskBadge({ risk }: { risk: string | null | undefined }) {
  if (!risk) return null
  const v: BadgeVariant = /low/i.test(risk) ? "success" : /med/i.test(risk) ? "warning" : /high/i.test(risk) ? "destructive" : "default"
  return <Badge variant={v}>risk: {risk}</Badge>
}

/** Step status icons per API.md: passed ✅, failed ❌, skipped ⏭, pending/unverified/blocked ❔. */
export function stepIcon(status: string | null | undefined): string {
  switch (status) {
    case "passed": return "✅"
    case "failed": return "❌"
    case "skipped": return "⏭"
    default: return "❔"
  }
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-4 animate-spin text-muted-foreground", className)} />
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
      <Spinner /> {label}
    </div>
  )
}

export function ErrorBox({ error, className, onRetry }: { error: Error | string | null | undefined; className?: string; onRetry?: () => void }) {
  if (!error) return null
  const msg = typeof error === "string" ? error : error.message
  return (
    <div className={cn("flex items-start gap-2 rounded-lg border border-destructive-border bg-destructive-soft px-3 py-2 text-sm text-destructive", className)}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 break-words">{msg}</div>
      {onRetry && <Button size="sm" variant="ghost" onClick={onRetry}>Retry</Button>}
    </div>
  )
}

export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("px-4 py-10 text-center text-sm text-muted-foreground", className)}>{children}</div>
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <div className="mb-4 space-y-1">
      {back && (
        <Link to={back.to} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-3.5" /> {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="break-words text-xl font-semibold leading-tight">{title}</h1>
          {subtitle && <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (pages <= 1) return <div className="px-1 py-2 text-xs text-muted-foreground">{total} total</div>
  return (
    <div className="flex items-center justify-between gap-2 px-1 py-2 text-xs text-muted-foreground">
      <span>{total} total · page {page} of {pages}</span>
      <div className="flex gap-1">
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft /></Button>
        <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight /></Button>
      </div>
    </div>
  )
}

/** Toggleable filter chips (multi-select). */
export function Chips({ options, value, onChange, render }: { options: { key: string; label: ReactNode; count?: number }[]; value: string[]; onChange: (v: string[]) => void; render?: (key: string, active: boolean) => ReactNode }) {
  return (
    <div className="scrollbar-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
      {options.map((o) => {
        const active = value.includes(o.key)
        return (
          <button
            key={o.key}
            onClick={() => onChange(active ? value.filter((v) => v !== o.key) : [...value, o.key])}
            className={cn(
              "focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors duration-fast",
              active ? "border-brand-border bg-brand-soft text-primary" : "border-border bg-surface-raised text-muted-foreground hover:text-foreground",
            )}
          >
            {render ? render(o.key, active) : o.label}
            {o.count !== undefined && <span className={cn("rounded-full px-1.5 text-[10px]", active ? "bg-primary/20" : "bg-background")}>{o.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

export function PersonName({ person, link = true }: { person: PersonT | null | undefined; link?: boolean }) {
  if (!person) return <span className="text-muted-foreground">—</span>
  const name = person.name ?? (person.discordId ? `…${person.discordId.slice(-4)}` : "system")
  if (link && person.discordId) return <Link className="hover:underline" to={`/testers/${person.discordId}`}>{name}</Link>
  return <span>{name}</span>
}

export function Stat({ label, value, hint, tone, to }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: "primary" | "success" | "warning" | "destructive"; to?: string }) {
  const body = (
    <div className={cn("h-full rounded-xl border bg-card p-3 shadow-low transition-colors", to && "hover:border-control-border-hover hover:bg-surface-hover")}>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "primary" && "text-primary", tone === "success" && "text-success", tone === "warning" && "text-warning", tone === "destructive" && "text-destructive")}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
  return to ? <Link to={to} className="focus-ring block rounded-xl">{body}</Link> : body
}

export function KV({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm", className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Pre({ children, className }: { children: ReactNode; className?: string }) {
  return <pre className={cn("scrollbar-thin max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-3 font-mono text-xs leading-5", className)}>{children}</pre>
}

/* ---- toasts ---- */
interface Toast { id: number; text: string; tone: "ok" | "error" }
const ToastCtx = createContext<(text: string, tone?: "ok" | "error") => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((text: string, tone: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, tone }])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 7000 : 3500)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-16 z-[60] flex flex-col items-center gap-2 px-3 md:bottom-4">
        {toasts.map((t) => (
          <div key={t.id} className={cn("pointer-events-auto max-w-md rounded-lg border px-3 py-2 text-sm shadow-floating animate-in fade-in-0 slide-in-from-bottom-2", t.tone === "error" ? "border-destructive-border bg-popover text-destructive" : "border-brand-border bg-popover text-foreground")}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)
