import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/cn"

// kora_theme's [data-ui="badge"] look.
const badge = cva("inline-flex min-h-[1.375rem] items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold leading-none", {
  variants: {
    variant: {
      default: "border-border bg-muted text-muted-foreground",
      primary: "border-brand-border bg-brand-soft text-primary",
      success: "border-success-border bg-success-soft text-success",
      warning: "border-warning-border bg-warning-soft text-warning",
      destructive: "border-destructive-border bg-destructive-soft text-destructive",
      info: "border-info-border bg-info-soft text-info",
      armour: "border-armour-border bg-armour-soft text-armour",
      outline: "border-control-border bg-transparent text-foreground",
    },
  },
  defaultVariants: { variant: "default" },
})

export type BadgeVariant = NonNullable<VariantProps<typeof badge>["variant"]>

export function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ variant }), className)} {...props} />
}
