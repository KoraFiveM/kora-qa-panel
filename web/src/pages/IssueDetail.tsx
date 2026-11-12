import { useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { Check, ExternalLink, GitPullRequest, Pencil, RotateCcw, ShieldAlert, ThumbsDown, ThumbsUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardBody, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input, Label, Select, Textarea } from "@/components/ui/input"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Markdown } from "@/components/ui/markdown"
import { Tabs } from "@/components/ui/tabs"
import { Empty, ErrorBox, KindBadge, Loading, PageHeader, PersonName, Pre, RiskBadge, RunBadge, StatusBadge, useToast } from "@/components/common"
import { ReportView, Screenshots, CopyButton } from "@/components/report"
import { GherkinSteps, Tags } from "@/components/gherkin"
import { RunRows } from "@/components/run-list"
import { api, ApiError, enc } from "@/lib/api"
import { useApi } from "@/lib/useApi"
import { useSession } from "@/lib/session"
import { ago, json, when } from "@/lib/format"
import { cn } from "@/lib/cn"
import type { IssueDetail, IssueEvent, IssueSummary, Message, PromptPreview } from "@/lib/types"

type Tab = "report" | "thread" | "history" | "prompt" | "fixes" | "runs"

/* ---------------- actions ---------------- */

interface ActionSpec { op: string; label: string; variant: "default" | "success" | "destructive" | "warning" | "outline" | "secondary"; icon?: React.ReactNode; noteRequired?: boolean; override?: boolean; hint?: string }

