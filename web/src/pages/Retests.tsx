import { Card } from "@/components/ui/card"
import { Empty, ErrorBox, Loading, PageHeader } from "@/components/common"
import { IssueRows } from "@/components/issue-list"
import { useApi } from "@/lib/useApi"
import type { IssueSummary } from "@/lib/types"

export function RetestsPage() {
  const { data, error, loading, reload } = useApi<{ items: IssueSummary[] }>("/retests")
  return (
    <div className="space-y-3">
      <PageHeader title="Retests" subtitle="Fixes that are live and need a tester. Oldest first." />
      <div className="rounded-lg border border-brand-border bg-brand-soft p-3 text-sm">
        Retest in game (kora_qa → Retests tab runs the scenario for you), or open an issue and press <b>Works</b> / <b>Not fixed</b>.
      </div>
      <ErrorBox error={error} onRetry={reload} />
      <Card>{!data ? (loading ? <Loading /> : null) : data.items.length === 0 ? <Empty>Nothing to retest right now.</Empty> : <IssueRows items={data.items} showScenario />}</Card>
    </div>
  )
}
