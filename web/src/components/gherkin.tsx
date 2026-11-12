import { Fragment, type ReactNode } from "react"
import { cn } from "@/lib/cn"
import { stepIcon } from "@/components/common"
import type { ScenarioError, ScenarioStep } from "@/lib/types"
import { useSession } from "@/lib/session"

/** Highlight "quoted" args and numbers inside a step's text. */
export function StepText({ text }: { text: string }) {
  const parts: ReactNode[] = []
  const re = /("[^"]*"|'[^']*'|<[^>]+>|\b-?\d+(?:\.\d+)?\b)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const tok = m[0]
    parts.push(
      <span key={i++} className={tok.startsWith('"') || tok.startsWith("'") ? "tok-str" : tok.startsWith("<") ? "tok-fn" : "tok-num"}>
        {tok}
      </span>,
    )
    last = m.index + tok.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

const KIND_STYLE: Record<string, string> = {
  setup: "text-armour",
  observed: "text-warning",
  check: "text-primary",
  manual: "text-info",
}

function tableRows(t: ScenarioStep["dataTable"]): string[][] | null {
  if (!t) return null
  if (Array.isArray(t)) return t as string[][]
  if (typeof t === "object" && Array.isArray(t.rows)) return t.rows.map((r) => r.cells.map((c) => c.value))
  return null
}

function docString(d: ScenarioStep["docString"]): string | null {
  if (!d) return null
  if (typeof d === "string") return d
  return d.content ?? null
}

/**
 * Gherkin steps with optional per-step status icons (✅❌⏭❔) and per-step validation errors.
 * `statuses` maps step idx → status; `failedIdx` marks the failing step.
 */
export function GherkinSteps({ steps, statuses, errors, failedIdx, showKind = true }: {
  steps: ScenarioStep[]
  statuses?: Map<number, string>
  errors?: ScenarioError[]
  failedIdx?: number | null
  showKind?: boolean
}) {
  const { meta } = useSession()
  const defs = new Map((meta?.steps ?? []).map((s) => [s.id, s]))
  const errByIdx = new Map<number, ScenarioError[]>()
  for (const e of errors ?? []) if (typeof e.idx === "number") errByIdx.set(e.idx, [...(errByIdx.get(e.idx) ?? []), e])
  return (
    <ol className="code-frame divide-y divide-border/60 overflow-hidden rounded-lg border font-mono text-[13px] leading-6">
      {steps.map((s) => {
        const st = statuses?.get(s.idx)
        const errs = errByIdx.get(s.idx)
        const failed = failedIdx === s.idx || st === "failed"
        const def = s.defId ? defs.get(s.defId) : undefined
        const rows = tableRows(s.dataTable)
        const doc = docString(s.docString)
        return (
          <li key={s.idx} className={cn("px-3 py-1.5", failed && "bg-destructive-soft", errs && "bg-warning-soft")}>
            <div className="flex items-start gap-2">
              {statuses && <span className="w-5 shrink-0 text-center" title={st ?? "not run"}>{stepIcon(st)}</span>}
              <div className="min-w-0 flex-1 break-words">
                <span className="font-semibold text-primary">{s.keyword?.trim()}</span> <StepText text={s.text} />
                {failed && <span className="ml-2 font-sans text-xs font-semibold text-destructive">← failed here</span>}
              </div>
              {showKind && (
                <span
                  className={cn("hidden shrink-0 font-sans text-[11px] uppercase tracking-wide sm:inline", s.kind ? KIND_STYLE[s.kind] : "text-destructive")}
                  title={def ? `${def.id}: ${def.pattern}${def.description ? `\n${def.description}` : ""}` : s.defId ? s.defId : "no step definition matches"}
                >
                  {s.kind ?? "unmatched"}
                </span>
              )}
            </div>
            {doc && <pre className="ml-7 mt-1 whitespace-pre-wrap rounded bg-surface-raised px-2 py-1 text-xs text-muted-foreground">{doc}</pre>}
            {rows && (
              <div className="ml-7 mt-1 overflow-x-auto">
                <table className="text-xs">
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        {r.map((c, j) => (
                          <Fragment key={j}>
                            <td className="px-1 text-muted-foreground">|</td>
                            <td className="px-1">{c}</td>
                          </Fragment>
                        ))}
                        <td className="px-1 text-muted-foreground">|</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {errs?.map((e, i) => (
              <div key={i} className="ml-7 mt-0.5 font-sans text-xs text-warning">⚠ {e.line ? `line ${e.line}: ` : ""}{e.message}</div>
            ))}
          </li>
        )
      })}
      {steps.length === 0 && <li className="px-3 py-2 font-sans text-sm text-muted-foreground">No steps.</li>}
    </ol>
  )
}

/** Plain step list (report/run steps have only idx/text/status). */
export function StatusSteps({ steps, failedIdx }: { steps: { idx: number; text: string; status: string; kind?: string | null; detail?: unknown }[]; failedIdx?: number | null }) {
  return (
    <ol className="code-frame divide-y divide-border/60 overflow-hidden rounded-lg border font-mono text-[13px] leading-6">
      {steps.map((s) => {
        const failed = s.status === "failed" || failedIdx === s.idx
        const detail = s.detail == null ? null : typeof s.detail === "string" ? s.detail : JSON.stringify(s.detail)
        return (
          <li key={s.idx} className={cn("px-3 py-1.5", failed && "bg-destructive-soft")}>
            <div className="flex items-start gap-2">
              <span className="w-5 shrink-0 text-center" title={s.status}>{stepIcon(s.status)}</span>
              <span className="min-w-0 flex-1 break-words"><StepText text={s.text} /></span>
              {s.kind && <span className={cn("hidden shrink-0 font-sans text-[11px] uppercase tracking-wide sm:inline", KIND_STYLE[s.kind] ?? "text-muted-foreground")}>{s.kind}</span>}
            </div>
            {detail && detail !== "{}" && <div className="ml-7 mt-0.5 break-words font-sans text-xs text-muted-foreground">{detail}</div>}
          </li>
        )
      })}
    </ol>
  )
}

export function Tags({ tags }: { tags: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span key={t} className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{t}</span>
      ))}
    </div>
  )
}
