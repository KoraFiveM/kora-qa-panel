import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/cn"

const components: Components = {
  h1: ({ node: _n, ...p }) => <h1 className="mb-2 mt-3 text-lg font-semibold leading-6 first:mt-0" {...p} />,
  h2: ({ node: _n, ...p }) => <h2 className="mb-1.5 mt-3 text-base font-semibold leading-6 first:mt-0" {...p} />,
  h3: ({ node: _n, ...p }) => <h3 className="mb-1 mt-2 text-sm font-semibold leading-5 first:mt-0" {...p} />,
  p: ({ node: _n, ...p }) => <p className="my-1.5 first:mt-0 last:mb-0" {...p} />,
  ul: ({ node: _n, ...p }) => <ul className="my-1 list-disc space-y-0.5 pl-5" {...p} />,
  ol: ({ node: _n, ...p }) => <ol className="my-1 list-decimal space-y-0.5 pl-5" {...p} />,
  blockquote: ({ node: _n, ...p }) => <blockquote className="my-1 border-l-2 border-control-border pl-3 text-muted-foreground" {...p} />,
  code: ({ node: _n, className, ...p }) => <code className={cn("rounded-sm bg-surface-raised px-1 py-0.5 font-mono text-[0.9em] text-foreground [pre_&]:bg-transparent [pre_&]:p-0", className)} {...p} />,
  pre: ({ node: _n, ...p }) => <pre className="scrollbar-thin my-2 max-w-full overflow-x-auto rounded-md border bg-background p-2.5 font-mono text-xs leading-5" {...p} />,
  table: ({ node: _n, ...p }) => <div className="my-2 overflow-x-auto"><table className="min-w-full border-collapse text-left text-xs" {...p} /></div>,
  th: ({ node: _n, ...p }) => <th className="border-b border-border px-2 py-1 font-semibold" {...p} />,
  td: ({ node: _n, ...p }) => <td className="border-b border-border px-2 py-1" {...p} />,
  a: ({ node: _n, ...p }) => <a className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer noopener" {...p} />,
  hr: () => <hr className="my-3 border-border" />,
  img: ({ node: _n, ...p }) => <img className="my-2 max-h-80 max-w-full rounded-md object-contain" loading="lazy" {...p} />,
}

/** Markdown from issues/messages; raw HTML is skipped. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("min-w-0 break-words text-sm leading-relaxed", className)}>
      <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
