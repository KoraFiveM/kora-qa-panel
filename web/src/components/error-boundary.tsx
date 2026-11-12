import { Component, type ReactNode } from "react"

/** Keeps a page crash (unexpected API shape) from blanking the whole panel. Reset by changing `resetKey`. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="rounded-lg border border-destructive-border bg-destructive-soft p-4 text-sm" data-testid="page-crash">
        <div className="font-semibold text-destructive">This page hit an error.</div>
        <div className="mt-1 break-words font-mono text-xs text-muted-foreground">{this.state.error.message}</div>
        <button className="mt-3 underline" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    )
  }
}