function ActionDialog({ spec, issue, onDone, onClose }: { spec: ActionSpec; issue: IssueSummary; onDone: () => void; onClose: () => void }) {
  const toast = useToast()
  const { can } = useSession()
  const [note, setNote] = useState("")
  const [override, setOverride] = useState("")
  const [useOverride, setUseOverride] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const max = spec.op === "not_fixed" ? 2000 : 500

  async function submit() {
    setBusy(true)
    setErr(null)
    try {
      let res: { from: string; to: string }
      if (spec.op === "works") res = await api.post(`/issues/${issue.id}/works`, note.trim() ? { note: note.trim() } : {})
      else if (spec.op === "not_fixed") res = await api.post(`/issues/${issue.id}/not-fixed`, { note: note.trim() })
      else {
        const body: Record<string, string> = { status: spec.op, expect: issue.status }
        if (note.trim()) body.note = note.trim()
        if (spec.op === "open" && useOverride && override.trim()) body.override = override.trim()
        res = await api.post(`/issues/${issue.id}/status`, body)
      }
      toast(`Status: ${res.from} → ${res.to}`)
      onDone()
      onClose()
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 409 ? `${e.message}. Reload to see the latest state.` : (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = !busy && (!spec.noteRequired || note.trim().length > 0) && (!useOverride || override.trim().length > 0)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={spec.label} description={spec.hint}>
        <div className="space-y-3">
          <div>
            <Label htmlFor="act-note">{spec.noteRequired ? "What still goes wrong? (required)" : "Note (optional)"}</Label>
            <Textarea id="act-note" value={note} maxLength={max} onChange={(e) => setNote(e.target.value)} placeholder={spec.op === "not_fixed" ? "Still no money after selling a fish…" : spec.op === "works" ? "Works now" : "Shown on the issue and to the fixer"} autoFocus />
            <div className="mt-0.5 text-right text-[11px] text-muted-foreground">{note.length}/{max}</div>
          </div>
          {spec.override && can("dev") && (
            <div className="rounded-lg border border-warning-border bg-warning-soft p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={useOverride} onChange={(e) => setUseOverride(e.target.checked)} />
                <ShieldAlert className="size-4 text-warning" /> Mod override for the next fix attempt
              </label>
              {useOverride && (
                <>
                  <Textarea className="mt-2" value={override} maxLength={500} onChange={(e) => setOverride(e.target.value)} placeholder="Try the server side this time: the client is fine." />
                  <div className="mt-1 text-[11px] text-muted-foreground">Posted as “Mod override: try a fix — …” and given to the fixer. Cleared when a fix is ready or the issue closes.</div>
                </>
              )}
            </div>
          )}
          <ErrorBox error={err} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant={spec.variant === "outline" || spec.variant === "secondary" ? "default" : spec.variant} disabled={!canSubmit} onClick={submit}>{busy ? "Saving…" : spec.label}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function actionSpecs(ops: string[], status: string, label: (k: string) => string, manualReviewAfter: number, notFixedCount: number): ActionSpec[] {
  const out: ActionSpec[] = []
  for (const op of ops) {
    if (op === "works") out.push({ op, label: "Works", variant: "success", icon: <ThumbsUp />, hint: "You retested and it's fixed. The issue closes as Fixed." })
    else if (op === "not_fixed") out.push({ op, label: "Not fixed", variant: "destructive", icon: <ThumbsDown />, noteRequired: true, hint: notFixedCount + 1 >= manualReviewAfter ? `This is attempt ${notFixedCount + 1}: it goes to manual review instead of another automatic fix.` : "Sends it back to the fixer with your note." })
    else if (op === "open") out.push({ op, label: status === "open" ? "Open" : "Reopen", variant: "warning", icon: <RotateCcw />, override: true, hint: "Back to Opened, so the fixer picks it up again." })
    else if (op === "confirmed") out.push({ op, label: "Confirm", variant: "default", icon: <Check />, hint: "You reproduced it. The reporter gets XP." })
    else if (op === "info") out.push({ op, label: "Needs info", variant: "outline", hint: "Ask the reporter for more detail (say what in the note)." })
    else if (op === "needs_manual_review") out.push({ op, label: "Needs review", variant: "outline", hint: "Take it away from the automatic fixer." })
    else if (op === "fixed") out.push({ op, label: "Mark fixed", variant: "success", hint: "Close as Fixed (pays the reporter if not paid yet)." })
    else if (op === "dup") out.push({ op, label: "Duplicate", variant: "outline", hint: "Close as a duplicate. Mention the other issue in the note." })
    else if (op === "wontfix") out.push({ op, label: "Won't fix", variant: "outline", hint: "Close without fixing." })
    else out.push({ op, label: label(op), variant: "secondary", hint: `Set status to ${label(op)} (admin).` })
  }
  return out
}

function Actions({ d, reload }: { d: IssueDetail; reload: () => void }) {
  const { statusLabel, meta } = useSession()
  const [active, setActive] = useState<ActionSpec | null>(null)
  const [more, setMore] = useState(false)
  const specs = actionSpecs(d.allowedOps.filter((o) => o !== d.issue.status), d.issue.status, statusLabel, meta?.manualReviewAfter ?? 3, d.issue.notFixedCount)
  const PRIMARY = ["works", "not_fixed", "open", "confirmed", "info", "needs_manual_review", "fixed", "dup", "wontfix"]
  const main = specs.filter((s) => PRIMARY.includes(s.op))
  const rest = specs.filter((s) => !PRIMARY.includes(s.op))
  if (!specs.length) return null
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {main.map((s) => (
          <Button key={s.op} variant={s.variant} size={s.op === "works" || s.op === "not_fixed" ? "default" : "sm"} onClick={() => setActive(s)} className={cn((s.op === "works" || s.op === "not_fixed") && "flex-1 sm:flex-none")}>
            {s.icon} {s.label}
          </Button>
        ))}
        {rest.length > 0 && <Button size="sm" variant="ghost" onClick={() => setMore(!more)}>{more ? "Fewer" : "Other statuses…"}</Button>}
      </div>
      {more && (
        <div className="flex flex-wrap gap-1.5 rounded-lg border border-dashed p-2">
          <span className="w-full text-[11px] text-muted-foreground">Admin: force a pipeline status (normally set by the fixer).</span>
          {rest.map((s) => <Button key={s.op} size="sm" variant="secondary" onClick={() => setActive(s)}>{s.label}</Button>)}
        </div>
      )}
      {active && <ActionDialog spec={active} issue={d.issue} onDone={reload} onClose={() => setActive(null)} />}
    </div>
  )
}

function MetaEdit({ d, reload }: { d: IssueDetail; reload: () => void }) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(d.issue.title)
  const [kind, setKind] = useState(d.issue.kind)
  const [err, setErr] = useState<string | null>(null)
  async function save() {
    try {
      const body: Record<string, string> = {}
      if (title.trim() !== d.issue.title) body.title = title.trim()
      if (kind !== d.issue.kind) body.kind = kind
      if (!Object.keys(body).length) return setOpen(false)
      await api.post(`/issues/${d.issue.id}/meta`, body)
      toast("Saved")
      setOpen(false)
      reload()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => { setTitle(d.issue.title); setKind(d.issue.kind); setErr(null); setOpen(true) }}><Pencil /> Edit</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Edit issue">
          <div className="space-y-3">
            <div><Label htmlFor="m-title">Title</Label><Input id="m-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></div>
            <div>
              <Label htmlFor="m-kind">Kind</Label>
              <Select id="m-kind" value={kind} onChange={(e) => setKind(e.target.value as "bug" | "suggestion")}>
                <option value="bug">bug</option><option value="suggestion">suggestion</option>
              </Select>
            </div>
            <ErrorBox error={err} />
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={save} disabled={!title.trim()}>Save</Button></div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/* ---------------- tabs ---------------- */

function MessageItem({ m }: { m: Message }) {
  return (
    <li className={cn("rounded-lg border p-3", m.isBot ? "border-dashed bg-background" : "bg-card")}>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className={cn("font-semibold", m.isBot ? "text-primary" : "text-foreground")}>{m.isBot ? (m.author.name ?? "Kora QA") : <PersonName person={m.author} />}</span>
        {m.isBot && <Badge variant="primary" className="min-h-0 py-0 text-[10px]">bot</Badge>}
        <span title={when(m.createdAt)}>{ago(m.createdAt)}</span>
      </div>
      <Markdown className={m.isBot ? "text-[13px] text-muted-foreground" : undefined}>{m.content}</Markdown>
      {m.attachments.length > 0 && <div className="mt-2"><Screenshots files={m.attachments} /></div>}
    </li>
  )
}

function Thread({ d, reload }: { d: IssueDetail; reload: () => void }) {
  const toast = useToast()
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [hideBot, setHideBot] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const msgs = hideBot ? d.messages.filter((m) => !m.isBot) : d.messages
  async function send() {
    setBusy(true)
    setErr(null)
    try {
      await api.post(`/issues/${d.issue.id}/comments`, { content: text.trim() })
      setText("")
      toast("Comment posted")
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{d.messages.length} message{d.messages.length === 1 ? "" : "s"}</span>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={hideBot} onChange={(e) => setHideBot(e.target.checked)} /> hide bot notices</label>
      </div>
      {msgs.length === 0 ? <Empty>No messages yet.</Empty> : <ol className="space-y-2">{msgs.map((m) => <MessageItem key={m.id} m={m} />)}</ol>}
      <Card>
        <CardBody className="space-y-2">
          <Label htmlFor="comment">Add a comment (markdown)</Label>
          <Textarea id="comment" value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} placeholder="Me too, every time…" onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim()) send() }} />
          <ErrorBox error={err} />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">{text.length}/4000 · the fixer sees comments too</span>
            <Button onClick={send} disabled={busy || !text.trim()}>{busy ? "Posting…" : "Comment"}</Button>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

function EventItem({ e }: { e: IssueEvent }) {
  const { statusLabel } = useSession()
  const [open, setOpen] = useState(false)
  const attempt = (e.data as { attempt?: Record<string, string> } | null)?.attempt
  const output = (e.data as { output?: string } | null)?.output
  return (
    <li className="relative pb-4 pl-6 last:pb-0">
      <span className={cn("absolute left-0 top-1.5 size-2.5 rounded-full border-2 border-background", e.type === "status" ? "bg-primary" : e.type === "fix" ? "bg-warning" : e.type === "xp" ? "bg-success" : "bg-control-border")} />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{e.type}</span>
        {e.type === "status" && (
          <span className="flex flex-wrap items-center gap-1">
            {e.from ? <StatusBadge status={e.from} /> : <span className="text-xs text-muted-foreground">new</span>}
            <span className="text-muted-foreground">→</span>
            {e.to && <StatusBadge status={e.to} label={statusLabel(e.to)} />}
          </span>
        )}
        <span className="text-xs text-muted-foreground">{e.by?.name ?? "system"} · <span title={when(e.at)}>{ago(e.at)}</span></span>
      </div>
      {e.note && <div className="mt-0.5 whitespace-pre-wrap break-words text-sm text-muted-foreground">{e.note}</div>}
      {attempt && (
        <div className="mt-1 rounded-md border bg-background p-2 text-xs">
          {attempt.summary && <div><span className="text-muted-foreground">Summary: </span>{attempt.summary}</div>}
          {attempt.reasoning && <div><span className="text-muted-foreground">Why: </span>{attempt.reasoning}</div>}
          <div className="text-muted-foreground">{[attempt.resource, attempt.model, attempt.commit && `commit ${attempt.commit}`, attempt.patchId && `patch ${attempt.patchId}`].filter(Boolean).join(" · ")}</div>
        </div>
      )}
      {(output || (e.data && e.type !== "status" && e.type !== "comment")) && (
        <button className="mt-1 text-xs text-muted-foreground underline" onClick={() => setOpen(!open)}>{open ? "hide" : "details"}</button>
      )}
      {open && <Pre className="mt-1 max-h-72">{output ?? json(e.data)}</Pre>}
    </li>
  )
}

function bugMd(p: PromptPreview): string {
  const lines = [`# ${p.title}`, "", `Thread ${p.threadId} · status ${p.status} · ${p.url}`, ""]
  if (p.modOverride) lines.push(`Mod override (${p.modOverride.by}, ${p.modOverride.at}): ${p.modOverride.reason}`, "")
  for (const m of p.messages) {
    lines.push(`## ${m.author}${m.isBot ? " [bot]" : ""} (${m.createdAt})`, "", m.content)
    for (const a of m.attachments) lines.push(`attachment: ${a}`)
    lines.push("")
  }
  return lines.join("\n")
}

function PromptTab({ d }: { d: IssueDetail }) {
  const [mode, setMode] = useState<"md" | "json">("md")
  const p = d.promptPreview
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-armour-border bg-armour-soft p-3 text-sm">
        This is exactly what the automatic fixer receives for this issue (<code className="font-mono text-xs">GET /bug/{d.issue.id}</code>). Testers' text is untrusted input to it.
      </div>
      {!p ? <Empty>No prompt preview.</Empty> : (
        <Card>
          <CardHeader title="Fixer input" actions={<>
            <Select value={mode} onChange={(e) => setMode(e.target.value as "md" | "json")} className="h-8 w-auto text-xs"><option value="md">BUG.md</option><option value="json">JSON</option></Select>
            <CopyButton text={mode === "md" ? bugMd(p) : json(p)} />
          </>} />
          <CardBody><Pre className="max-h-[70vh]">{mode === "md" ? bugMd(p) : json(p)}</Pre></CardBody>
        </Card>
      )}
      {d.prompts.length > 0 && (
        <Card>
          <CardHeader title={`Stored prompts (${d.prompts.length})`} />
          <CardBody className="space-y-2">
            {d.prompts.map((pr) => (
              <details key={pr.id} className="rounded-lg border">
                <summary className="cursor-pointer px-3 py-2 text-sm"><Badge variant="outline">{pr.kind}</Badge> <span className="text-xs text-muted-foreground">{when(pr.createdAt)}</span></summary>
                <div className="border-t p-3"><Markdown>{pr.content}</Markdown></div>
              </details>
            ))}
          </CardBody>
        </Card>
      )}
    </div>
  )
}

function FixesTab({ d }: { d: IssueDetail }) {
  const { can } = useSession()
  const cf = d.currentFix
  return (
    <div className="space-y-3">
      {cf && (
        <Card>
          <CardHeader title="Current fix" actions={can("dev") ? <Button asChild size="sm"><Link to={`/fixes/${d.issue.id}`}><GitPullRequest /> Review diff</Link></Button> : undefined} />
          <CardBody className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-1.5">
              <Badge variant={cf.state === "waiting" ? "warning" : cf.state === "applied" ? "success" : "default"}>{cf.state}</Badge>
              <RiskBadge risk={cf.risk} />
              {cf.model && <Badge variant="outline">{cf.model}</Badge>}
              {cf.resources.map((r) => <Badge key={r} variant="outline" className="font-mono">{r}</Badge>)}
            </div>
            {cf.summary && <div>{cf.summary}</div>}
            <div className="text-xs text-muted-foreground">patch {cf.patchId ?? "—"}{cf.appliedAt ? ` · applied ${when(cf.appliedAt)}` : ""}</div>
          </CardBody>
        </Card>
      )}
      {d.fixes.length === 0 && !cf ? <Empty>No fix attempts yet.</Empty> : d.fixes.map((f) => (
        <Card key={f.id}>
          <CardHeader title={<span className="font-mono text-xs">{f.patchId}</span>} actions={<>
            {f.isHistory ? <Badge>history</Badge> : <Badge variant="primary">current</Badge>}
            {f.applied ? <Badge variant="success">applied {when(f.applied.appliedAt ?? null)}</Badge> : null}
            <RiskBadge risk={f.risk} />
          </>} />
          <CardBody className="space-y-2 text-sm">
            <div className="text-xs text-muted-foreground">{f.model} · {when(f.createdAt)}</div>
            {f.summary && <Markdown>{f.summary}</Markdown>}
            {f.details && <details><summary className="cursor-pointer text-xs text-muted-foreground">Details</summary><Markdown className="mt-1">{f.details}</Markdown></details>}
            {f.testSteps && <details><summary className="cursor-pointer text-xs text-muted-foreground">Test steps</summary><Markdown className="mt-1">{f.testSteps}</Markdown></details>}
            {f.scenario && <details><summary className="cursor-pointer text-xs text-muted-foreground">Scenario</summary><Pre className="mt-1">{f.scenario}</Pre></details>}
          </CardBody>
        </Card>
      ))}
    </div>
  )
}

/* ---------------- page ---------------- */

export function IssueDetailPage() {
  const { id = "" } = useParams()
  const { data: d, error, loading, reload } = useApi<IssueDetail>(`/issues/${enc(id)}`)
  const { can } = useSession()
  const [tab, setTab] = useState<Tab>("report")
  const reportShots = useMemo(() => (d?.attachments ?? []).filter((a) => a.messageId === null), [d])

  if (!d) return loading ? <Loading /> : <ErrorBox error={error} onRetry={reload} />
  const i = d.issue
  const failedIdx = i.failedStep ?? i.report?.failedIdx ?? null

  return (
    <div className="space-y-4">
      <PageHeader
        back={{ to: "/issues", label: "Issues" }}
        title={i.title || "(untitled)"}
        subtitle={<>
          <StatusBadge status={i.status} label={i.statusLabel} />
          <KindBadge kind={i.kind} />
          <span className="rounded bg-surface-raised px-1.5 py-0.5 text-xs">{i.source}</span>
          <span>by <PersonName person={i.reporter} /></span>
          <span title={when(i.createdAt)}>· opened {ago(i.createdAt)}</span>
          {i.notFixedCount > 0 && <Badge variant="warning">not fixed ×{i.notFixedCount}</Badge>}
        </>}
        actions={<>
          {can("dev") && <MetaEdit d={d} reload={reload} />}
          <CopyButton text={i.url} label="Link" />
        </>}
      />
      <ErrorBox error={error} onRetry={reload} />
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">#{i.id}</span>
        {i.scenarioId && <Link className="font-mono hover:text-foreground hover:underline" to={`/scenarios/${enc(i.scenarioId)}`}>{i.scenarioId}</Link>}
        {i.runId && <Link className="hover:text-foreground hover:underline" to={`/runs/${i.runId}`}>run #{i.runId}</Link>}
        {i.legacy && <Badge variant="outline">imported from Discord</Badge>}
      </div>

      {i.modOverride && (
        <div className="flex gap-2 rounded-lg border border-warning-border bg-warning-soft p-3 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <div><span className="font-semibold text-warning">Mod override</span> by {i.modOverride.by} ({ago(i.modOverride.at)}): {i.modOverride.reason}</div>
        </div>
      )}
      {d.currentFix && d.currentFix.state === "waiting" && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-armour-border bg-armour-soft p-3 text-sm">
          <GitPullRequest className="size-4 text-armour" />
          <span className="min-w-0 flex-1">A fix is waiting for review{d.currentFix.summary ? `: ${d.currentFix.summary}` : "."}</span>
          {can("dev") && <Button asChild size="sm" variant="secondary"><Link to={`/fixes/${i.id}`}>Review</Link></Button>}
        </div>
      )}
      {i.status === "awaiting_test" && d.allowedOps.includes("works") && (
        <div className="rounded-lg border border-brand-border bg-brand-soft p-3 text-sm">
          A fix is live. Please test it in game{d.scenario ? " (the scenario is in your Retests tab)" : ""}, then press <b>Works</b> or <b>Not fixed</b>.
        </div>
      )}

      <Actions d={d} reload={reload} />

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        items={[
          { value: "report", label: "Report" },
          { value: "thread", label: <>Thread <span className="text-xs text-muted-foreground">{d.messages.length}</span></> },
          { value: "history", label: <>History <span className="text-xs text-muted-foreground">{d.events.length}</span></> },
          { value: "prompt", label: "Prompt preview" },
          { value: "fixes", label: <>Fixes <span className="text-xs text-muted-foreground">{d.fixes.length}</span></> },
          { value: "runs", label: <>Runs <span className="text-xs text-muted-foreground">{d.runs.length}</span></>, hidden: d.runs.length === 0 },
        ]}
      />

      {tab === "report" && (
        <div className="space-y-3">
          {d.scenario?.steps && (
            <Card>
              <CardHeader title={<Link className="hover:underline" to={`/scenarios/${enc(d.scenario.id)}`}>Scenario: {d.scenario.name}</Link>} actions={<Tags tags={d.scenario.tags} />} />
              <CardBody>
                <GherkinSteps
                  steps={d.scenario.steps}
                  statuses={i.report?.steps ? new Map(i.report.steps.map((s) => [s.idx, s.status])) : undefined}
                  failedIdx={failedIdx}
                />
              </CardBody>
            </Card>
          )}
          {i.report ? (
            <ReportView report={d.scenario?.steps ? { ...i.report, steps: undefined } : i.report} screenshots={reportShots} />
          ) : d.renderedReport ? (
            <Card><CardBody><Markdown>{d.renderedReport}</Markdown>{reportShots.length > 0 && <div className="mt-3"><Screenshots files={reportShots} /></div>}</CardBody></Card>
          ) : (
            <Card>
              <CardBody className="space-y-3">
                <div className="text-sm text-muted-foreground">No structured report (imported or freeform post). The original post is the first message in the thread.</div>
                {d.messages[0] && <ol><MessageItem m={d.messages[0]} /></ol>}
                {reportShots.length > 0 && <Screenshots files={reportShots} />}
              </CardBody>
            </Card>
          )}
          {i.legacy && (
            <details className="rounded-lg border bg-card">
              <summary className="cursor-pointer px-4 py-2 text-sm text-muted-foreground">Imported Discord metadata</summary>
              <div className="p-3 pt-0"><Pre>{json(i.legacy)}</Pre></div>
            </details>
          )}
        </div>
      )}
      {tab === "thread" && <Thread d={d} reload={reload} />}
      {tab === "history" && (
        <Card><CardBody>{d.events.length ? <ol className="border-l border-border pl-0 [&>li]:ml-[-5px]">{[...d.events].reverse().map((e) => <EventItem key={e.id} e={e} />)}</ol> : <Empty>No events.</Empty>}</CardBody></Card>
      )}
      {tab === "prompt" && <PromptTab d={d} />}
      {tab === "fixes" && <FixesTab d={d} />}
      {tab === "runs" && <Card><RunRows items={d.runs} /></Card>}
      {tab === "report" && d.runs.length > 0 && (
        <div className="text-xs text-muted-foreground">Runs: {d.runs.map((r) => <Link key={r.id} to={`/runs/${r.id}`} className="mr-2 inline-flex items-center gap-1 hover:text-foreground"><RunBadge status={r.status} /> #{r.id}</Link>)}</div>
      )}
      {i.url && <a href={i.url} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" target="_blank" rel="noreferrer"><ExternalLink className="size-3" /> {i.url}</a>}
    </div>
  )
}
