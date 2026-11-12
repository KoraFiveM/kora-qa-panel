import { useMemo, useState } from "react"
import { Check, Copy, MapPin } from "lucide-react"
import { Card, CardBody, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { StatusSteps } from "@/components/gherkin"
import { KV, Pre } from "@/components/common"
import { cn } from "@/lib/cn"
import { bytes, clock, json, when } from "@/lib/format"
import type { Attachment, InvItem, Report } from "@/lib/types"

function asList(inv: Report["inventoryBefore"]): InvItem[] {
  if (!inv) return []
  if (Array.isArray(inv)) return inv
  if (typeof inv === "object") return Object.entries(inv).map(([k, v]) => ({ slot: Number(k), ...(v as InvItem) }))
  return []
}
const amount = (i: InvItem) => Number(i.amount ?? i.count ?? 1) || 0

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          window.setTimeout(() => setDone(false), 1200)
        }, () => {})
      }}
    >
      {done ? <Check /> : <Copy />} {label}
    </Button>
  )
}

export function Screenshots({ files }: { files: Attachment[] }) {
  const [open, setOpen] = useState<Attachment | null>(null)
  const shots = files.filter((a) => a.url && (a.kind === "screenshot" || a.mime?.startsWith("image/")))
  const other = files.filter((a) => !shots.includes(a))
  if (!files.length) return null
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {shots.map((a) => (
          <button key={a.id} onClick={() => setOpen(a)} className="focus-ring group overflow-hidden rounded-lg border bg-background">
            <img src={a.url!} alt={`screenshot ${a.id}`} loading="lazy" className="aspect-video w-full object-cover transition-transform group-hover:scale-[1.02]" />
            <div className="px-2 py-1 text-left text-[11px] text-muted-foreground">#{a.id} · {bytes(a.size)} · {when(a.createdAt)}</div>
          </button>
        ))}
      </div>
      {other.map((a) => (
        <a key={a.id} href={a.url ?? a.originalUrl ?? "#"} target="_blank" rel="noreferrer" className="block text-sm text-primary underline">
          {a.kind} #{a.id} {a.mime} {bytes(a.size)}
        </a>
      ))}
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/90 p-2" onClick={() => setOpen(null)}>
          <div className="flex items-center justify-between gap-2 p-2 text-xs text-white/70">
            <span>#{open.id} · {open.mime} · {bytes(open.size)}</span>
            <a href={open.url!} target="_blank" rel="noreferrer" className="underline" onClick={(e) => e.stopPropagation()}>open original</a>
          </div>
          <img src={open.url!} alt="" className="m-auto max-h-full max-w-full object-contain" />
        </div>
      )}
    </div>
  )
}

