import * as React from "react"
import { cn } from "@/lib/cn"

export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("rounded-xl border bg-card text-card-foreground shadow-low", className)} {...props} />
}

export function CardHeader({ className, title, actions, children, ...props }: Omit<React.ComponentProps<"div">, "title"> & { title?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2 border-b px-4 py-3", className)} {...props}>
      {title !== undefined && <h2 className="mr-auto text-sm font-semibold">{title}</h2>}
      {children}
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function CardBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("p-4", className)} {...props} />
}
