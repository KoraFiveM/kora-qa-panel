import { Link, useParams } from "react-router-dom"
import { Medal } from "lucide-react"
import { Card, CardBody, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Empty, ErrorBox, Loading, PageHeader, Pre, Stat } from "@/components/common"
import { IssueRows } from "@/components/issue-list"
import { RunRows } from "@/components/run-list"
import { enc } from "@/lib/api"
import { useApi } from "@/lib/useApi"
import { ago, json } from "@/lib/format"
import { cn } from "@/lib/cn"
import type { IssueSummary, Run, TesterStats } from "@/lib/types"

const MEDAL = ["text-[#FFD700]", "text-[#C0C0C0]", "text-[#CD7F32]"]

export function TestersPage() {
  const { data, error, loading, reload } = useApi<{ items: TesterStats[] }>("/testers")
  if (!data) return loading ? <Loading /> : <ErrorBox error={error} onRetry={reload} />
  return (
    <div className="space-y-3">
      <PageHeader title="Testers" subtitle="Ranked by passed runs + reported issues" />
      <Card>
        {data.items.length === 0 ? <Empty>No tester activity yet.</Empty> : (
          <ol className="divide-y">
            {data.items.map((t, i) => (
              <li key={t.discordId}>
                <Link to={`/testers/${t.discordId}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-hover">
                  <span className={cn("w-7 text-center text-sm font-semibold tabular-nums text-muted-foreground", MEDAL[i])}>{i < 3 ? <Medal className="mx-auto size-5" /> : i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 truncate text-sm font-medium">{t.name ?? t.discordId}{t.role && t.role !== "tester" && <Badge variant={t.role === "admin" ? "primary" : "armour"}>{t.role}</Badge>}</div>
                    <div className="text-xs text-muted-foreground">last run {ago(t.runs.lastAt)}</div>
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-right text-xs tabular-nums sm:gap-6">
                    <div><div className="text-sm font-semibold text-success">{t.runs.passed}</div><div className="text-muted-foreground">passed</div></div>
                    <div><div className="text-sm font-semibold">{t.runs.total}</div><div className="text-muted-foreground">runs</div></div>
                    <div><div className="text-sm font-semibold text-primary">{t.issues.reported}</div><div className="text-muted-foreground">reported</div></div>
                  </div>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  )
}

export function TesterDetailPage() {
  const { discordId = "" } = useParams()
  const { data, error, loading, reload } = useApi<{ tester: TesterStats; recentRuns: Run[]; reported: IssueSummary[] }>(`/testers/${enc(discordId)}`)
  if (!data) return loading ? <Loading /> : <ErrorBox error={error} onRetry={reload} />
  const t = data.tester
  return (
    <div className="space-y-4">
      <PageHeader back={{ to: "/testers", label: "Testers" }} title={t.name ?? t.discordId} subtitle={<><span className="font-mono text-xs">{t.discordId}</span>{t.role && <Badge>{t.role}</Badge>}</>} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Runs" value={t.runs.total} hint={t.runs.legacy ? `${t.runs.legacy} legacy` : undefined} to={`/runs?discordId=${t.discordId}`} />
        <Stat label="Passed" value={t.runs.passed} tone="success" hint={`${t.runs.failed} failed`} />
        <Stat label="Reported" value={t.issues.reported} tone="primary" />
        <Stat label="Fixed" value={t.issues.fixed} tone="success" hint={`${t.issues.closed} closed otherwise`} />
      </div>
      <Card><CardHeader title="Recent runs" />{data.recentRuns.length ? <RunRows items={data.recentRuns} /> : <Empty>No runs.</Empty>}</Card>
      <Card><CardHeader title="Reported issues" />{data.reported.length ? <IssueRows items={data.reported} /> : <Empty>No issues.</Empty>}</Card>
      {t.legacyStats && (
        <Card><CardHeader title="Imported stats (Discord era)" /><CardBody><Pre>{json(t.legacyStats)}</Pre></CardBody></Card>
      )}
    </div>
  )
}
