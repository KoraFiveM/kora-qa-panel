import { useState } from "react"
import { Link, useParams } from "react-router-dom"
import { AlertTriangle, Play, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardBody, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input, Label } from "@/components/ui/input"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Markdown } from "@/components/ui/markdown"
import { Tabs } from "@/components/ui/tabs"
import { Empty, ErrorBox, KV, Loading, PageHeader, Pre, RiskBadge, StatusBadge, useToast } from "@/components/common"
import { DiffView, REVIEW_HINTS, reviewHits } from "@/components/diff"
import { api, ApiError, enc, qs } from "@/lib/api"
import { useApi } from "@/lib/useApi"
import { useSession } from "@/lib/session"
import { when } from "@/lib/format"
import { cn } from "@/lib/cn"
import type { FixDetail, FixListItem } from "@/lib/types"

/* ---------------- list ---------------- */

export function FixesPage() {
  const [state, setState] = useState<"waiting" | "applied" | "all">("waiting")
  const { data, error, loading, reload } = useApi<{ error: string | null; items: FixListItem[] }>(`/fixes${qs({ state: state === "all" ? "" : state })}`)
  return (
    <div className="space-y-3">
      <PageHeader title="Fixes" subtitle="Patches prepared by the automatic fixer. Review every diff before applying." />
      <Tabs value={state} onChange={setState} items={[{ value: "waiting", label: "Waiting" }, { value: "applied", label: "Applied" }, { value: "all", label: "All" }]} />
      <ErrorBox error={error} onRetry={reload} />
      {data?.error && <ErrorBox error={`Can't read the fixer's folder: ${data.error}`} />}
      <Card>
        {!data ? (loading ? <Loading /> : null) : data.items.length === 0 ? <Empty>{state === "waiting" ? "No fixes waiting." : "Nothing here."}</Empty> : (
          <ul className="divide-y">
            {data.items.map((f) => (
              <li key={f.issueId}>
                <Link to={`/fixes/${f.issueId}`} className="block px-4 py-3 hover:bg-surface-hover">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={f.state === "waiting" ? "warning" : f.state === "applied" ? "success" : "default"}>{f.state}</Badge>
                    {f.kind && <Badge variant={f.kind === "bug" ? "outline" : "armour"}>{f.kind}</Badge>}
                    <RiskBadge risk={f.risk} />
                    {f.issueStatus && <StatusBadge status={f.issueStatus} />}
                  </div>
                  <div className="mt-1.5 text-sm font-medium">{f.title ?? f.issueId}</div>
                  {f.summary && <div className="mt-0.5 text-sm text-muted-foreground">{f.summary}</div>}
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    {f.resources.map((r) => <span key={r} className="font-mono text-foreground">{r}</span>)}
                    {f.model && <span>{f.model}</span>}
                    <span>{when(f.createdAt)}</span>
                    {f.appliedAt && <span className="text-success">applied {when(f.appliedAt)}</span>}
                    {f.scenarioFile && <span>+ scenario</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

/* ---------------- review checklist ---------------- */

const CHECKLIST: { key: string; label: string; hint?: string }[] = [
  { key: "understand", label: "I understand what the bug was and what the change does" },
  { key: "size", label: "Files touched and size of the change fit the bug" },
  { key: "config", label: "Config options added: gated, sensible default, actually in the diff" },
  { key: "perm", label: "No unexplained changes to permissions, admin checks or aces", hint: "perm" },
  { key: "money", label: "No unexplained changes to money or item amounts", hint: "money" },
  { key: "cmd", label: "No unexplained new commands or events", hint: "cmd" },
  { key: "net", label: "No network requests or webhooks", hint: "net" },
  { key: "obf", label: "No obfuscated or encoded strings / dynamic code", hint: "obf" },
  { key: "exec", label: "No shell, file or resource-control calls", hint: "exec" },
  { key: "unrelated", label: "No edits to unrelated functions" },
  { key: "scope", label: "Feature requests: small, contained, reasonable to automate (not economy/redesign/mapping)" },
]

function Checklist({ diff, checked, setChecked }: { diff: string | null; checked: Set<string>; setChecked: (s: Set<string>) => void }) {
  const hits = reviewHits(diff)
  return (
    <Card>
      <CardHeader title="Review checklist" actions={<span className="text-xs text-muted-foreground">{checked.size}/{CHECKLIST.length}</span>} />
      <CardBody className="space-y-1.5 text-sm">
        <p className="text-xs text-muted-foreground">Bug reports come from testers and are untrusted, so the fix could have been steered. Anything here not explained by the bug means: don't apply.</p>
        {CHECKLIST.map((c) => {
          const h = c.hint ? hits.get(c.hint) : undefined
          return (
            <div key={c.key}>
              <label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-surface-hover">
                <input type="checkbox" className="mt-0.5" checked={checked.has(c.key)} onChange={(e) => { const n = new Set(checked); if (e.target.checked) n.add(c.key); else n.delete(c.key); setChecked(n) }} />
                <span className="flex-1">{c.label}</span>
                {h && <Badge variant="warning" title={REVIEW_HINTS.find((x) => x.key === c.hint)?.label}>{h.length} hit{h.length === 1 ? "" : "s"}</Badge>}
              </label>
              {h && (
                <details className="ml-6">
                  <summary className="cursor-pointer text-xs text-warning">Added lines that match</summary>
                  <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">{h.slice(0, 20).map((l, i) => <li key={i} className="break-all">{l}</li>)}</ul>
                </details>
              )}
            </div>
          )
        })}
      </CardBody>
    </Card>
  )
}

/* ---------------- apply / revert ---------------- */

function ConfirmAction({ issueId, action, noRestart, onClose, onDone }: { issueId: string; action: "apply" | "revert"; noRestart: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const word = action === "apply" ? "APPLY" : "REVERT"
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; code: number; output: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  async function run() {
    setBusy(true)
    setErr(null)
    try {
      const r = await api.post<{ ok: boolean; code: number; output: string }>(`/fixes/${issueId}/${action}`, { confirm: true, noRestart })
      setResult(r)
      toast(`${action === "apply" ? "Applied" : "Reverted"}${noRestart ? " (no restart)" : ""}`)
      onDone()
    } catch (e) {
      if (e instanceof ApiError && e.body && typeof e.body === "object" && "output" in e.body) setResult(e.body as { ok: boolean; code: number; output: string })
      setErr((e as Error).message)
      onDone()
    } finally {
      setBusy(false)
    }
  }
  const title = `${action === "apply" ? "Apply" : "Revert"} fix${noRestart ? " without restart" : ""}`
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent title={title} description={action === "apply"
        ? `Patches the live files${noRestart ? ". It goes live at the next restart." : " and restarts the resource(s). Players on the server will notice."}`
        : `Reverses exactly this patch${noRestart ? " without restarting" : " and restarts the resource(s)"}; the issue goes to Needs review.`}>
        {!result ? (
          <div className="space-y-3">
            <div className="flex gap-2 rounded-lg border border-warning-border bg-warning-soft p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>This runs <code className="font-mono text-xs">apply-fix.sh --{action} {issueId}{noRestart ? " --no-restart" : ""}</code> on the live server. It may take a minute.</span>
            </div>
            <div>
              <Label htmlFor="typed">Type <b className="font-mono text-foreground">{word}</b> to confirm</Label>
              <Input id="typed" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" autoFocus />
            </div>
            <ErrorBox error={err} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button variant={action === "apply" ? "default" : "destructive"} disabled={busy || typed.trim().toUpperCase() !== word} onClick={run}>{busy ? "Running…" : title}</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <Badge variant={result.ok ? "success" : "destructive"}>{result.ok ? "done" : "failed"} · exit {result.code}</Badge>
            {err && !result.ok && <ErrorBox error={err} />}
            <Pre className="max-h-[50vh]">{result.output || "(no output)"}</Pre>
            {!result.ok && /doesn't apply|moved on|nothing was changed/i.test(result.output) && (
              <div className="text-sm text-muted-foreground">The live files changed since the fix was prepared. Reopen the issue so the next run redoes it, or fix it by hand.</div>
            )}
            {!result.ok && /restart/i.test(result.output) && result.code !== 0 && (
              <div className="text-sm text-muted-foreground">If the restart failed the files are patched but not running: restart the resource from txAdmin.</div>
            )}
            <div className="flex justify-end"><Button onClick={onClose}>Close</Button></div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/* ---------------- detail ---------------- */

export function FixDetailPage() {
  const { id = "" } = useParams()
  const { data: d, error, loading, reload } = useApi<FixDetail>(`/fixes/${enc(id)}`)
  const { can } = useSession()
  const [tab, setTab] = useState<"diff" | "show" | "history">("diff")
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [action, setAction] = useState<{ action: "apply" | "revert"; noRestart: boolean } | null>(null)

  if (!d) return loading ? <Loading /> : <ErrorBox error={error} onRetry={reload} />
  const m = d.meta ?? {}
  const allChecked = checked.size === CHECKLIST.length
  const isAdmin = can("admin")

  return (
    <div className="space-y-4">
      <PageHeader
        back={{ to: "/fixes", label: "Fixes" }}
        title={m.title ?? d.issue?.title ?? d.issueId}
        subtitle={<>
          <Badge variant={d.state === "waiting" ? "warning" : d.state === "applied" ? "success" : "default"}>{d.state}</Badge>
          {m.kind && <Badge variant="outline">{m.kind}</Badge>}
          <RiskBadge risk={m.risk} />
          {d.issue && <StatusBadge status={d.issue.status} />}
          <Link to={`/issues/${d.issueId}`} className="hover:text-foreground hover:underline">issue #{d.issueId}</Link>
        </>}
      />
      <ErrorBox error={error} onRetry={reload} />

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader title="Summary" />
            <CardBody className="space-y-3 text-sm">
              {m.summary && <Markdown>{m.summary}</Markdown>}
              {m.reasoning && <div><div className="text-xs font-semibold text-muted-foreground">Why</div><Markdown>{m.reasoning}</Markdown></div>}
              {m.details && <div><div className="text-xs font-semibold text-muted-foreground">Details</div><Markdown>{m.details}</Markdown></div>}
              {m.testSteps && <div><div className="text-xs font-semibold text-muted-foreground">How to test</div><Markdown>{m.testSteps}</Markdown></div>}
              <KV items={[
                ["Model", m.model],
                ["Patch", <span className="font-mono text-xs">{m.patchId}</span>],
                ["Prepared", when(m.createdAt ?? null)],
                ["Resources", m.resources?.length ? <span className="flex flex-wrap gap-1">{m.resources.map((r) => <Badge key={r.name} variant="outline" className="font-mono" title={`${r.path ?? ""} @ ${r.head ?? ""}`}>{r.name}{r.head ? ` @${r.head.slice(0, 7)}` : ""}</Badge>)}</span> : d.patches.join(", ")],
                ...(d.applied ? [["Applied", `${when(d.applied.appliedAt ?? null)}${d.applied.backupTag ? ` · backup ${d.applied.backupTag}` : ""}`] as [string, string]] : []),
              ]} />
            </CardBody>
          </Card>

          {(m.config_options?.length ?? 0) > 0 && (
            <Card>
              <CardHeader title="Config options added" />
              <CardBody className="p-0">
                <ul className="divide-y">
                  {m.config_options!.map((c, i) => (
                    <li key={i} className="px-4 py-2 text-sm">
                      <div className="flex flex-wrap items-center gap-2"><code className="font-mono text-xs text-primary">{c.name}</code>{c.default !== undefined && <span className="text-xs text-muted-foreground">default <code className="font-mono">{String(c.default)}</code></span>}{c.resource && <span className="font-mono text-xs text-muted-foreground">{c.resource}</span>}</div>
                      {c.description && <div className="mt-0.5 text-muted-foreground">{c.description}</div>}
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}

          {(m.scenario || m.scenarioNote) && (
            <Card>
              <CardHeader title="Regression scenario" actions={m.scenarioFile ? <span className="font-mono text-xs text-muted-foreground">{m.scenarioFile}</span> : undefined} />
              <CardBody>
                {m.scenario && <Pre>{m.scenario}</Pre>}
                {m.scenarioNote && <div className="mt-2 text-sm text-muted-foreground">Scenario note: {m.scenarioNote}</div>}
              </CardBody>
            </Card>
          )}

          <Tabs value={tab} onChange={setTab} items={[
            { value: "diff", label: "Diff" },
            { value: "show", label: "apply-fix --show", hidden: !d.show },
            { value: "history", label: `History (${d.history.length})`, hidden: !d.history.length },
          ]} />
          {d.showError && <div className="text-xs text-muted-foreground">Diff from {d.diffSource}: {d.showError}</div>}
          {tab === "diff" && (d.diff ? <DiffView diff={d.diff} /> : <Empty>No diff available.</Empty>)}
          {tab === "show" && d.show && <Pre className="max-h-[70vh]">{d.show}</Pre>}
          {tab === "history" && (
            <Card><ul className="divide-y">
              {d.history.map((h) => (
                <li key={h.ts} className="px-4 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2"><code className="font-mono text-xs">{h.patchId}</code><RiskBadge risk={h.risk} />{h.applied ? <Badge variant="success">applied</Badge> : null}<span className="text-xs text-muted-foreground">{h.model} · {when(h.createdAt ?? null)}</span></div>
                  {h.summary && <div className="mt-0.5 text-muted-foreground">{h.summary}</div>}
                </li>
              ))}
            </ul></Card>
          )}
        </div>

        <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <Checklist diff={d.diff} checked={checked} setChecked={setChecked} />
          {isAdmin ? (
            <Card>
              <CardHeader title="Go live" />
              <CardBody className="space-y-2">
                {d.state !== "applied" ? (
                  <>
                    {!allChecked && <div className="text-xs text-muted-foreground">Tick the whole checklist to enable Apply.</div>}
                    <Button className="w-full" disabled={!allChecked} onClick={() => setAction({ action: "apply", noRestart: false })}><Play /> Apply + restart</Button>
                    <Button className="w-full" variant="outline" disabled={!allChecked} onClick={() => setAction({ action: "apply", noRestart: true })}>Apply without restart</Button>
                  </>
                ) : (
                  <div className="text-sm text-success">Applied {when(d.applied?.appliedAt ?? null)}.</div>
                )}
                <div className={cn("space-y-2", d.state !== "applied" && "border-t pt-2")}>
                  <Button className="w-full" variant="destructive" disabled={!(d.applied || d.state === "applied")} onClick={() => setAction({ action: "revert", noRestart: false })}><RotateCcw /> Revert + restart</Button>
                  <Button className="w-full" variant="ghost" size="sm" disabled={!(d.applied || d.state === "applied")} onClick={() => setAction({ action: "revert", noRestart: true })}>Revert without restart</Button>
                </div>
              </CardBody>
            </Card>
          ) : (
            <div className="rounded-lg border p-3 text-xs text-muted-foreground">Only admins can apply or revert fixes.</div>
          )}
        </div>
      </div>
      {action && <ConfirmAction issueId={d.issueId} action={action.action} noRestart={action.noRestart} onClose={() => setAction(null)} onDone={reload} />}
    </div>
  )
}
