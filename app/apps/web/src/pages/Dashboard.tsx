import { useApi } from "../lib/useApi";
import { inr } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";
import { Performance } from "./Performance";
const BC: Record<string, string> = { liquidity: "var(--blue)", income: "var(--teal)", growth: "var(--violet)" };
export function Dashboard() {
  const { data, error, loading } = useApi<any>("/dashboard");
  if (loading || error) return <Status loading={loading} error={error} />;
  const d = data!;
  return (<>
    <div className="kpis">
      <Card style={{ gridColumn: "span 2" }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div><div className="mute">Consolidated net worth</div><div className="hero-num">{inr(d.net_worth)}</div><div className="small mute">{d.by_entity.length} entities · holdings, property, private, cash{d.net_worth_mom_pct != null && <> · <span className={d.net_worth_mom_pct >= 0 ? "up" : "down"}>{d.net_worth_mom_pct > 0 ? "+" : ""}{d.net_worth_mom_pct}% MoM</span></>}{d.xirr_si_pct != null && <> · XIRR {d.xirr_si_pct}% since inception</>}</div></div>
          {d.trend.length > 1 && <div title="Investment value, month-ends" style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 44, width: 150 }}>{d.trend.map((t: any) => <div key={t.month} title={`${t.month}: ${inr(t.value)}`} style={{ flex: 1, height: `${Math.max(6, (Number(t.value) / Math.max(...d.trend.map((x: any) => Number(x.value)))) * 100)}%`, background: "var(--teal)", borderRadius: 2, opacity: 0.85 }} />)}</div>}
        </div>
      </Card>
      <Card><div className="mute">Bank balances</div><div className="big-num">{inr(d.bank_balance_total)}</div><div className="small mute">{d.bank_accounts_live} of {d.bank_accounts_total} live (AA)</div></Card>
      <Card><div className="mute">Rent this month</div><div className="big-num">{inr(d.rent.due)}</div><div className="small"><span className={d.rent.overdue_count ? "down" : "mute"}>{d.rent.overdue_count} overdue</span> <span className="mute">· {d.rent.received_count} received</span></div></Card>
      <Card><div className="mute">Capital gains FY</div><div className="big-num">{inr(d.capital_gains_ytd)}</div></Card>
    </div>
    <div className="grid-2">
      <Card title="Three-bucket strategy">
        <div className="bucket-bar">{d.buckets.map((b: any) => <div key={b.bucket} className="bucket-seg" style={{ flex: b.actualPct, background: BC[b.bucket] }}>{b.bucket} {b.actualPct}%</div>)}</div>
        <div className="bucket-target">{d.buckets.map((b: any) => <div key={b.bucket} style={{ flex: b.targetPct, borderColor: BC[b.bucket] }} />)}</div>
        <table className="tbl" style={{ marginTop: 10 }}><tbody>{d.buckets.map((b: any) => <tr key={b.bucket}><td style={{ textTransform: "capitalize" }}>{b.bucket}</td><td className="num">{inr(b.value)}</td><td className="num mute">target {b.targetPct}%</td><td className="num"><Pill tone={b.breached ? "amber" : "teal"}>{b.driftPp > 0 ? "+" : ""}{b.driftPp} pp</Pill></td></tr>)}</tbody></table>
      </Card>
      <Card title="Net worth by entity"><table className="tbl"><thead><tr><th>Entity</th><th className="num">Net worth</th></tr></thead><tbody>{d.by_entity.map((e: any) => <tr key={e.entity_id}><td>{e.name}</td><td className="num">{inr(e.net_worth)}</td></tr>)}</tbody></table></Card>
    </div>
    <Performance compact />
    <Card title="Needs attention">{d.attention.map((t: any) => <div key={t.id} className="attn"><Pill tone={t.severity === 1 ? "red" : t.severity === 2 ? "amber" : undefined}>{t.module}</Pill><span style={{ flex: 1 }}>{t.title}</span><span className="small mute">{fmtDate(t.due_date)}</span></div>)}</Card>
  </>);
}
