import React from "react";
import { View, Text } from "react-native";
import { useApi } from "../lib/useApi";
import { inr, fmtDate } from "../lib/api";
import { Screen, Card, Pill, Status, s, C } from "../ui";
const BC: Record<string, string> = { liquidity: C.blue, income: C.teal, growth: C.violet };
const pct = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
function PerformanceCard() {
  const { data } = useApi<any>("/performance?scope_type=family&period=si");
  if (!data || data.valuations < 2) return null;
  return (
    <Card title={`Performance · ${data.period.toUpperCase()}`}>
      <View style={[s.row, { gap: 16 }]}>
        <View><Text style={s.mute}>TWR</Text><Text style={[s.big, { color: data.twr_pct >= 0 ? C.teal : C.red }]}>{pct(data.twr_pct)}</Text></View>
        <View><Text style={s.mute}>XIRR</Text><Text style={[s.big, { color: (data.xirr_pct ?? 0) >= 0 ? C.teal : C.red }]}>{pct(data.xirr_pct)}</Text></View>
        <View><Text style={s.mute}>{data.benchmark ?? "Benchmark"}</Text><Text style={s.big}>{pct(data.benchmark_pct)}</Text></View>
      </View>
      {data.divergence_note ? <Text style={[s.mute, { marginTop: 8 }]}>{data.divergence_note}</Text> : null}
    </Card>
  );
}
export function DashboardScreen() {
  const { data, error, loading, refetch } = useApi<any>("/dashboard");
  if (!data) return <Screen><Status loading={loading} error={error} /></Screen>;
  return (
    <Screen refreshing={loading} onRefresh={refetch}>
      <Card>
        <Text style={s.mute}>Consolidated net worth</Text><Text style={s.hero}>{inr(data.net_worth)}</Text>
        <Text style={s.mute}>{data.by_entity.length} entities · holdings, property, private, cash{data.net_worth_mom_pct != null ? ` · ${data.net_worth_mom_pct > 0 ? "+" : ""}${data.net_worth_mom_pct}% MoM` : ""}{data.xirr_si_pct != null ? ` · XIRR ${data.xirr_si_pct}%` : ""}</Text>
        {data.trend?.length > 1 && <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 3, height: 40, marginTop: 10 }}>{data.trend.map((t: any) => <View key={t.month} style={{ flex: 1, height: `${Math.max(6, (Number(t.value) / Math.max(...data.trend.map((x: any) => Number(x.value)))) * 100)}%`, backgroundColor: C.teal, borderRadius: 2, opacity: 0.85 }} />)}</View>}
      </Card>
      <PerformanceCard />
      <View style={[s.row, { gap: 12 }]}>
        <View style={[s.card, { flex: 1 }]}><Text style={s.mute}>Bank balances</Text><Text style={s.big}>{inr(data.bank_balance_total)}</Text><Text style={s.mute}>{data.bank_accounts_live}/{data.bank_accounts_total} live</Text></View>
        <View style={[s.card, { flex: 1 }]}><Text style={s.mute}>Rent this month</Text><Text style={s.big}>{inr(data.rent.due)}</Text><Text style={{ color: data.rent.overdue_count ? C.red : C.mute, fontSize: 12 }}>{data.rent.overdue_count} overdue</Text></View>
      </View>
      <Card title="Three-bucket strategy">
        <View style={{ flexDirection: "row", height: 30, borderRadius: 6, overflow: "hidden", gap: 2 }}>{data.buckets.map((b: any) => <View key={b.bucket} style={{ flex: b.actualPct, backgroundColor: BC[b.bucket], justifyContent: "center", paddingHorizontal: 6 }}><Text style={{ color: "#fff", fontSize: 11 }} numberOfLines={1}>{b.actualPct}%</Text></View>)}</View>
        {data.buckets.map((b: any) => <View key={b.bucket} style={[s.between, s.line]}><Text style={[s.body, { textTransform: "capitalize" }]}>{b.bucket} <Text style={s.mute}>target {b.targetPct}%</Text></Text><Pill tone={b.breached ? "amber" : "teal"}>{b.driftPp > 0 ? "+" : ""}{b.driftPp} pp</Pill></View>)}
      </Card>
      <Card title="By entity">{data.by_entity.map((e: any) => <View key={e.entity_id} style={[s.between, s.line]}><Text style={s.body}>{e.name}</Text><Text style={s.num}>{inr(e.net_worth)}</Text></View>)}</Card>
      <Card title="Needs attention">{data.attention.map((t: any) => <View key={t.id} style={s.line}><View style={s.row}><Pill tone={t.severity === 1 ? "red" : t.severity === 2 ? "amber" : undefined}>{t.module}</Pill><Text style={s.mute}>{fmtDate(t.due_date)}</Text></View><Text style={[s.body, { marginTop: 4 }]}>{t.title}</Text></View>)}</Card>
    </Screen>
  );
}
