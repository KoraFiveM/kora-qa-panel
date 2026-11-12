import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { AlertTriangle, X } from "lucide-react"
import { Card, CardBody, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/input"
import { Chips, Empty, ErrorBox, KV, Loading, PageHeader, Pager, PersonName, RunBadge, Spinner } from "@/components/common"
import { GherkinSteps, StatusSteps } from "@/components/gherkin"
import { RunRows } from "@/components/run-list"
import { ReportView } from "@/components/report"
import { enc, qs } from "@/lib/api"
import { useApi } from "@/lib/useApi"
import { useQueryState } from "@/lib/useParams"
import { useSession } from "@/lib/session"
import { duration, when } from "@/lib/format"
import type { Paged, Report, Run, RunStep, Scenario } from "@/lib/types"

export function RunsPage() {
  const { meta } = useSession()
  const { get, list, set } = useQueryState()
  const status = list("status")
  const resource = get("resource")
  const scenarioId = get("scenarioId")
  const discordId = get("discordId")
  const legacy = get("legacy")
  const page = Number(get("page", "1")) || 1
  const [res, setRes] = useState(resource)
  useEffect(() => setRes(resource), [resource])
  const { data, error, loading, reload } = useApi<Paged<Run>>(`/runs${qs({ status, resource, scenarioId, discordId, legacy, page: page > 1 ? page : "" })}`)
  return (
    <div className="space-y-3">
      <PageHeader title="Runs" subtitle={data ? `${data.total} runs` : undefined} />
      <div className="flex flex-wrap items-center gap-2">
        <Chips options={(meta?.runStatuses ?? ["running", "passed", "failed", "aborted", "blocked"]).map((k) => ({ key: k, label: k }))} value={status} onChange={(v) => set({ status: v })} />
        <form onSubmit={(e) => { e.preventDefault(); set({ resource: res.trim() }) }}><Input value={res} onChange={(e) => setRes(e.target.value)} onBlur={() => res !== resource && set({ resource: res.trim() })} placeholder="resource" className="h-8 w-36" /></form>
        <Select value={legacy} onChange={(e) => set({ legacy: e.target.value })} className="h-8 w-auto text-xs">
          <option value="">All runs</option><option value="0">New (scenario) runs</option><option value="1">Legacy runs</option>
        </Select>
        {(scenarioId || discordId) && (
          <Button size="sm" variant="ghost" onClick={() => set({ scenarioId: "", discordId: "" })}><X /> {scenarioId ? `scenario ${scenarioId}` : `tester ${discordId}`}</Button>
        )}
        {loading && <Spinner />}
      </div>
      <ErrorBox error={error} onRetry={reload} />
      <Card>{!data ? <Loading /> : data.items.length === 0 ? <Empty>No runs match.</Empty> : <RunRows items={data.items} />}</Card>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set({ page: p })} />}
    </div>
  )
}

interface RunDetail { run: Run & { context: (Report & { retestIssueId?: string }) | null }; steps: RunStep[]; scenario: Scenario | null; scenarioChanged: boolean }

export function RunDetailPage() {
  const { id = "" } = useParams()
  const { data, error, loading, reload } = useApi<RunDetail>(`/runs/${enc(id)}`)
  if (!data) return loading ? <Loading /> : <ErrorBox error={error} onRetry={reload} />
  const { run, steps, scenario } = data
  const ctx = run.context
  const isReport = ctx && (ctx.steps || ctx.player || ctx.timeline || ctx.expected || ctx.console)
  const statusMap = new Map(steps.map((s) => [s.idx, s.status]))
  return (
    <div className="space-y-4">
      <PageHeader
        back={{ to: "/runs", label: "Runs" }}
        title={run.scenarioName ?? scenario?.name ?? (run.legacyTestId ? `Legacy test ${run.legacyTestId}` : `Run #${run.id}`)}
        subtitle={<><RunBadge status={run.status} /><span>#{run.id}</span><span>by <PersonName person={run.tester} /></span>{run.legacy && <Badge variant="warning">legacy</Badge>}</>}
      />
      {data.scenarioChanged && (
        <div className="flex gap-2 rounded-lg border border-warning-border bg-warning-soft p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" /> The scenario was edited since this run; steps below are from the run, the Gherkin is the current version.
        </div>
      )}
      <Card>
        <CardBody>
          <KV items={[
            ["Scenario", run.scenarioId ? <Link className="font-mono text-xs hover:underline" to={`/scenarios/${enc(run.scenarioId)}`}>{run.scenarioId}</Link> : run.legacyTestId ?? "—"],
            ["Started", when(run.startedAt)],
            ["Finished", run.finishedAt ? `${when(run.finishedAt)} (${duration(run.startedAt, run.finishedAt)})` : "still running"],
            ["Issue", run.issueId ? <Link className="text-primary hover:underline" to={`/issues/${run.issueId}`}>#{run.issueId}</Link> : "—"],
            ...(ctx?.retestIssueId ? [["Retest of", <Link className="text-primary hover:underline" to={`/issues/${ctx.retestIssueId}`}>#{ctx.retestIssueId}</Link>] as [string, React.ReactNode]] : []),
            ["Note", run.note],
          ]} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Step results" />
        <CardBody>
          {scenario?.steps && !data.scenarioChanged ? (
            <GherkinSteps steps={scenario.steps} statuses={statusMap} />
          ) : steps.length ? (
            <StatusSteps steps={steps} />
          ) : <Empty>No step results.</Empty>}
          {scenario?.steps && !data.scenarioChanged && steps.some((s) => s.detail) && (
            <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">Step details</summary><div className="mt-2"><StatusSteps steps={steps} /></div></details>
          )}
        </CardBody>
      </Card>
      {isReport && <ReportView report={{ ...ctx!, steps: undefined }} />}
    </div>
  )
}
