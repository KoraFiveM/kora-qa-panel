import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/cn"

// Same variants as kora_lib/web's button (kora_theme tokens).
const buttonVariants = cva(
  "focus-ring inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium leading-none transition-[background-color,border-color,color,box-shadow,transform] duration-fast ease-entry active:scale-[0.98] disabled:pointer-events-none disabled:opacity-[0.48] [&_svg]:pointer-events-none [&_svg]:block [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-low hover:bg-brand-hover active:bg-brand-pressed",
        destructive: "border border-destructive bg-destructive/10 text-destructive hover:bg-destructive/15",
        success: "border border-success bg-success/10 text-success hover:bg-success/15",
        warning: "border border-warning bg-warning/10 text-warning hover:bg-warning/15",
        outline: "border border-control-border bg-transparent text-foreground hover:border-control-border-hover hover:bg-surface-hover",
        secondary: "border border-border bg-secondary text-secondary-foreground shadow-low hover:bg-surface-hover",
        ghost: "text-foreground hover:bg-surface-hover",
        link: "h-auto rounded-sm px-0 py-0 text-foreground underline decoration-current/80 underline-offset-4 hover:decoration-2",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button"
  return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
})
Button.displayName = "Button"

export { Button, buttonVariants }
