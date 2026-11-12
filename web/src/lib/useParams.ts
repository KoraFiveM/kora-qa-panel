import { useCallback } from "react"
import { useSearchParams } from "react-router-dom"

/** Filters in the URL so links/back button keep them. Setting a filter resets `page`. */
export function useQueryState() {
  const [sp, setSp] = useSearchParams()
  const get = useCallback((k: string, d = "") => sp.get(k) ?? d, [sp])
  const list = useCallback((k: string) => (sp.get(k) ?? "").split(",").filter(Boolean), [sp])
  const set = useCallback(
    (patch: Record<string, string | string[] | number | null | undefined>) => {
      setSp(
        (prev) => {
          const n = new URLSearchParams(prev)
          for (const [k, v] of Object.entries(patch)) {
            const s = Array.isArray(v) ? v.join(",") : v === null || v === undefined ? "" : String(v)
            if (s) n.set(k, s)
            else n.delete(k)
          }
          if (!("page" in patch)) n.delete("page")
          return n
        },
        { replace: true },
      )
    },
    [setSp],
  )
  return { get, list, set, sp }
}
