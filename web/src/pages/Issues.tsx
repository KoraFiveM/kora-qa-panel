import { useEffect, useState } from "react"
import { Search, X } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Input, Select } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Chips, Empty, ErrorBox, Loading, PageHeader, Pager, Spinner } from "@/components/common"
import { IssueRows } from "@/components/issue-list"
import { qs } from "@/lib/api"
import { useApi } from "@/lib/useApi"
import { useQueryState } from "@/lib/useParams"
import { useSession } from "@/lib/session"
import type { IssueSummary, Paged } from "@/lib/types"

const PAGE_SIZE = 50

export function IssuesPage() {
  const { meta } = useSession()
  const { get, list, set } = useQueryState()
  const status = list("status")
  const kind = list("kind")
  const source = list("source")
  const resource = get("resource")
  const q = get("q")
  const sort = get("sort", "updated")
  const page = Number(get("page", "1")) || 1
  const [text, setText] = useState(q)
  const [res, setRes] = useState(resource)
  useEffect(() => setText(q), [q])
  useEffect(() => setRes(resource), [resource])

  // URL keeps group chips as state=open|closed and literal statuses as status=… (same split as the API).
  const state = get("state")
  const path = `/issues${qs({ state, status, kind, source, resource, q, sort: sort === "updated" ? "" : sort, page: page > 1 ? page : "", pageSize: PAGE_SIZE })}`
  const { data, error, loading, reload } = useApi<Paged<IssueSummary>>(path)

  const stateOpts = [
    { key: "open", label: "All open" },
    { key: "closed", label: "All closed" },
  ]
  const statusOpts = [
    ...(meta?.statuses ?? []).map((s) => ({ key: s.key, label: s.label })),
  ]
  // A group chip and literal statuses are exclusive in the UI: picking one clears the other.
  const setState = (v: string[]) => set({ state: v.find((x) => x !== state) ?? "", status: "" })
  const setStatus = (v: string[]) => set({ status: v, state: "" })
  const anyFilter = state || status.length || kind.length || source.length || resource || q

  return (
    <div className="space-y-3">
      <PageHeader title="Issues" subtitle={data ? `${data.total} matching` : undefined} />
      <div className="space-y-2">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); set({ q: text.trim(), resource: res.trim() }) }}>
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search title, reporter or issue id" className="pl-8" />
          </div>
          <Input value={res} onChange={(e) => setRes(e.target.value)} placeholder="resource" className="hidden w-40 sm:flex" />
          <Button type="submit" variant="secondary">Search</Button>
        </form>
        <div className="flex gap-1.5 overflow-hidden">
          <div className="shrink-0"><Chips options={stateOpts} value={state ? [state] : []} onChange={setState} /></div>
          <span className="my-1 w-px shrink-0 bg-border" />
          <div className="min-w-0 flex-1"><Chips options={statusOpts} value={status} onChange={setStatus} /></div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Chips options={(meta?.kinds ?? ["bug", "suggestion"]).map((k) => ({ key: k, label: k }))} value={kind} onChange={(v) => set({ kind: v })} />
          <span className="h-4 w-px bg-border" />
          <Chips options={(meta?.sources ?? ["discord", "scenario", "freeform", "retest"]).map((k) => ({ key: k, label: k }))} value={source} onChange={(v) => set({ source: v })} />
          <div className="ml-auto flex items-center gap-2">
            <Input value={res} onChange={(e) => setRes(e.target.value)} onBlur={() => res !== resource && set({ resource: res.trim() })} placeholder="resource" className="h-8 w-32 sm:hidden" />
            <Select value={sort} onChange={(e) => set({ sort: e.target.value === "updated" ? "" : e.target.value })} className="h-8 w-auto text-xs">
              <option value="updated">Recently updated</option>
              <option value="created">Newest</option>
              <option value="status">Status change</option>
            </Select>
            {anyFilter ? <Button size="sm" variant="ghost" onClick={() => set({ state: "", status: "", kind: "", source: "", resource: "", q: "" })}><X /> Clear</Button> : null}
            {loading && <Spinner />}
          </div>
        </div>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      <Card>
        {!data ? <Loading /> : data.items.length === 0 ? <Empty>No issues match.</Empty> : <IssueRows items={data.items} />}
      </Card>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set({ page: p })} />}
    </div>
  )
}
