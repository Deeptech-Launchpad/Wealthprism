import React, { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { api } from "../lib/api";
import { Card, Btn, Pill, s } from "../ui";

const inr = (v: any) => { const n = Number(v ?? 0); return Math.abs(n) >= 1e5 ? `₹${(n / 1e5).toFixed(2)} L` : `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`; };
const when = (d?: string | null) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "");
/** Balance sheet on the phone: net worth with liabilities, loans and their next EMI, premiums due, succession gaps, first month below the float. */
export function BalancePanel() {
  const [nw, setNw] = useState<any>(null); const [liab, setLiab] = useState<any[]>([]); const [gaps, setGaps] = useState<any[]>([]); const [cal, setCal] = useState<any[]>([]); const [fc, setFc] = useState<any>(null); const [msg, setMsg] = useState("");
  const load = () => { api<any>("/net-worth").then(setNw).catch(() => {}); api<any[]>("/liabilities").then(setLiab).catch(() => {}); api<any[]>("/succession/gaps").then(setGaps).catch(() => {}); api<any>("/insurance/adequacy").then((a) => setCal(a.premium_calendar.slice(0, 4))).catch(() => {}); api<any>("/cashflow/forecast?full=1&months=6").then(setFc).catch(() => {}); };
  useEffect(load, []);
  const paid = async (l: any) => { const row = l.next_due; if (!row) return; try { const sched = await api<any[]>(`/liabilities/${l.id}/schedule`); const r = sched.find((x) => !x.paid_on); if (r) { await api(`/liabilities/${l.id}/schedule/${r.id}/pay`, { method: "POST", body: "{}" }); setMsg(`${l.lender} EMI of ${when(r.due_date)} marked paid`); load(); } } catch (e: any) { setMsg(e.message); } };
  return (
    <Card title="Balance sheet">
      {nw ? <View style={s.between}><View><Text style={s.mute}>Net worth</Text><Text style={s.big}>{inr(nw.net_worth)}</Text></View><View><Text style={s.mute}>Assets</Text><Text style={s.body}>{inr(nw.assets)}</Text></View><View><Text style={s.mute}>Liabilities</Text><Text style={[s.body, { color: "#B93B31" }]}>{inr(nw.liabilities)}</Text></View></View> : <Text style={s.mute}>Loading…</Text>}
      {fc?.first_below_float ? <Text style={[s.mute, { marginTop: 6, color: "#B7791F" }]}>Cash forecast dips below the float in {fc.first_below_float}</Text> : null}
      {msg ? <Text style={[s.mute, { marginTop: 6 }]}>{msg}</Text> : null}
      {liab.map((l) => <View key={l.id} style={[s.between, s.line]}><View style={{ flex: 1 }}><Text style={s.body}>{l.lender} · {inr(l.outstanding)}</Text><Text style={s.mute}>{String(l.kind).replace(/_/g, " ")}{l.next_due ? ` · next ${when(l.next_due.d)} ${inr(l.next_due.a)}` : " · interest-only"}{l.ltv_breach ? " · LTV breach" : ""}</Text></View>{l.ltv_breach ? <Pill tone="red">LTV {Number(l.ltv_pct).toFixed(0)}%</Pill> : l.next_due ? <Btn title="EMI paid" onPress={() => paid(l)} /> : null}</View>)}
      {cal.map((c, i) => <View key={i} style={[s.between, s.line]}><Text style={s.body}>Premium · {c.insurer} {String(c.kind).replace(/_/g, " ")}</Text><Text style={s.mute}>{when(c.due)} · {inr(c.amount)}</Text></View>)}
      {gaps.filter((g) => g.severity === 3).slice(0, 4).map((g, i) => <View key={i} style={[s.between, s.line]}><View style={{ flex: 1 }}><Text style={s.body}>{g.name}</Text><Text style={s.mute}>{g.detail}</Text></View><Pill tone="amber">{String(g.issue).replace(/_/g, " ")}</Pill></View>)}
    </Card>
  );
}
