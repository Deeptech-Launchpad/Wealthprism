import React, { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { api, inr } from "../lib/api";
import { Card, Btn, Pill, s } from "../ui";

/** Goals & working capital on the phone: goals with funded %, bucket drift, the asset-class lens status, and the deployable excess with one tap to build a plan. */
export function GoalsPanel() {
  const [goals, setGoals] = useState<any[]>([]); const [drift, setDrift] = useState<any[]>([]); const [alloc, setAlloc] = useState<any | null>(null); const [wc, setWc] = useState<any | null>(null); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);
  const load = () => { api<any[]>("/goals").then(setGoals).catch(() => {}); api<any[]>("/buckets/drift").then(setDrift).catch(() => {}); api<any>("/allocation/status").then(setAlloc).catch(() => {}); api<any>("/working-capital/summary").then(setWc).catch(() => {}); };
  useEffect(load, []);
  const plan = async () => { setBusy(true); setMsg(""); try { const p = await api<any>("/working-capital/plan", { method: "POST", body: "{}" }); setMsg(`Plan for ${inr(p.excess_amount)}: ${(p.lines ?? []).map((l: any) => `${l.instrument} ${inr(l.amount)}`).join(", ")} — create the tasks on the web`); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); } };
  return (
    <Card title="Goals & buckets">
      {drift.map((b) => <View key={b.bucket} style={[s.between, s.line]}><Text style={s.body}>{b.bucket}</Text><View style={s.row}><Text style={s.mute}>{b.actualPct}% vs {b.targetPct}%</Text><Pill tone={b.breached ? "amber" : "teal"}>{b.driftPp > 0 ? "+" : ""}{b.driftPp} pp</Pill></View></View>)}
      {alloc ? <Text style={[s.mute, { marginTop: 6 }]}>{alloc.model ?? "No model"} · {alloc.breaches} band breach{alloc.breaches === 1 ? "" : "es"} · satellite {alloc.satellite_pct}%</Text> : null}
      {goals.map((g) => <View key={g.id} style={[s.between, s.line]}><View style={{ flex: 1 }}><Text style={s.body}>{g.name}</Text><Text style={s.mute}>{g.target_year} · needs {inr(g.inflated_need)} · {g.funded_pct ?? 0}% funded{Number(g.monthly_required) > 0 ? ` · ${inr(g.monthly_required)} / month` : ""}</Text></View><Pill tone={g.on_track ? "teal" : "amber"}>{g.bucket}</Pill></View>)}
      {wc ? <View style={[s.between, { marginTop: 8 }]}><View><Text style={s.mute}>Deployable excess</Text><Text style={s.body}>{inr(wc.deployable_excess)} · float {inr(wc.required_float)}</Text></View>{Number(wc.deployable_excess) > 0 && !busy ? <Btn title="Build plan" onPress={plan} /> : null}</View> : null}
      {msg ? <Text style={[s.mute, { marginTop: 6 }]}>{msg}</Text> : null}
    </Card>
  );
}
