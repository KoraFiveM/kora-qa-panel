import { cn } from "@/lib/cn"
import type { ReactNode } from "react"

export function Tabs<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; hidden?: boolean }[]; className?: string }) {
  return (
    <div role="tablist" className={cn("scrollbar-thin flex gap-1 overflow-x-auto border-b", className)}>
      {items.filter((i) => !i.hidden).map((i) => (
        <button
          key={i.value}
          role="tab"
          aria-selected={value === i.value}
          onClick={() => onChange(i.value)}
          className={cn(
            "focus-ring -mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-fast",
            value === i.value ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {i.label}
        </button>
      ))}
    </div>
  )
}
