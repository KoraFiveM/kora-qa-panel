import { Link } from "react-router-dom"
import { PersonName, RunBadge } from "@/components/common"
import { ago, duration } from "@/lib/format"
import type { Run } from "@/lib/types"

export function RunRows({ items, showScenario = true }: { items: Run[]; showScenario?: boolean }) {
  return (
    <ul className="divide-y">
      {items.map((r) => (
        <li key={r.id}>
          <Link to={`/runs/${r.id}`} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover">
            <RunBadge status={r.status} />
            <div className="min-w-0 flex-1">
              {showScenario && <div className="truncate text-sm">{r.scenarioName ?? r.scenarioId ?? (r.legacyTestId ? `legacy: ${r.legacyTestId}` : `run #${r.id}`)}</div>}
              <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                <span>#{r.id}</span>
                <span><PersonName person={r.tester} link={false} /></span>
                <span>{ago(r.startedAt)}</span>
                {r.finishedAt && <span>· {duration(r.startedAt, r.finishedAt)}</span>}
                {r.resource && <span className="font-mono">{r.resource}</span>}
                {r.legacy && <span className="text-warning">legacy</span>}
                {r.issueId && <span className="text-primary">→ issue</span>}
              </div>
              {r.note && <div className="mt-0.5 truncate text-xs italic text-muted-foreground">“{r.note}”</div>}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}
