import type { Config } from "tailwindcss"
import animate from "tailwindcss-animate"

// Same tokens as kora_lib/web (shadcn-like, kora_theme variables), plus the soft/border tints kora_theme derives.
const tint = (name: string) => ({
  DEFAULT: `hsl(var(--${name}) / <alpha-value>)`,
  soft: `hsl(var(--${name}-soft))`,
  border: `hsl(var(--${name}-border))`,
})

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        "brand-hover": "hsl(var(--brand-hover))",
        "brand-pressed": "hsl(var(--brand-pressed))",
        "brand-soft": "hsl(var(--brand-soft))",
        "brand-border": "hsl(var(--brand-border))",
        "surface-raised": "hsl(var(--surface-raised))",
        "surface-hover": "hsl(var(--surface-hover))",
        "border-strong": "hsl(var(--border-strong))",
        "control-border": "hsl(var(--control-border))",
        "control-border-hover": "hsl(var(--control-border-hover))",
        "modal-overlay": "hsl(var(--modal-overlay))",
        hud: "hsl(var(--hud))",
        success: tint("success"),
        warning: tint("warning"),
        info: tint("info"),
        armour: tint("armour"),
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary) / <alpha-value>)", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground))",
          soft: "hsl(var(--destructive-soft))",
          border: "hsl(var(--destructive-border))",
        },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
      },
      borderRadius: {
        xs: "calc(var(--radius) * 0.5)",
        sm: "var(--radius-sm)",
        md: "calc(var(--radius) * 0.8)",
        lg: "var(--radius)",
        xl: "var(--radius-lg)",
      },
      boxShadow: {
        low: "var(--shadow-low)",
        floating: "var(--shadow-floating)",
        modal: "var(--shadow-modal)",
      },
      fontFamily: {
        sans: ['var(--font-sans, "Kora Inter", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)'],
        heading: ['var(--font-heading, var(--font-sans, "Kora Inter", Inter, ui-sans-serif, system-ui, sans-serif))'],
        mono: ['var(--font-mono, "SFMono-Regular", Consolas, "Liberation Mono", monospace)'],
      },
      transitionDuration: { fast: "120ms", popover: "160ms", dialog: "180ms" },
      transitionTimingFunction: { entry: "cubic-bezier(0.16, 1, 0.3, 1)" },
    },
  },
  plugins: [animate],
} satisfies Config
