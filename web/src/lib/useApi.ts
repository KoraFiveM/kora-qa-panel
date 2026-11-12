import { useCallback, useEffect, useRef, useState } from "react"
import { api, ApiError } from "./api"

export interface ApiState<T> {
  data: T | null
  error: ApiError | Error | null
  loading: boolean
  reload: () => void
}

/** GET `path` (null = skip). Keeps the previous data while reloading so lists don't flash. */
export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<ApiError | Error | null>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const [tick, setTick] = useState(0)
  const seq = useRef(0)

  useEffect(() => {
    if (!path) {
      setLoading(false)
      return
    }
    const id = ++seq.current
    setLoading(true)
    api.get<T>(path).then(
      (d) => {
        if (id !== seq.current) return
        setData(d)
        setError(null)
        setLoading(false)
      },
      (e: Error) => {
        if (id !== seq.current) return
        setError(e)
        setLoading(false)
      },
    )
  }, [path, tick])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, loading, reload }
}
