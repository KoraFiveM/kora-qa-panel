import { Link } from "react-router-dom"
import { MessageSquare, Paperclip } from "lucide-react"
import { KindBadge, PersonName, StatusBadge } from "@/components/common"
import { ago } from "@/lib/format"
import type { IssueSummary } from "@/lib/types"

export function IssueRows({ items, showScenario = false }: { items: IssueSummary[]; showScenario?: boolean }) {
  return (
    <ul className="divide-y">
      {items.map((i) => (
        <li key={i.id}>
          <Link to={`/issues/${i.id}`} className="block px-4 py-3 transition-colors hover:bg-surface-hover">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="break-words text-sm font-medium leading-snug">{i.title || "(untitled)"}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <StatusBadge status={i.status} label={i.statusLabel} />
                  {i.kind !== "bug" && <KindBadge kind={i.kind} />}
                  <span className="rounded bg-surface-raised px-1.5 py-0.5">{i.source}</span>
                  {i.notFixedCount > 0 && <span className="text-warning">not fixed ×{i.notFixedCount}</span>}
                  <span>by <PersonName person={i.reporter} link={false} /></span>
                  <span>· {ago(i.updatedAt)}</span>
                  {!!i.messages && <span className="inline-flex items-center gap-0.5"><MessageSquare className="size-3" />{i.messages}</span>}
                  {!!i.attachments && <span className="inline-flex items-center gap-0.5"><Paperclip className="size-3" />{i.attachments}</span>}
                </div>
                {showScenario && (i.scenarioName || i.scenarioId) && <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{i.scenarioName ?? i.scenarioId}</div>}
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}
