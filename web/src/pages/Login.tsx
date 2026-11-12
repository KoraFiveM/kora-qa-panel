import { useState } from "react"
import { useLocation } from "react-router-dom"
import { AlertTriangle, LogIn } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardBody } from "@/components/ui/card"
import { Input, Label, Select } from "@/components/ui/input"
import { Logo } from "@/components/layout"
import { useSession } from "@/lib/session"

function DiscordIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="size-5">
      <path d="M20.3 4.4A19.6 19.6 0 0 0 15.4 3l-.6 1.3a18 18 0 0 0-5.6 0L8.6 3a19.5 19.5 0 0 0-4.9 1.5C.6 9.1-.3 13.6.1 18.1a19.8 19.8 0 0 0 6 3l1.3-2a12.8 12.8 0 0 1-2-1l.5-.4a14 14 0 0 0 12.2 0l.5.4-2 1 1.3 2a19.7 19.7 0 0 0 6-3c.5-5.2-.9-9.7-3.6-13.7ZM8 15.3c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.5 8 10.5s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z" />
    </svg>
  )
}

export function LoginPage() {
  const { me, error } = useSession()
  const loc = useLocation()
  const next = `/qa${loc.pathname === "/" ? "/" : loc.pathname}${loc.search}`
  const loginUrl = `${me?.loginUrl ?? "/qa/auth/login"}?next=${encodeURIComponent(next)}`
  const [devId, setDevId] = useState("100000000000000001")
  const [devRole, setDevRole] = useState("admin")
  const [devName, setDevName] = useState("Dev")

  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-sm">
        <CardBody className="space-y-5 p-6">
          <div className="flex justify-center"><Logo /></div>
          <div className="text-center">
            <h1 className="text-lg font-semibold">Sign in</h1>
            <p className="mt-1 text-sm text-muted-foreground">Bug reports, test scenarios, retests and fixes for the Kora dev server.</p>
          </div>
          {error && <div className="rounded-lg border border-destructive-border bg-destructive-soft p-3 text-sm text-destructive">Can't reach the panel: {error}</div>}
          {me && !me.oauthConfigured ? (
            <div className="space-y-3">
              <div className="flex gap-2 rounded-lg border border-warning-border bg-warning-soft p-3 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                <div>
                  <div className="font-semibold text-warning">Login is not set up yet</div>
                  <div className="mt-0.5 text-muted-foreground">Discord sign-in needs a client id and secret on the server. Ask Jamie to finish the setup.</div>
                </div>
              </div>
              <Button className="w-full" size="lg" disabled><DiscordIcon /> Log in with Discord</Button>
            </div>
          ) : (
            <Button asChild className="w-full bg-[#5865F2] text-white hover:bg-[#4752C4] active:bg-[#3C45A5]" size="lg">
              <a href={loginUrl}><DiscordIcon /> Log in with Discord</a>
            </Button>
          )}
          <p className="text-center text-xs text-muted-foreground">Only testers added to the panel can sign in. If you're refused, an admin will see your attempt and can add you.</p>
          {me?.devLogin && (
            <details className="rounded-lg border p-3 text-sm">
              <summary className="cursor-pointer text-muted-foreground">Dev login (loopback only)</summary>
              <form className="mt-3 space-y-2" action="/qa/auth/dev-login" method="get">
                <div><Label htmlFor="d-id">Discord id</Label><Input id="d-id" name="discordId" value={devId} onChange={(e) => setDevId(e.target.value)} /></div>
                <div><Label htmlFor="d-name">Name</Label><Input id="d-name" name="name" value={devName} onChange={(e) => setDevName(e.target.value)} /></div>
                <div>
                  <Label htmlFor="d-role">Role</Label>
                  <Select id="d-role" name="role" value={devRole} onChange={(e) => setDevRole(e.target.value)}>
                    <option value="tester">tester</option><option value="dev">dev</option><option value="admin">admin</option>
                  </Select>
                </div>
                <input type="hidden" name="next" value={next} />
                <Button type="submit" variant="outline" className="w-full"><LogIn /> Dev login</Button>
              </form>
            </details>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
