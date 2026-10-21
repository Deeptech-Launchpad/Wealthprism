import { useEffect, useState } from "react";
import { api } from "./api";
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(!!path);
  const [tick, setTick] = useState(0);
  useEffect(() => { if (!path) return; let alive = true; setLoading(true); api<T>(path).then((d) => alive && setData(d)).catch((e) => alive && setError(e.message)).finally(() => alive && setLoading(false)); return () => { alive = false; }; }, [path, tick, ...deps]);
  return { data, error, loading, refetch: () => setTick((t) => t + 1) };
}
