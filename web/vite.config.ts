import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// Served by the panel under /qa/ (web/dist, SPA fallback). `pnpm dev` proxies the API to a local panel (QA_PANEL_URL).
const target = process.env.QA_PANEL_URL ?? "http://127.0.0.1:47620"

export default defineConfig({
  base: "/qa/",
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // vendor code changes rarely; keep it cacheable apart from the app
        manualChunks: (id) => {
          if (!id.includes("node_modules")) return undefined
          if (/react-markdown|remark|micromark|mdast|unified|hast|unist|vfile|property-information|decode-named|character-entities|space-separated|comma-separated|html-url|trim-lines|bail|devlop|ccount|zwitch|longest-streak|markdown-table|escape-string|estree|style-to|inline-style/.test(id)) return "markdown"
          return "vendor"
        },
      },
    },
  },
  server: {
    proxy: {
      "/qa/api": target,
      "/qa/auth": target,
      "/qa/files": target,
    },
  },
})