function InvGrid({ items, changed, title }: { items: InvItem[]; changed: Set<string>; title: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title} ({items.length})</div>
      {items.length === 0 ? (
        <div className="rounded-md border border-dashed px-2 py-4 text-center text-xs text-muted-foreground">empty</div>
      ) : (
        <div className="grid grid-cols-4 gap-1 sm:grid-cols-5">
          {items.map((i, k) => (
            <div
              key={`${i.slot ?? k}-${i.name}`}
              title={i.info || i.metadata ? json(i.info ?? i.metadata) : undefined}
              className={cn("relative flex aspect-square flex-col justify-between rounded-md border bg-surface-raised p-1", changed.has(String(i.name)) && "border-warning-border bg-warning-soft")}
            >
              <span className="text-[9px] text-muted-foreground">{i.slot ?? ""}</span>
              <span className="line-clamp-2 break-all text-center text-[10px] leading-tight">{i.label ?? i.name}</span>
              <span className="text-right text-[10px] font-semibold tabular-nums">×{amount(i)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function InventoryDiff({ before, after }: { before: Report["inventoryBefore"]; after: Report["inventoryAfter"] }) {
  const b = asList(before), a = asList(after)
  const diff = useMemo(() => {
    const sum = (l: InvItem[]) => l.reduce((m, i) => m.set(String(i.name), (m.get(String(i.name)) ?? 0) + amount(i)), new Map<string, number>())
    const sb = sum(b), sa = sum(a)
    const names = new Set([...sb.keys(), ...sa.keys()])
    return [...names].map((n) => ({ name: n, before: sb.get(n) ?? 0, after: sa.get(n) ?? 0 })).filter((d) => d.before !== d.after)
  }, [b, a])
  const changed = new Set(diff.map((d) => d.name))
  if (!b.length && !a.length) return <div className="text-sm text-muted-foreground">No inventory captured.</div>
  return (
    <div className="space-y-3">
      {diff.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {diff.map((d) => (
            <Badge key={d.name} variant={d.after > d.before ? "success" : "destructive"}>
              {d.name}: {d.before} → {d.after} ({d.after > d.before ? "+" : ""}{d.after - d.before})
            </Badge>
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">No item count changed.</div>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <InvGrid title="Before" items={b} changed={changed} />
        <InvGrid title="After" items={a} changed={changed} />
      </div>
    </div>
  )
}

function money(m: Record<string, number> | undefined) {
  if (!m) return null
  return Object.entries(m).map(([k, v]) => `${k} ${typeof v === "number" ? v.toLocaleString() : v}`).join(" · ")
}

export function PlayerContext({ report }: { report: Report }) {
  const p = report.player
  if (!p) return <div className="text-sm text-muted-foreground">No player context.</div>
  const c = p.coords
  const vec = c ? `vector4(${[c.x, c.y, c.z, c.h ?? 0].map((n) => Number(n ?? 0).toFixed(2)).join(", ")})` : null
  return (
    <div className="space-y-2">
      {vec && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-2 py-1">
          <MapPin className="size-4 text-primary" />
          <code className="min-w-0 flex-1 break-all font-mono text-xs">{vec}</code>
          <CopyButton text={vec} />
        </div>
      )}
      <KV
        items={[
          ["Street", p.street],
          ["Vehicle", p.vehicle ? `${p.vehicle.model ?? "?"}${p.vehicle.plate ? ` (${p.vehicle.plate})` : ""}` : "on foot"],
          ["Job", p.job ? `${p.job.name ?? "?"} · grade ${String(p.job.grade ?? "?")}${p.job.onduty === false ? " · off duty" : ""}` : null],
          ...(p.gang ? [["Gang", `${p.gang.name ?? "?"} · grade ${String(p.gang.grade ?? "?")}`] as [string, string]] : []),
          ["Money", money(p.money)],
          ...(report.moneyBefore ? [["Money before", money(report.moneyBefore)] as [string, string | null]] : []),
          ["Health / armour", `${p.health ?? "?"} / ${p.armour ?? "?"}`],
          ...(p.routingBucket !== undefined ? [["Bucket", String(p.routingBucket)] as [string, string]] : []),
        ]}
      />
    </div>
  )
}

const TL_COLOR: Record<string, string> = {
  error: "text-destructive", console: "text-muted-foreground", mark: "text-primary", notify: "text-warning", callback: "text-armour", nui: "text-info", setup: "text-armour", command: "text-warning",
}

export function Timeline({ entries }: { entries: { at: number; type: string; data?: unknown }[] }) {
  const [all, setAll] = useState(false)
  if (!entries.length) return <div className="text-sm text-muted-foreground">Empty timeline.</div>
  const base = entries[0]?.at
  const shown = all ? entries : entries.slice(-40)
  return (
    <div>
      {entries.length > 40 && !all && (
        <Button size="sm" variant="ghost" className="mb-1" onClick={() => setAll(true)}>Show all {entries.length} (showing last 40)</Button>
      )}
      <ol className="code-frame scrollbar-thin max-h-96 overflow-auto rounded-lg border font-mono text-xs leading-5">
        {shown.map((e, i) => (
          <li key={i} className="flex gap-2 border-b border-border/50 px-2 py-1 last:border-0">
            <span className="w-14 shrink-0 text-right text-muted-foreground">{clock(e.at, base)}</span>
            <span className={cn("w-16 shrink-0", TL_COLOR[e.type] ?? "text-foreground")}>{e.type}</span>
            <span className="min-w-0 flex-1 break-all">{typeof e.data === "string" ? e.data : e.data === undefined ? "" : JSON.stringify(e.data)}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

export function ConsoleLines({ lines }: { lines: { at: number; channel?: string; line: string; error?: boolean }[] }) {
  if (!lines.length) return <div className="text-sm text-muted-foreground">No console lines.</div>
  return (
    <ol className="code-frame scrollbar-thin max-h-80 overflow-auto rounded-lg border font-mono text-xs leading-5">
      {lines.map((l, i) => (
        <li key={i} className={cn("flex gap-2 border-b border-border/50 px-2 py-1 last:border-0", (l.error || /SCRIPT ERROR|error/i.test(l.line)) && "bg-destructive-soft text-destructive")}>
          <span className="shrink-0 text-muted-foreground">{clock(l.at)}</span>
          {l.channel && <span className="shrink-0 text-armour">[{l.channel}]</span>}
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{l.line}</span>
        </li>
      ))}
    </ol>
  )
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} actions={right} />
      <CardBody>{children}</CardBody>
    </Card>
  )
}

/** Full structured view of a Report (QA-CONTRACTS §6). Every field optional. */
export function ReportView({ report, screenshots }: { report: Report; screenshots?: Attachment[] }) {
  const steps = report.steps ?? []
  const errors = (report.console ?? []).filter((l) => l.error || /SCRIPT ERROR|\berror\b/i.test(l.line))
  return (
    <div className="space-y-3">
      {(report.expected || report.actual || report.note || report.frequency) && (
        <Section title="What happened">
          <div className="grid gap-3 sm:grid-cols-2">
            {report.expected && (
              <div className="rounded-lg border border-success-border bg-success-soft p-3">
                <div className="mb-1 text-xs font-semibold text-success">Expected</div>
                <div className="whitespace-pre-wrap break-words text-sm">{report.expected}</div>
              </div>
            )}
            {report.actual && (
              <div className="rounded-lg border border-destructive-border bg-destructive-soft p-3">
                <div className="mb-1 text-xs font-semibold text-destructive">Actual</div>
                <div className="whitespace-pre-wrap break-words text-sm">{report.actual}</div>
              </div>
            )}
          </div>
          {report.note && <div className="mt-3 whitespace-pre-wrap break-words text-sm"><span className="text-muted-foreground">Tester note: </span>{report.note}</div>}
          {report.frequency && <div className="mt-2"><Badge variant="outline">happens: {report.frequency}</Badge></div>}
        </Section>
      )}
      {steps.length > 0 && (
        <Section title={report.scenario?.name ? `Scenario: ${report.scenario.name}` : "Steps"}>
          <StatusSteps steps={steps} failedIdx={report.failedIdx} />
        </Section>
      )}
      {screenshots && screenshots.length > 0 && (
        <Section title="Screenshots"><Screenshots files={screenshots} /></Section>
      )}
      {report.screenshot && report.screenshot.available === false && (!screenshots || !screenshots.length) && (
        <div className="text-xs text-muted-foreground">No screenshot: {report.screenshot.reason ?? "not available"}</div>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        <Section title="Player"><PlayerContext report={report} /></Section>
        <Section title="Inventory"><InventoryDiff before={report.inventoryBefore} after={report.inventoryAfter} /></Section>
      </div>
      {errors.length > 0 && <Section title={`Console errors (${errors.length})`}><ConsoleLines lines={errors} /></Section>}
      {(report.timeline?.length ?? 0) > 0 && <Section title={`Timeline (${report.timeline!.length})`}><Timeline entries={report.timeline!} /></Section>}
      {(report.console?.length ?? 0) > errors.length && <Section title={`Console (${report.console!.length})`}><ConsoleLines lines={report.console!} /></Section>}
      {report.teardown && report.teardown.length > 0 && (
        <Section title="Teardown">
          <ul className="space-y-1 text-sm">
            {report.teardown.map((t, i) => (
              <li key={i}>{t.ok ? "✅" : "❌"} {t.id ?? `step ${t.idx}`}{t.error ? <span className="text-destructive"> — {t.error}</span> : null}</li>
            ))}
          </ul>
        </Section>
      )}
      {(report.resources?.length || report.build) && (
        <Section title="Server">
          {report.build && <div className="mb-2 text-sm"><span className="text-muted-foreground">Build: </span>{report.build}</div>}
          {report.resources && (
            <div className="flex flex-wrap gap-1.5">
              {report.resources.map((r) => (
                <Badge key={r.name} variant={r.state && r.state !== "started" ? "warning" : "outline"}>{r.name}{r.version ? ` ${r.version}` : ""}{r.state && r.state !== "started" ? ` (${r.state})` : ""}</Badge>
              ))}
            </div>
          )}
        </Section>
      )}
      <details className="rounded-lg border bg-card">
        <summary className="cursor-pointer px-4 py-2 text-sm text-muted-foreground">Raw report JSON</summary>
        <div className="p-3 pt-0"><Pre>{json(report)}</Pre></div>
      </details>
    </div>
  )
}
