import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { CheckCircle2, RefreshCw, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardBody, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input, Select } from "@/components/ui/input"
import { Tabs } from "@/components/ui/tabs"
import { Empty, ErrorBox, KV, Loading, PageHeader, Pager, Pre, RunBadge, Spinner, useToast } from "@/components/common"
import { GherkinSteps, Tags } from "@/components/gherkin"
import { IssueRows } from "@/components/issue-list"
import { RunRows } from "@/components/run-list"
import { api, enc, qs } from "@/lib/api"
import { useApi } from "@/lib/useApi"
import { useQueryState } from "@/lib/useParams"
import { useSession } from "@/lib/session"
import { ago, json, when } from "@/lib/format"
import { cn } from "@/lib/cn"
import type { IssueSummary, Paged, Run, Scenario, ScanSummary } from "@/lib/types"

type ScenarioList = Paged<Scenario> & { resources: { resource: string; total: number; valid: number; invalid: number }[] }
type Tab = "list" | "coverage" | "invalid"

function Progress({ s }: { s: Scenario }) {
  const n = s.distinctPassers ?? 0
  const t = Math.max(1, s.target || 1)
  return (
    <div className="flex items-center gap-1.5" title={`${n} of ${t} different testers passed this version`}>
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-surface-raised">
        <div className={cn("h-full rounded-full", s.done ? "bg-success" : "bg-primary/70")} style={{ width: `${Math.min(100, (n / t) * 100)}%` }} />
      </div>
      <span className={cn("text-xs tabular-nums", s.done ? "text-success" : "text-muted-foreground")}>{n}/{t}</span>
      {s.done && <CheckCircle2 className="size-3.5 text-success" />}
    </div>
  )
}

