import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { api } from "./api"
import type { Me, Meta, Role, User } from "./types"

const RANK: Record<Role, number> = { tester: 1, dev: 2, admin: 3 }

export function atLeast(user: User | null | undefined, role: Role): boolean {
  return Boolean(user && RANK[user.role] >= RANK[role])
}

interface Session {
  me: Me | null
  meta: Meta | null
  user: User | null
  error: string | null
  refresh: () => void
  can: (role: Role) => boolean
  statusLabel: (key: string | null | undefined) => string
  isClosed: (key: string) => boolean
}

const Ctx = createContext<Session | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let live = true
    api.get<Me>("/me").then(
      (m) => {
        if (!live) return
        setMe(m)
        setError(null)
        if (m.user) api.get<Meta>("/meta").then((x) => live && setMeta(x), () => {})
      },
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [tick])

  const refresh = useCallback(() => setTick((t) => t + 1), [])
  const value = useMemo<Session>(() => {
    const labels = new Map((meta?.statuses ?? []).map((s) => [s.key, s]))
    return {
      me,
      meta,
      user: me?.user ?? null,
      error,
      refresh,
      can: (role) => atLeast(me?.user, role),
      statusLabel: (key) => (key ? labels.get(key)?.label ?? key : "—"),
      isClosed: (key) => labels.get(key)?.closed ?? ["fixed", "dup", "wontfix"].includes(key),
    }
  }, [me, meta, error, refresh])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSession(): Session {
  const s = useContext(Ctx)
  if (!s) throw new Error("useSession outside SessionProvider")
  return s
}
