// Shapes from docs/API.md. Every Report field may be missing: render defensively.
export type Role = "tester" | "dev" | "admin"

export interface User {
  id: number
  discordId: string
  name: string | null
  avatar: string | null
  avatarUrl: string | null
  role: Role
  legacy: boolean
  disabled?: boolean
  disabledAt?: number | null
  createdAt: number | null
  lastLoginAt: number | null
}

export interface Me {
  user: User | null
  oauthConfigured: boolean
  devLogin: boolean
  loginUrl: string
  publicUrl: string
}

export interface StatusDef { key: string; label: string; closed: boolean }

export interface StepArg { name: string; type: string; cap?: string; allow?: string; min?: number; max?: number }
export interface StepDef {
  id: string
  pattern: string
  kind: "setup" | "observed" | "check" | "manual"
  side: string
  resource: string
  priority: number
  description?: string
  example?: string
  args?: StepArg[]
}

export interface Meta {
  statuses: StatusDef[]
  roles: Role[]
  kinds: string[]
  sources: string[]
  runStatuses: string[]
  stepStatuses: string[]
  manualReviewAfter: number
  steps: StepDef[]
  caps: Record<string, unknown>
  catalog: { source: string; error: string | null; count: number }
  registryAt: number | null
}

export interface Person { discordId: string | null; name: string | null }

export interface IssueSummary {
  id: string
  title: string
  kind: "bug" | "suggestion"
  status: string
  statusLabel: string
  source: string
  reporter: Person
  scenarioId: string | null
  runId: number | null
  failedStep: number | null
  notFixedCount: number
  fixedPaid: boolean
  createdAt: number
  updatedAt: number
  statusAt: number
  messages?: number
  attachments?: number
  scenarioName?: string | null
}

export interface ReportStep { idx: number; text: string; status: string; detail?: unknown }
export interface TimelineEntry { at: number; type: string; data?: unknown }
export interface ConsoleEntry { at: number; channel?: string; line: string; error?: boolean }
export interface Coords { x: number; y: number; z: number; h?: number }
export interface InvItem { name?: string; label?: string; amount?: number; count?: number; slot?: number; metadata?: unknown; info?: unknown; [k: string]: unknown }

export interface Report {
  v?: number
  scenario?: { id?: string; hash?: string; name?: string } | null
  failedIdx?: number | null
  steps?: ReportStep[]
  expected?: string
  actual?: string
  note?: string
  frequency?: string
  timeline?: TimelineEntry[]
  console?: ConsoleEntry[]
  player?: {
    coords?: Coords
    street?: string
    vehicle?: { model?: string; plate?: string } | null
    job?: { name?: string; grade?: unknown; onduty?: boolean }
    gang?: { name?: string; grade?: unknown } | null
    money?: Record<string, number>
    health?: number
    armour?: number
    routingBucket?: number
  }
  inventoryBefore?: InvItem[] | Record<string, InvItem>
  inventoryAfter?: InvItem[] | Record<string, InvItem>
  moneyBefore?: Record<string, number>
  resources?: { name: string; version?: string; state?: string }[]
  build?: string
  screenshot?: { available?: boolean; reason?: string }
  teardown?: { id?: string; idx?: number; ok?: boolean; error?: string }[]
  retestIssueId?: string
}

export interface Attachment {
  id: number
  messageId: number | null
  kind: "screenshot" | "file"
  mime: string | null
  size: number | null
  url: string | null
  signedUrl: string | null
  originalUrl: string | null
  createdAt: number
}

export interface Message {
  id: number
  author: Person
  isBot: boolean
  content: string
  createdAt: number
  attachments: Attachment[]
}

export interface IssueEvent {
  id: number
  at: number
  by: Person
  type: "status" | "comment" | "meta" | "fix" | "xp" | "import"
  from: string | null
  to: string | null
  note: string | null
  data: Record<string, unknown> | null
}

export interface FixRow {
  id: number
  patchId: string
  model: string | null
  risk: string | null
  summary: string | null
  details: string | null
  testSteps: string | null
  scenario: string | null
  applied: { appliedAt?: string; backupTag?: string } | null
  isHistory: boolean
  createdAt: number
}

export interface CurrentFix {
  state: string
  appliedAt: string | null
  patchId: string | null
  model: string | null
  risk: string | null
  summary: string | null
  resources: string[]
}

export interface ScenarioStep {
  idx: number
  keyword: string
  text: string
  defId: string | null
  kind: string | null
  side: string | null
  args?: unknown[]
  docString?: { content?: string; mediaType?: string } | string | null
  dataTable?: { rows?: { cells: { value: string }[] }[] } | string[][] | null
  resolved?: Record<string, unknown>
}