function ScenarioList() {
  const { get, set } = useQueryState()
  const resource = get("resource")
  const tag = get("tag")
  const q = get("q")
  const valid = get("valid")
  const removed = get("removed")
  const page = Number(get("page", "1")) || 1
  const [text, setText] = useState(q)
  const [tagText, setTagText] = useState(tag)
  useEffect(() => setText(q), [q])
  useEffect(() => setTagText(tag), [tag])
  const { data, error, loading, reload } = useApi<ScenarioList>(`/scenarios${qs({ resource, tag, q, valid, removed, page: page > 1 ? page : "" })}`)
  const resources = data?.resources ?? []

  return (
    <div className="space-y-3">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); set({ q: text.trim(), tag: tagText.trim() ? (tagText.trim().startsWith("@") ? tagText.trim() : `@${tagText.trim()}`) : "" }) }}>
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search name or id" className="pl-8" />
        </div>
        <Input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="@tag" className="w-28" />
        <Select value={resource} onChange={(e) => set({ resource: e.target.value })} className="w-auto max-w-[12rem]">
          <option value="">All resources</option>
          {resources.map((r) => <option key={r.resource} value={r.resource}>{r.resource} ({r.total})</option>)}
        </Select>
        <Select value={valid} onChange={(e) => set({ valid: e.target.value })} className="w-auto">
          <option value="">Valid + invalid</option><option value="1">Valid</option><option value="0">Invalid</option>
        </Select>
        <Button type="submit" variant="secondary">Filter</Button>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={removed === "1"} onChange={(e) => set({ removed: e.target.checked ? "1" : "" })} /> removed</label>
        {loading && <Spinner className="self-center" />}
      </form>
      {["@smoke", "@regression", "@manual", "@wip"].length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {["@smoke", "@regression", "@manual", "@wip", "@needs:admin"].map((t) => (
            <button key={t} onClick={() => set({ tag: tag === t ? "" : t })} className={cn("rounded-full border px-2 py-0.5 font-mono text-[11px]", tag === t ? "border-brand-border bg-brand-soft text-primary" : "border-border text-muted-foreground hover:text-foreground")}>{t}</button>
          ))}
        </div>
      )}
      <ErrorBox error={error} onRetry={reload} />
      <Card>
        {!data ? <Loading /> : data.items.length === 0 ? <Empty>No scenarios match.</Empty> : (
          <ul className="divide-y">
            {data.items.map((s) => (
              <li key={s.id}>
                <Link to={`/scenarios/${enc(s.id)}`} className="block px-4 py-2.5 hover:bg-surface-hover">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className={cn("text-sm font-medium", s.removed && "line-through opacity-60")}>{s.name}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        <span className="font-mono">{s.resource}</span>
                        <span className="font-mono">{s.file}:{s.line}</span>
                        {s.stepCount !== undefined && <span>{s.stepCount} steps</span>}
                      </div>
                      {s.tags.filter((t) => t !== `@${s.resource}`).length > 0 && <div className="mt-1"><Tags tags={s.tags.filter((t) => t !== `@${s.resource}`)} /></div>}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {!s.valid ? <Badge variant="warning">invalid</Badge> : s.lastResult ? <span className="flex items-center gap-1"><RunBadge status={s.lastResult.status} /></span> : <Badge>never run</Badge>}
                      {s.valid && <Progress s={s} />}
                      {s.lastResult && <span className="text-[11px] text-muted-foreground">{ago(s.lastResult.at)}</span>}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set({ page: p })} />}
    </div>
  )
}

function Coverage() {
  const { data, error, loading, reload } = useApi<{ items: { resource: string; path: string; optedIn: boolean; featureFiles: number; scenarios: number; valid: number }[]; withoutScenarios: string[] }>("/scenarios/coverage")
  const [onlyMissing, setOnlyMissing] = useState(false)
  if (!data) return loading ? <Loading /> : <ErrorBox error={error} onRetry={reload} />
  const items = onlyMissing ? data.items.filter((i) => i.scenarios === 0) : data.items
  const covered = data.items.length - data.withoutScenarios.length
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span><b className="text-success">{covered}</b> of {data.items.length} resources have scenarios</span>
        <div className="h-2 w-40 overflow-hidden rounded-full bg-surface-raised"><div className="h-full bg-success" style={{ width: `${(covered / Math.max(1, data.items.length)) * 100}%` }} /></div>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> only without scenarios ({data.withoutScenarios.length})</label>
      </div>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr><th className="px-4 py-2 font-medium">Resource</th><th className="px-2 py-2 font-medium">Opted in</th><th className="px-2 py-2 text-right font-medium">Files</th><th className="px-2 py-2 text-right font-medium">Scenarios</th><th className="px-4 py-2 text-right font-medium">Valid</th></tr>
            </thead>
            <tbody className="divide-y">
              {items.map((r) => (
                <tr key={r.resource} className="hover:bg-surface-hover">
                  <td className="px-4 py-1.5">
                    {r.scenarios ? <Link className="font-mono text-xs hover:underline" to={`/scenarios?resource=${enc(r.resource)}`}>{r.resource}</Link> : <span className="font-mono text-xs text-muted-foreground">{r.resource}</span>}
                    <div className="hidden text-[11px] text-muted-foreground sm:block">{r.path}</div>
                  </td>
                  <td className="px-2 py-1.5">{r.optedIn ? <Badge variant="success">qa_feature</Badge> : r.featureFiles ? <Badge variant="warning">files, not opted in</Badge> : <span className="text-xs text-muted-foreground">—</span>}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.featureFiles}</td>
                  <td className={cn("px-2 py-1.5 text-right tabular-nums", !r.scenarios && "text-muted-foreground")}>{r.scenarios}</td>
                  <td className={cn("px-4 py-1.5 text-right tabular-nums", r.valid < r.scenarios && "text-warning")}>{r.valid}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

function Invalid() {
  const { data, error, loading, reload } = useApi<{ items: Scenario[]; scan: ScanSummary | null }>("/scenarios/invalid")
  if (!data) return loading ? <Loading /> : <ErrorBox error={error} onRetry={reload} />
  const scan = data.scan
  return (
    <div className="space-y-3">
      {scan && (
        <div className="text-xs text-muted-foreground">
          Last scan {ago(scan.at)}{scan.ms !== undefined ? ` (${scan.ms} ms)` : ""}: {scan.scenarios} scenarios, {scan.valid} valid, {scan.invalid} invalid.
          {scan.catalog?.error && <span className="text-destructive"> Step catalog error: {scan.catalog.error}</span>}
          {scan.resources?.filter((r) => r.qaLuaError).map((r) => <div key={r.name} className="text-warning">{r.name}/tests/qa.lua: {r.qaLuaError}</div>)}
        </div>
      )}
      {data.items.length === 0 ? <Card><Empty>All scenarios are valid. 🎉</Empty></Card> : data.items.map((s) => (
        <Card key={s.id}>
          <CardHeader title={<Link to={`/scenarios/${enc(s.id)}`} className="hover:underline">{s.name}</Link>} actions={<span className="font-mono text-xs text-muted-foreground">{s.resource}/{s.file}{s.line ? `:${s.line}` : ""}</span>} />
          <CardBody className="space-y-2">
            {s.steps && s.steps.length > 0 ? <GherkinSteps steps={s.steps} errors={s.errors} /> : null}
            {s.errors.filter((e) => typeof e.idx !== "number").map((e, i) => <div key={i} className="text-sm text-warning">⚠ {e.line ? `line ${e.line}: ` : ""}{e.message}</div>)}
          </CardBody>
        </Card>
      ))}
    </div>
  )
}

export function ScenariosPage() {
  const { get, set } = useQueryState()
  const { can } = useSession()
  const toast = useToast()
  const tab = (get("tab", "list") as Tab)
  const [busy, setBusy] = useState(false)
  const [key, setKey] = useState(0)
  async function rescan() {
    setBusy(true)
    try {
      const r = await api.post<{ ok: boolean; scan: ScanSummary }>("/scenarios/rescan", {})
      toast(`Rescanned: ${r.scan.scenarios} scenarios, ${r.scan.invalid} invalid`)
      setKey((k) => k + 1)
    } catch (e) {
      toast((e as Error).message, "error")
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-3">
      <PageHeader title="Scenarios" subtitle="Gherkin tests from each resource's tests/*.feature" actions={can("dev") ? <Button size="sm" variant="outline" onClick={rescan} disabled={busy}><RefreshCw className={busy ? "animate-spin" : undefined} /> Rescan</Button> : undefined} />
      <Tabs<Tab> value={tab} onChange={(t) => set({ tab: t === "list" ? "" : t, resource: "", tag: "", q: "", valid: "" })} items={[{ value: "list", label: "Scenarios" }, { value: "coverage", label: "Coverage" }, { value: "invalid", label: "Invalid" }]} />
      <div key={key}>
        {tab === "list" && <ScenarioList />}
        {tab === "coverage" && <Coverage />}
        {tab === "invalid" && <Invalid />}
      </div>
    </div>
  )
}

/* ---------------- detail ---------------- */

interface ScenarioDetail { scenario: Scenario; runs: Run[]; issues: IssueSummary[]; legacyTests: { id: string; source: string; resource: string; title: string; description: string | null; data: unknown }[] }

export function ScenarioDetailPage() {
  const { id = "" } = useParams()
  const { data, error, loading, reload } = useApi<ScenarioDetail>(`/scenarios/${enc(id)}`)
  if (!data) return loading ? <Loading /> : <ErrorBox error={error} onRetry={reload} />
  const s = data.scenario
  // runs are newest first; the latest one that recorded step results drives the icons
  const lastRun = data.runs.find((r) => r.steps && r.steps.length > 0)
  return (
    <div className="space-y-4">
      <PageHeader
        back={{ to: `/scenarios?resource=${enc(s.resource)}`, label: s.resource }}
        title={s.name}
        subtitle={<>
          {s.valid ? <Badge variant="success">valid</Badge> : <Badge variant="warning">invalid</Badge>}
          {s.removed && <Badge variant="destructive">removed</Badge>}
          {s.done && <Badge variant="success">target reached</Badge>}
          <span className="font-mono text-xs">{s.file}:{s.line}</span>
        </>}
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <div className="min-w-0 space-y-4">
          {s.description && <Card><CardBody><div className="whitespace-pre-wrap text-sm">{s.description}</div></CardBody></Card>}
          <Card>
            <CardHeader title="Steps" actions={<Tags tags={s.tags} />} />
            <CardBody>
              {s.steps ? (
                <GherkinSteps
                  steps={s.steps}
                  errors={s.errors}
                  statuses={lastRun?.steps ? new Map(lastRun.steps.map((x) => [x.idx, x.status])) : undefined}
                />
              ) : <Empty>No steps stored.</Empty>}
              {s.steps && lastRun && (
                <div className="mt-2 text-xs text-muted-foreground">
                  Icons from <Link className="hover:text-foreground hover:underline" to={`/runs/${lastRun.id}`}>run #{lastRun.id}</Link> ({lastRun.status}, {ago(lastRun.startedAt)}{lastRun.tester?.name ? ` by ${lastRun.tester.name}` : ""}){lastRun.scenarioHash && lastRun.scenarioHash !== s.hash ? " — scenario edited since" : ""}.
                </div>
              )}
              {s.errors.filter((e) => typeof e.idx !== "number").map((e, i) => <div key={i} className="mt-2 text-sm text-warning">⚠ {e.line ? `line ${e.line}: ` : ""}{e.message}</div>)}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={`Run history (${data.runs.length})`} actions={<Link to={`/runs?scenarioId=${enc(s.id)}`} className="text-xs text-muted-foreground hover:text-foreground">All runs →</Link>} />
            {data.runs.length ? <RunRows items={data.runs} showScenario={false} /> : <Empty>Never run.</Empty>}
          </Card>
          {data.issues.length > 0 && <Card><CardHeader title={`Issues (${data.issues.length})`} /><IssueRows items={data.issues} /></Card>}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Progress" />
            <CardBody className="space-y-3 text-sm">
              <div>
                <div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>Distinct testers passed</span><span>{s.distinctPassers ?? 0} / {s.target}</span></div>
                <div className="h-2 overflow-hidden rounded-full bg-surface-raised"><div className={cn("h-full", s.done ? "bg-success" : "bg-primary/70")} style={{ width: `${Math.min(100, ((s.distinctPassers ?? 0) / Math.max(1, s.target)) * 100)}%` }} /></div>
              </div>
              <KV items={[
                ["Passes", <span className="text-success">{s.passes ?? 0}</span>],
                ["Fails", <span className="text-destructive">{s.fails ?? 0}</span>],
                ["Last", s.lastResult ? <span className="inline-flex items-center gap-1"><RunBadge status={s.lastResult.status} /> {ago(s.lastResult.at)}</span> : "never"],
                ["Updated", when(s.updatedAt)],
                ["Hash", <span className="font-mono text-[11px]">{s.hash?.slice(0, 12)}</span>],
              ]} />
            </CardBody>
          </Card>
          {data.legacyTests.length > 0 && (
            <Card>
              <CardHeader title="Converted from" />
              <CardBody className="space-y-2 text-sm">
                {data.legacyTests.map((l) => (
                  <details key={l.id}>
                    <summary className="cursor-pointer"><Badge variant="outline">{l.source}</Badge> {l.title}</summary>
                    {l.description && <div className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{l.description}</div>}
                    <Pre className="mt-1 max-h-48">{json(l.data)}</Pre>
                  </details>
                ))}
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
