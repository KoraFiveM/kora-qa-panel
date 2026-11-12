import { Navigate, Route, Routes } from "react-router-dom"
import type { ReactNode } from "react"
import { Layout } from "@/components/layout"
import { ErrorBox, Loading } from "@/components/common"
import { useSession } from "@/lib/session"
import type { Role } from "@/lib/types"
import { LoginPage } from "@/pages/Login"
import { DashboardPage } from "@/pages/Dashboard"
import { IssuesPage } from "@/pages/Issues"
import { IssueDetailPage } from "@/pages/IssueDetail"
import { FixesPage, FixDetailPage } from "@/pages/Fixes"
import { ScenariosPage, ScenarioDetailPage } from "@/pages/Scenarios"
import { RunsPage, RunDetailPage } from "@/pages/Runs"
import { RetestsPage } from "@/pages/Retests"
import { TestersPage, TesterDetailPage } from "@/pages/Testers"
import { UsersPage } from "@/pages/Users"

function Need({ role, children }: { role: Role; children: ReactNode }) {
  const { can } = useSession()
  if (!can(role)) return <ErrorBox error={`This page needs the ${role} role.`} />
  return <>{children}</>
}

export default function App() {
  const { me, user, error } = useSession()
  if (!me) return error ? <div className="p-4"><LoginPage /></div> : <Loading />
  if (!user) return <LoginPage />
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="issues" element={<IssuesPage />} />
        <Route path="issues/:id" element={<IssueDetailPage />} />
        <Route path="retests" element={<RetestsPage />} />
        <Route path="scenarios" element={<ScenariosPage />} />
        <Route path="scenarios/:id" element={<ScenarioDetailPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:id" element={<RunDetailPage />} />
        <Route path="fixes" element={<Need role="dev"><FixesPage /></Need>} />
        <Route path="fixes/:id" element={<Need role="dev"><FixDetailPage /></Need>} />
        <Route path="testers" element={<TestersPage />} />
        <Route path="testers/:discordId" element={<TesterDetailPage />} />
        <Route path="users" element={<Need role="admin"><UsersPage /></Need>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
