import * as React from "react"
import { cn } from "@/lib/cn"

const field =
  "focus-ring w-full rounded-md border border-input bg-background text-sm text-foreground transition-[background-color,border-color,box-shadow] duration-fast ease-entry placeholder:text-muted-foreground hover:border-control-border-hover focus-visible:border-primary focus-visible:bg-card disabled:cursor-not-allowed disabled:opacity-[0.48] aria-[invalid=true]:border-destructive"

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(field, "flex h-9 px-3 py-1", className)} {...props} />
))
Input.displayName = "Input"

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(field, "flex min-h-[72px] resize-y px-3 py-2", className)} {...props} />
))
Textarea.displayName = "Textarea"

export const Select = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>(({ className, children, ...props }, ref) => (
  <select ref={ref} className={cn(field, "h-9 appearance-none bg-[length:12px] bg-[right_0.6rem_center] bg-no-repeat px-3 pr-8", className)}
    style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' stroke='%23949494' stroke-width='1.5' fill='none'/%3E%3C/svg%3E\")" }}
    {...props}>
    {children}
  </select>
))
Select.displayName = "Select"

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label className={cn("text-xs font-medium text-muted-foreground", className)} {...props} />
}
