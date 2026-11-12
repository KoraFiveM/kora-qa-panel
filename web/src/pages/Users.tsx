import { useState } from "react"
import { Ban, UserCheck, UserPlus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardBody, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input, Label, Select } from "@/components/ui/input"
import { Empty, ErrorBox, Loading, PageHeader, useToast } from "@/components/common"
import { api } from "@/lib/api"
import { useApi } from "@/lib/useApi"
import { useSession } from "@/lib/session"
import { ago } from "@/lib/format"
import type { Role, User } from "@/lib/types"

interface UsersResp { items: User[]; pendingLogins: { discordId: string; name: string | null; at: number }[] }

export function UsersPage() {
  const { data, error, loading, reload } = useApi<UsersResp>("/users")
  const { user: me, refresh } = useSession()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [nid, setNid] = useState("")
  const [nname, setNname] = useState("")
  const [nrole, setNrole] = useState<Role>("tester")
  const [err, setErr] = useState<string | null>(null)

  async function setRole(u: { discordId: string }, role: Role) {
    setBusy(u.discordId)
    try {
      await api.post(`/users/${u.discordId}/role`, { role })
      toast(`Role set to ${role}`)
      reload()
      if (u.discordId === me?.discordId) refresh()
    } catch (e) {
      toast((e as Error).message, "error")
    } finally {
      setBusy(null)
    }
  }
  async function dismiss(discordId: string) {
    setBusy(discordId)
    try {
      await api.post(`/users/pending/${discordId}/dismiss`, {})
      toast("Dismissed")
      reload()
    } catch (e) {
      toast((e as Error).message, "error")
    } finally {
      setBusy(null)
    }
  }
  async function setDisabled(u: User, disabled: boolean) {
    if (disabled && !window.confirm(`Disable ${u.name ?? u.discordId}? They are logged out and can't sign in or run tests in game. History is kept.`)) return
    setBusy(u.discordId)
    try {
      const r = await api.post<{ ok: boolean; sessionsRevoked?: number }>(`/users/${u.discordId}/disabled`, { disabled })
      toast(disabled ? `Disabled${r.sessionsRevoked ? ` (${r.sessionsRevoked} session${r.sessionsRevoked === 1 ? "" : "s"} ended)` : ""}` : "Enabled")
      reload()
    } catch (e) {
      toast((e as Error).message, "error")
    } finally {
      setBusy(null)
    }
  }
  async function add(discordId: string, name: string | null, role: Role) {
    setErr(null)
    setBusy(discordId)
    try {
      await api.post(`/users`, { discordId, name: name ?? undefined, role })
      toast(`Added ${name ?? discordId} as ${role}`)
      setNid("")
      setNname("")
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (!data) return loading ? <Loading /> : <ErrorBox error={error} onRetry={reload} />
  return (
    <div className="space-y-4">
      <PageHeader title="Users" subtitle="Who may sign in, and with which role" />
      {data.pendingLogins.length > 0 && (
        <Card className="border-warning-border">
          <CardHeader title={`Refused sign-ins (${data.pendingLogins.length})`} />
          <ul className="divide-y">
            {data.pendingLogins.map((p) => (
              <li key={`${p.discordId}-${p.at}`} className="flex flex-wrap items-center gap-2 px-4 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{p.name ?? "unknown"}</div>
                  <div className="font-mono text-xs text-muted-foreground">{p.discordId} · {ago(p.at)}</div>
                </div>
                <Button size="sm" disabled={busy === p.discordId} onClick={() => add(p.discordId, p.name, "tester")}><UserPlus /> Add as tester</Button>
                <Button size="sm" variant="ghost" disabled={busy === p.discordId} onClick={() => dismiss(p.discordId)}><X /> Dismiss</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card>
        <CardHeader title={`Users (${data.items.length})`} actions={data.items.some((u) => u.disabled) ? <span className="text-xs text-muted-foreground">{data.items.filter((u) => u.disabled).length} disabled</span> : undefined} />
        {data.items.length === 0 ? <Empty>No users.</Empty> : (
          <ul className="divide-y">
            {data.items.map((u) => (
              <li key={u.id} className={`flex flex-wrap items-center gap-3 px-4 py-2 ${u.disabled ? "opacity-60" : ""}`}>
                {u.avatarUrl ? <img src={u.avatarUrl} alt="" className="size-8 rounded-full bg-surface-raised" /> : <div className="grid size-8 place-items-center rounded-full bg-surface-raised text-xs">{(u.name ?? "?")[0]}</div>}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">{u.name ?? "—"}{u.legacy && <Badge variant="outline">imported</Badge>}{u.discordId === me?.discordId && <Badge variant="primary">you</Badge>}{u.disabled && <Badge variant="destructive">disabled</Badge>}</div>
                  <div className="font-mono text-xs text-muted-foreground">{u.discordId} · {u.disabled ? `disabled ${ago(u.disabledAt ?? null)}` : u.lastLoginAt ? `last login ${ago(u.lastLoginAt)}` : "never logged in"}</div>
                </div>
                <Select value={u.role} disabled={busy === u.discordId} onChange={(e) => setRole(u, e.target.value as Role)} className="h-8 w-28 text-xs">
                  <option value="tester">tester</option><option value="dev">dev</option><option value="admin">admin</option>
                </Select>
                {u.discordId !== me?.discordId && (u.disabled ? (
                  <Button size="sm" variant="outline" disabled={busy === u.discordId} onClick={() => setDisabled(u, false)}><UserCheck /> Enable</Button>
                ) : (
                  <Button size="sm" variant="destructive" disabled={busy === u.discordId} onClick={() => setDisabled(u, true)}><Ban /> Disable</Button>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Add a user" />
        <CardBody>
          <form className="grid gap-2 sm:grid-cols-[1fr_1fr_8rem_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); add(nid.trim(), nname.trim() || null, nrole) }}>
            <div><Label htmlFor="u-id">Discord id</Label><Input id="u-id" value={nid} inputMode="numeric" pattern="[0-9]{15,25}" onChange={(e) => setNid(e.target.value)} placeholder="100000000000000055" /></div>
            <div><Label htmlFor="u-name">Name</Label><Input id="u-name" value={nname} onChange={(e) => setNname(e.target.value)} placeholder="optional" /></div>
            <div><Label htmlFor="u-role">Role</Label><Select id="u-role" value={nrole} onChange={(e) => setNrole(e.target.value as Role)}><option value="tester">tester</option><option value="dev">dev</option><option value="admin">admin</option></Select></div>
            <Button type="submit" disabled={!/^\d{15,25}$/.test(nid.trim())}><UserPlus /> Add</Button>
          </form>
          <ErrorBox error={err} className="mt-2" />
        </CardBody>
      </Card>
    </div>
  )
}