export interface ScenarioError { idx?: number; line?: number; text?: string; message: string }

export interface Scenario {
  id: string
  resource: string
  file: string
  line: number
  name: string
  description: string | null
  tags: string[]
  target: number
  hash: string
  valid: boolean
  errors: ScenarioError[]
  removed: boolean
  legacyIds: string[]
  updatedAt: number
  steps?: ScenarioStep[]
  stepCount?: number
  passes?: number
  fails?: number
  distinctPassers?: number
  lastResult?: { status: string; at: number; discordId: string } | null
  done?: boolean
}

export interface Run {
  id: number
  scenarioId: string | null
  scenarioHash: string | null
  legacyTestId: string | null
  tester: Person
  status: string
  startedAt: number
  finishedAt: number | null
  legacy: boolean
  issueId: string | null
  note: string | null
  scenarioName?: string | null
  resource?: string | null
  context?: Report | null
  steps?: { idx: number; status: string; at: number | null }[]
}

export interface RunStep { idx: number; text: string; kind: string | null; status: string; detail: unknown; at: number | null }

export interface PromptPreview {
  threadId: string
  title: string
  status: string
  url: string
  messages: { author: string; isBot: boolean; createdAt: string; content: string; attachments: string[] }[]
  modOverride?: { reason: string; by: string; at: string }
}

export interface IssueDetail {
  issue: IssueSummary & {
    report: Report | null
    modOverride: { reason: string; by: string; byDiscordId?: string; at: number } | null
    legacy: Record<string, unknown> | null
    url: string
  }
  renderedReport: string | null
  messages: Message[]
  attachments: Attachment[]
  events: IssueEvent[]
  fixes: FixRow[]
  currentFix: CurrentFix | null
  runs: Run[]
  prompts: { id: number; kind: string; content: string; meta: unknown; createdAt: number }[]
  scenario: Scenario | null
  allowedOps: string[]
  promptPreview: PromptPreview | null
}

export interface Paged<T> { items: T[]; total: number; page: number; pageSize: number }

export interface ScanSummary {
  at: number
  ms?: number
  scenarios: number
  valid: number
  invalid: number
  changed?: number
  removed?: number
  resources?: { name: string; optedIn: boolean; files: number; qaLuaError: string | null }[]
  catalog?: { source: string; error: string | null; count: number }
  catalogError?: string | null
  registryAt?: number | null
  matcherErrors?: unknown[]
  fileErrors?: { resource: string; file: string; line: number; message: string }[]
}

export interface Dashboard {
  issuesByStatus: Record<string, number>
  openTotal: number
  awaitingTest: number
  waitingFixes: number
  runsToday: { total: number; passed: number; failed: number }
  passRateByResource: { resource: string; runs: number; passed: number; failed: number; rate: number | null }[]
  flaky: { scenarioId: string; name: string; resource: string; passed: number; failed: number }[]
  recentIssues: IssueSummary[]
  scan: ScanSummary | null
  xpOutbox?: { pending: number; failing: number } | null
}

export interface FixListItem {
  issueId: string
  state: string
  appliedAt: string | null
  title: string | null
  issueStatus: string | null
  kind: string | null
  model: string | null
  risk: string | null
  patchId: string | null
  createdAt: string | null
  summary: string | null
  reasoning: string | null
  resources: string[]
  patches: string[]
  scenarioFile: string | null
}

export interface FixDetail {
  issueId: string
  meta: {
    threadId?: string
    title?: string
    model?: string
    patchId?: string
    createdAt?: string
    kind?: string
    summary?: string
    details?: string
    risk?: string
    testSteps?: string
    reasoning?: string
    config_options?: { name: string; default?: string; resource?: string; description?: string }[]
    resources?: { name: string; path?: string; head?: string; patch?: string }[]
    scenario?: string | null
    scenarioFile?: string | null
    scenarioNote?: string | null
  } | null
  applied: { appliedAt?: string; backupTag?: string } | null
  state: string
  patches: string[]
  show: string | null
  diff: string | null
  diffSource: string | null
  showError: string | null
  history: { ts: string; patchId: string; model?: string; risk?: string; summary?: string; createdAt?: string; applied: unknown }[]
  issue: IssueSummary | null
}

export interface TesterStats {
  discordId: string
  name: string | null
  role: Role | null
  runs: { total: number; passed: number; failed: number; legacy: number; lastAt: number | null }
  issues: { reported: number; fixed: number; closed: number }
  legacyStats: Record<string, unknown> | null
}
