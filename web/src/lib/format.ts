export function ago(ms: number | null | undefined): string {
  if (!ms) return "—"
  const d = Date.now() - ms
  const s = Math.round(d / 1000)
  if (s < 0) return "just now"
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h}h ago`
  const days = Math.round(h / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ms).toLocaleDateString()
}

export function when(ms: number | string | null | undefined): string {
  if (ms === null || ms === undefined || ms === "") return "—"
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return String(ms)
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

export function clock(ms: number | null | undefined, base?: number | null): string {
  if (!ms) return ""
  if (base) {
    const d = (ms - base) / 1000
    return `${d >= 0 ? "+" : ""}${d.toFixed(1)}s`
  }
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export function duration(a: number | null | undefined, b: number | null | undefined): string {
  if (!a || !b) return "—"
  const s = Math.max(0, Math.round((b - a) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

export function pct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "—"
  return `${Math.round(rate * 100)}%`
}

export function bytes(n: number | null | undefined): string {
  if (!n) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function json(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

export const shortId = (id: string) => (id.length > 8 ? `…${id.slice(-6)}` : id)
