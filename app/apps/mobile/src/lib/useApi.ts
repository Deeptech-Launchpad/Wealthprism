import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(!!path);
  const load = useCallback(() => { if (!path) return; setLoading(true); setError(null); api<T>(path).then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false)); }, [path]);
  useEffect(load, [load]);
  return { data, error, loading, refetch: load };
}
