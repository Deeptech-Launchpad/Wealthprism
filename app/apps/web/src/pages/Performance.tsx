import { useState } from "react";
import { useApi } from "../lib/useApi";
import { inr } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";

const PERIODS = ["1y", "3y", "5y", "si"] as const;
const pct = (v: number | null | undefined) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);

/** TWR and XIRR side by side for a scope, against its benchmark, with the month-end series. */
export function Performance({ compact }: { compact?: boolean }) {
  const ents = useApi<any[]>("/entities");
  const [scope, setScope] = useState<{ type: string; id?: string }>({ type: "family" });
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("si");
  const q = `/performance?scope_type=${scope.type}${scope.id ? `&scope_id=${scope.id}` : ""}&period=${period}`;
  const { data, error, loading } = useApi<any>(q);
  if (error) return <Status loading={false} error={error} />;
  const d = data;
  const max = d ? Math.max(1, ...d.series.map((p: any) => Math.max(Number(p.value), Number(p.benchmark ?? 0)))) : 1;
  return (
    <Card title={compact ? "Performance" : `Performance — ${d?.scope_label ?? "…"}`} action={<div className="row gap" style={{ flexWrap: "wrap" }}>
      {!compact && <select className="field" style={{ padding: 6 }} value={scope.type + ":" + (scope.id ?? "")} onChange={(e) => { const [type, id] = e.target.value.split(":"); setScope({ type, id: id || undefined }); }}>
        <option value="family:">Family</option>
        {(ents.data ?? []).map((e) => <option key={e.id} value={`entity:${e.id}`}>{e.name}</option>)}
        <option value="bucket:liquidity">Liquidity bucket</option><option value="bucket:income">Income bucket</option><option value="bucket:growth">Growth bucket</option>
      </select>}
      <div className="tabs" style={{ borderBottom: 0 }}>{PERIODS.map((p) => <button key={p} className={period === p ? "on" : ""} onClick={() => setPeriod(p)}>{p.toUpperCase()}</button>)}</div>
    </div>}>
      {loading && !d ? <div className="mute">Loading…</div> : d.valuations < 2 ? <div className="small mute">Not enough valuation history yet — the nightly valuations job writes one point per day; run <code>cli valuations:backfill --from 2025-09-01</code> for month-end history.</div> : (<>
        <div className="kpis" style={{ gridTemplateColumns: compact ? "repeat(3,1fr)" : "repeat(5,1fr)" }}>
          <div><div className="mute small">TWR {d.annualised ? "(annualised)" : "(cumulative)"}</div><div className={`big-num ${d.twr_pct >= 0 ? "up" : "down"}`}>{pct(d.twr_pct)}</div></div>
          <div><div className="mute small">XIRR</div><div className={`big-num ${(d.xirr_pct ?? 0) >= 0 ? "up" : "down"}`}>{pct(d.xirr_pct)}</div></div>
          <div><div className="mute small">{d.benchmark ?? "Benchmark"}</div><div className="big-num">{pct(d.benchmark_pct)}</div>{d.excess_pct != null && <Pill tone={d.excess_pct >= 0 ? "teal" : "red"}>{pct(d.excess_pct)} vs benchmark</Pill>}</div>
          {!compact && <div><div className="mute small">Opening → closing</div><div className="big-num">{inr(d.closing_value)}</div><div className="small mute">from {inr(d.opening_value)} · net flow {inr(d.net_flow)}</div></div>}
          {!compact && <div><div className="mute small">Window</div><div className="big-num">{d.days} d</div><div className="small mute">{fmtDate(d.from)} – {fmtDate(d.to)} · {d.valuations} valuations</div></div>}
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 90, marginTop: 14 }}>
          {d.series.map((p: any) => <div key={p.date} title={`${fmtDate(p.date)}: ${inr(p.value)}${p.benchmark ? ` · benchmark ${inr(p.benchmark)}` : ""}`} style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: 2, height: "100%" }}>
            <div style={{ flex: 1, height: `${(Number(p.value) / max) * 100}%`, background: "var(--navy)", borderRadius: 3 }} />
            {p.benchmark && <div style={{ flex: 1, height: `${(Number(p.benchmark) / max) * 100}%`, background: "var(--line)", borderRadius: 3 }} />}
          </div>)}
        </div>
        <div className="row" style={{ justifyContent: "space-between" }}><span className="small mute">{fmtDate(d.series[0].date)}</span><span className="small mute">navy = portfolio · grey = {d.benchmark ?? "benchmark"} rebased</span><span className="small mute">{fmtDate(d.series[d.series.length - 1].date)}</span></div>
        {d.divergence_note && <div className="small" style={{ marginTop: 10, padding: 10, background: "var(--amberSoft)", borderRadius: 6 }}>{d.divergence_note}</div>}
      </>)}
    </Card>
  );
}
