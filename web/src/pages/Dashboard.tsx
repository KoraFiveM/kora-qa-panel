import { Link } from "react-router-dom"
import { Card, CardBody, CardHeader } from "@/components/ui/card"
import { Empty, ErrorBox, Loading, PageHeader, Stat, StatusBadge } from "@/components/common"
import { IssueRows } from "@/components/issue-list"
import { useApi } from "@/lib/useApi"
import { useSession } from "@/lib/session"
import { ago, pct } from "@/lib/format"
import type { Dashboard } from "@/lib/types"
import { cn } from "@/lib/cn"

export function DashboardPage() {
  const { data, error, loading, reload } = useApi<Dashboard>("/dashboard")
  const { meta, can, user } = useSession()
  if (!data) return loading ? <Loading /> : <ErrorBox error={error} onRetry={reload} />
  const statuses = meta?.statuses ?? Object.keys(data.issuesByStatus).map((k) => ({ key: k, label: k, closed: ["fixed", "dup", "wontfix"].includes(k) }))
  const openStatuses = statuses.filter((s) => !s.closed)
  const maxOpen = Math.max(1, ...openStatuses.map((s) => data.issuesByStatus[s.key] ?? 0))
  const rt = data.runsToday
  return (
    <div className="space-y-4">
      <PageHeader title={`Hi ${user?.name ?? "there"}`} subtitle="What's happening on the dev server" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Open issues" value={data.openTotal} to="/issues?state=open" />
        <Stat label="Awaiting test" value={data.awaitingTest} tone={data.awaitingTest ? "primary" : undefined} to="/retests" hint="retest these" />
        <Stat label="Runs today" value={rt.total} hint={<><span className="text-success">{rt.passed} passed</span> · <span className="text-destructive">{rt.failed} failed</span></>} to="/runs" />
        {can("dev") ? (
          <Stat label="Fixes waiting" value={data.waitingFixes} tone={data.waitingFixes ? "warning" : undefined} to="/fixes" hint="need review" />
        ) : (
          <Stat label="Scenarios" value={data.scan?.valid ?? "—"} hint={data.scan?.invalid ? `${data.scan.invalid} invalid` : "valid"} to="/scenarios" />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Open issues by status" actions={<Link className="text-xs text-muted-foreground hover:text-foreground" to="/issues">All issues →</Link>} />
          <CardBody className="space-y-1.5">
            {openStatuses.map((s) => {
              const n = data.issuesByStatus[s.key] ?? 0
              return (
                <Link key={s.key} to={`/issues?status=${s.key}`} className="group flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-surface-hover">
                  <div className="w-44 shrink-0 sm:w-52"><StatusBadge status={s.key} label={s.label} /></div>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-raised">
                    <div className="h-full rounded-full bg-primary/70" style={{ width: `${(n / maxOpen) * 100}%` }} />
                  </div>
                  <span className={cn("w-8 text-right text-sm tabular-nums", !n && "text-muted-foreground")}>{n}</span>
                </Link>
              )
            })}
            <div className="flex flex-wrap gap-3 border-t pt-2 text-xs text-muted-foreground">
              {statuses.filter((s) => s.closed).map((s) => (
                <Link key={s.key} to={`/issues?status=${s.key}`} className="hover:text-foreground">{s.label}: <span className="tabular-nums text-foreground">{data.issuesByStatus[s.key] ?? 0}</span></Link>
              ))}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Pass rate by resource" actions={<span className="text-xs text-muted-foreground">last 30 days</span>} />
          <CardBody className="p-0">
            {data.passRateByResource.length === 0 ? <Empty>No scenario runs yet.</Empty> : (
              <ul className="divide-y">
                {data.passRateByResource.map((r) => (
                  <li key={r.resource}>
                    <Link to={`/runs?resource=${encodeURIComponent(r.resource)}`} className="flex items-center gap-3 px-4 py-2 hover:bg-surface-hover">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.resource}</span>
                      <div className="hidden h-2 w-24 overflow-hidden rounded-full bg-destructive/40 sm:block">
                        <div className="h-full bg-success" style={{ width: `${(r.rate ?? 0) * 100}%` }} />
                      </div>
                      <span className="w-20 text-right text-xs text-muted-foreground"><span className="text-success">{r.passed}</span>/<span>{r.runs}</span></span>
                      <span className={cn("w-10 text-right text-sm font-semibold tabular-nums", (r.rate ?? 0) >= 0.8 ? "text-success" : (r.rate ?? 0) >= 0.5 ? "text-warning" : "text-destructive")}>{pct(r.rate)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Flaky scenarios" actions={<span className="text-xs text-muted-foreground">passed and failed, 30 days</span>} />
          <CardBody className="p-0">
            {data.flaky.length === 0 ? <Empty>Nothing flaky.</Empty> : (
              <ul className="divide-y">
                {data.flaky.map((f) => (
                  <li key={f.scenarioId}>
                    <Link to={`/scenarios/${encodeURIComponent(f.scenarioId)}`} className="flex items-center gap-2 px-4 py-2 hover:bg-surface-hover">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{f.name}</div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground">{f.resource}</div>
                      </div>
                      <span className="text-xs"><span className="text-success">{f.passed}✓</span> <span className="text-destructive">{f.failed}✗</span></span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Health" />
          <CardBody className="space-y-2 text-sm">
            {data.scan ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>Scenario scan {ago(data.scan.at)}:</span>
                <Link to="/scenarios" className="text-success hover:underline">{data.scan.valid} valid</Link>
                <Link to="/scenarios?tab=invalid" className={cn("hover:underline", data.scan.invalid ? "text-warning" : "text-muted-foreground")}>{data.scan.invalid} invalid</Link>
              </div>
            ) : <div className="text-muted-foreground">No scenario scan yet.</div>}
            {data.scan?.catalogError && <ErrorBox error={`Step catalog: ${data.scan.catalogError}`} />}
            {data.xpOutbox && can("admin") && (
              <div className="flex flex-wrap items-center gap-x-3">
                <span>XP outbox:</span>
                <span className={data.xpOutbox.pending ? "text-warning" : "text-success"}>{data.xpOutbox.pending} pending</span>
                <span className={data.xpOutbox.failing ? "text-destructive" : "text-muted-foreground"}>{data.xpOutbox.failing} failing</span>
                {data.xpOutbox.failing > 0 && <span className="text-xs text-muted-foreground">(communitybot /qa-xp unreachable or refusing?)</span>}
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Recently updated" />
        {data.recentIssues.length ? <IssueRows items={data.recentIssues} /> : <Empty>No issues yet.</Empty>}
      </Card>
    </div>
  )
}
