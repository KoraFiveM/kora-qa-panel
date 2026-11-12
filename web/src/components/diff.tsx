import { useMemo, useState, type ReactNode } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "@/lib/cn"

/* ---------- review hints (apply-fix SKILL.md "Review": things not explained by the bug) ---------- */
export interface Hint { key: string; label: string; re: RegExp }
export const REVIEW_HINTS: Hint[] = [
  { key: "perm", label: "Permissions / admin checks / aces", re: /\b(IsPlayerAceAllowed|ExecuteCommand\s*\(\s*['"]add_(ace|principal)|add_ace|add_principal|hasPermission|HasPermission|isAdmin|IsAdmin|permission|Permission|ace\b|group\.admin|god)\b/ },
  { key: "money", label: "Money or item amounts", re: /\b(addMoney|AddMoney|removeMoney|RemoveMoney|setMoney|SetMoney|AddItem|addItem|RemoveItem|removeItem|giveItem|price|Price|amount|reward|payout|cash|bank)\b/ },
  { key: "cmd", label: "New commands or events", re: /\b(RegisterCommand|Kora\.commands\.add|RegisterNetEvent|RegisterServerEvent|AddEventHandler|TriggerServerEvent|TriggerClientEvent|callback\.register|lib\.callback\.register)\b/ },
  { key: "net", label: "Network requests / webhooks", re: /\b(PerformHttpRequest|webhook|Webhook|discord\.com\/api|https?:\/\/|fetch\s*\(|SetHttpHandler)/ },
  { key: "obf", label: "Obfuscated / encoded strings, dynamic code", re: /(\\x[0-9a-fA-F]{2}|\\[0-9]{2,3}\\[0-9]{2,3}|\bload\s*\(|\bloadstring\s*\(|\bbase64\b|[A-Za-z0-9+/]{60,}={0,2}|string\.char\s*\(|\bassert\s*\(\s*load)/ },
  { key: "exec", label: "Shell / file / resource control", re: /\b(io\.popen|os\.execute|SaveResourceFile|StopResource|StartResource|ExecuteCommand|os\.remove|io\.open)\b/ },
]

/* ---------- Lua / JS highlighting ---------- */
const KW = new Set("and break do else elseif end false for function goto if in local nil not or repeat return then true until while const let var new class import export from async await typeof null undefined this".split(" "))

function highlight(code: string, flag: boolean): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(--.*$|\/\/.*$|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|\[\[.*?\]\]|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b(?=\s*\()|\b[A-Za-z_][A-Za-z0-9_]*\b)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index))
    const t = m[0]
    let cls: string | undefined
    if (t.startsWith("--") || t.startsWith("//")) cls = "tok-com"
    else if (t.startsWith('"') || t.startsWith("'") || t.startsWith("[[")) cls = "tok-str"
    else if (/^\d/.test(t)) cls = "tok-num"
    else if (KW.has(t)) cls = "tok-kw"
    else if (code.slice(m.index + t.length).match(/^\s*\(/)) cls = "tok-fn"
    if (flag && REVIEW_HINTS.some((h) => h.re.test(t))) cls = `${cls ?? ""} tok-flag`
    out.push(cls ? <span key={k++} className={cls}>{t}</span> : t)
    last = m.index + t.length
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}

/* ---------- diff parsing ---------- */
type LineKind = "add" | "del" | "ctx" | "hunk" | "meta"
interface DLine { kind: LineKind; text: string; oldNo?: number; newNo?: number }
interface DFile { name: string; patch: string; lines: DLine[]; adds: number; dels: number }

export function parseDiff(diff: string): DFile[] {
  const files: DFile[] = []
  let patch = ""
  let cur: DFile | null = null
  let o = 0, n = 0
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("----- ") && /\.patch\s*$/.test(raw)) {
      patch = raw.slice(6).trim()
      cur = null
      continue
    }
    if (raw.startsWith("diff --git ")) {
      const m = /diff --git a\/(\S+) b\/(\S+)/.exec(raw)
      const name = (m?.[2] ?? raw.slice(11)).replace(/^(src|base)\//, "")
      cur = { name, patch, lines: [], adds: 0, dels: 0 }
      files.push(cur)
      continue
    }
    if (!cur) {
      if (raw.trim()) {
        cur = { name: patch || "(header)", patch, lines: [], adds: 0, dels: 0 }
        files.push(cur)
      } else continue
    }
    if (raw.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw)
      o = Number(m?.[1] ?? 0)
      n = Number(m?.[2] ?? 0)
      cur.lines.push({ kind: "hunk", text: raw })
    } else if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("index ") || raw.startsWith("new file") || raw.startsWith("deleted file") || raw.startsWith("similarity") || raw.startsWith("rename ") || raw.startsWith("\\")) {
      cur.lines.push({ kind: "meta", text: raw })
    } else if (raw.startsWith("+")) {
      cur.lines.push({ kind: "add", text: raw.slice(1), newNo: n++ })
      cur.adds++
    } else if (raw.startsWith("-")) {
      cur.lines.push({ kind: "del", text: raw.slice(1), oldNo: o++ })
      cur.dels++
    } else {
      cur.lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo: o++, newNo: n++ })
    }
  }
  return files
}

/** Count added lines that match each review hint. */
export function reviewHits(diff: string | null | undefined): Map<string, string[]> {
  const hits = new Map<string, string[]>()
  if (!diff) return hits
  for (const f of parseDiff(diff)) {
    for (const l of f.lines) {
      if (l.kind !== "add") continue
      for (const h of REVIEW_HINTS) {
        if (h.re.test(l.text)) hits.set(h.key, [...(hits.get(h.key) ?? []), `${f.name}:${l.newNo} ${l.text.trim()}`.slice(0, 200)])
      }
    }
  }
  return hits
}

function FileDiff({ file, defaultOpen }: { file: DFile; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="overflow-hidden rounded-lg border">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 bg-surface-raised px-3 py-2 text-left text-sm hover:bg-surface-hover">
        {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
        <span className="min-w-0 flex-1 break-all font-mono text-xs">{file.name}</span>
        <span className="shrink-0 font-mono text-xs text-success">+{file.adds}</span>
        <span className="shrink-0 font-mono text-xs text-destructive">-{file.dels}</span>
      </button>
      {open && (
        <div className="scrollbar-thin overflow-x-auto bg-background">
          <table className="w-full border-collapse font-mono text-xs leading-5">
            <tbody>
              {file.lines.map((l, i) =>
                l.kind === "meta" ? null : l.kind === "hunk" ? (
                  <tr key={i} className="bg-armour-soft text-armour">
                    <td colSpan={3} className="whitespace-pre px-2 py-0.5">{l.text}</td>
                  </tr>
                ) : (
                  <tr key={i} className={cn(l.kind === "add" && "bg-success-soft", l.kind === "del" && "bg-destructive-soft")}>
                    <td className="w-10 select-none border-r border-border/50 px-1 text-right text-muted-foreground/70">{l.oldNo ?? ""}</td>
                    <td className="w-10 select-none border-r border-border/50 px-1 text-right text-muted-foreground/70">{l.newNo ?? ""}</td>
                    <td className="whitespace-pre px-2">
                      <span className={cn("select-none", l.kind === "add" ? "text-success" : l.kind === "del" ? "text-destructive" : "text-muted-foreground/50")}>{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
                      {highlight(l.text, l.kind === "add")}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function DiffView({ diff }: { diff: string }) {
  const files = useMemo(() => parseDiff(diff), [diff])
  const byPatch = useMemo(() => {
    const m = new Map<string, DFile[]>()
    for (const f of files) m.set(f.patch, [...(m.get(f.patch) ?? []), f])
    return m
  }, [files])
  const adds = files.reduce((s, f) => s + f.adds, 0), dels = files.reduce((s, f) => s + f.dels, 0)
  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        {files.length} file{files.length === 1 ? "" : "s"} · <span className="text-success">+{adds}</span> <span className="text-destructive">-{dels}</span>
        <span className="ml-2">Highlighted words on added lines match the review checklist.</span>
      </div>
      {[...byPatch.entries()].map(([patch, fs]) => (
        <div key={patch} className="space-y-2">
          {patch && <div className="font-mono text-xs font-semibold text-primary">{patch}</div>}
          {fs.map((f, i) => <FileDiff key={i} file={f} defaultOpen={files.length <= 6} />)}
        </div>
      ))}
    </div>
  )
}
