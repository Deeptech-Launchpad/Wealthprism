export type Bucket = "liquidity" | "income" | "growth";
export interface BucketTargets { liquidity: number; income: number; growth: number; driftThresholdPp: number }
export interface BucketStatus { bucket: Bucket; targetPct: number; actualPct: number; driftPp: number; value: number; breached: boolean }
export function bucketDrift(values: Record<Bucket, number>, t: BucketTargets): BucketStatus[] {
  const total = values.liquidity + values.income + values.growth || 1;
  return (["liquidity", "income", "growth"] as Bucket[]).map((b) => {
    const actual = +((values[b] / total) * 100).toFixed(2);
    const drift = +(actual - t[b]).toFixed(2);
    return { bucket: b, targetPct: t[b], actualPct: actual, driftPp: drift, value: values[b], breached: Math.abs(drift) > t.driftThresholdPp };
  });
}
