import { useEffect, useState, type ReactNode } from "react"
import { NavLink, Outlet, useLocation } from "react-router-dom"
import { Bug, ClipboardCheck, FlaskConical, GitPullRequest, LayoutDashboard, LogOut, Menu, PlayCircle, RotateCcw, Trophy, Users, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ErrorBoundary } from "@/components/error-boundary"
import { cn } from "@/lib/cn"
import { api } from "@/lib/api"
import { useSession } from "@/lib/session"
import type { Role } from "@/lib/types"

interface NavItem { to: string; label: string; icon: ReactNode; role: Role; end?: boolean }
const NAV: NavItem[] = [
  { to: "/", label: "Dashboard", icon: <LayoutDashboard />, role: "tester", end: true },
  { to: "/issues", label: "Issues", icon: <Bug />, role: "tester" },
  { to: "/retests", label: "Retests", icon: <RotateCcw />, role: "tester" },
  { to: "/scenarios", label: "Scenarios", icon: <FlaskConical />, role: "tester" },
  { to: "/runs", label: "Runs", icon: <PlayCircle />, role: "tester" },
  { to: "/fixes", label: "Fixes", icon: <GitPullRequest />, role: "dev" },
  { to: "/testers", label: "Testers", icon: <Trophy />, role: "tester" },
  { to: "/users", label: "Users", icon: <Users />, role: "admin" },
]

export function Logo() {
  return (
    <div className="flex items-center gap-2">
      <div className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground"><ClipboardCheck className="size-4" /></div>
      <span className="font-heading text-base font-semibold tracking-tight">Kora <span className="text-primary">QA</span></span>
    </div>
  )
}

const ROLE_VARIANT = { tester: "outline", dev: "armour", admin: "primary" } as const

export function UserChip({ compact = false }: { compact?: boolean }) {
  const { user } = useSession()
  if (!user) return null
  return (
    <div className="flex min-w-0 items-center gap-2">
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" className="size-7 shrink-0 rounded-full bg-surface-raised" />
      ) : (
        <div className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-raised text-xs font-semibold">{(user.name ?? "?").slice(0, 1).toUpperCase()}</div>
      )}
      {!compact && <span className="truncate text-sm font-medium">{user.name ?? user.discordId}</span>}
      <Badge variant={ROLE_VARIANT[user.role]}>{user.role}</Badge>
    </div>
  )
}

async function logout() {
  try {
    await api.post("/qa/auth/logout", {})
  } finally {
    window.location.href = "/qa/"
  }
}

function NavLinks({ onClick }: { onClick?: () => void }) {
  const { can } = useSession()
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.filter((n) => can(n.role)).map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          onClick={onClick}
          className={({ isActive }) =>
            cn(
              "focus-ring flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-fast [&_svg]:size-4",
              isActive ? "bg-brand-soft text-primary" : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
            )
          }
        >
          {n.icon}
          {n.label}
        </NavLink>
      ))}
    </nav>
  )
}

export function Layout() {
  const [open, setOpen] = useState(false)
  const loc = useLocation()
  useEffect(() => {
    setOpen(false)
    window.scrollTo(0, 0)
  }, [loc.pathname])

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[14rem_1fr]">
      {/* desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col gap-4 border-r bg-card p-3 md:flex">
        <div className="px-2 pt-1"><Logo /></div>
        <NavLinks />
        <div className="mt-auto space-y-2 border-t pt-3">
          <UserChip />
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={logout}><LogOut /> Log out</Button>
        </div>
      </aside>

      {/* mobile top bar */}
      <header className="sticky top-0 z-40 flex items-center gap-2 border-b bg-card/95 px-3 py-2 backdrop-blur md:hidden">
        <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Menu"><Menu /></Button>
        <Logo />
        <div className="ml-auto"><UserChip compact /></div>
      </header>
      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-modal-overlay" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col gap-4 border-r bg-card p-3 shadow-modal animate-in slide-in-from-left">
            <div className="flex items-center justify-between px-2 pt-1">
              <Logo />
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label="Close menu"><X /></Button>
            </div>
            <NavLinks onClick={() => setOpen(false)} />
            <div className="mt-auto space-y-2 border-t pt-3 safe-bottom">
              <UserChip />
              <Button variant="ghost" size="sm" className="w-full justify-start" onClick={logout}><LogOut /> Log out</Button>
            </div>
          </div>
        </div>
      )}

      <main className="mx-auto w-full min-w-0 max-w-6xl px-3 py-4 sm:px-5 md:py-6">
        <ErrorBoundary resetKey={loc.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  )
}
