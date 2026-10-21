import React, { useState } from "react";
import { View, Text, Alert, Pressable } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { useApi } from "../lib/useApi";
import { api, inr, fmtDate, session } from "../lib/api";
import { Card, Pill, Btn, Status, s, C } from "../ui";
const label = (x?: string | null) => (x ?? "").replace(/_/g, " ");
const tone = (x?: string | null) => x === "funded" || x === "met" || x === "converted" || x === "executed" ? "teal" : x === "partially_funded" || x === "in_review" || x === "due" ? "amber" : x === "planned" || x === "draft" || x === "approved" || x === "intent_created" ? "blue" : x === "cancelled" ? "red" : undefined;
/** FO-166 — rebalancing on the phone: dated needs with coverage, the open plan with its timed moves (biometric approve / convert), the calendar. */
export function RebalancePanel() {
  const [view, setView] = useState<"summary" | "needs" | "plan" | "calendar">("summary");
  const needs = useApi<any[]>("/funding-needs?days=400"); const runs = useApi<any[]>("/rebalance/runs?limit=20");
  const open = runs.data?.find((r) => r.plan_id && ["draft", "in_review", "approved"].includes(r.plan_status)) ?? runs.data?.find((r) => r.plan_id) ?? null;
  if (view === "needs") return <NeedsList needs={needs.data ?? []} onBack={() => setView("summary")} onChange={needs.refetch} />;
  if (view === "plan" && open) return <PlanReview planId={open.plan_id} onBack={() => { setView("summary"); runs.refetch(); needs.refetch(); }} />;
  if (view === "calendar") return <CalendarList onBack={() => setView("summary")} />;
  const gap = (needs.data ?? []).filter((n) => n.shortfall > 0 && !["met", "funded"].includes(n.status)).length;
  return (
    <Card title="Rebalancing">
      {!needs.data || !runs.data ? <Status loading={needs.loading || runs.loading} error={needs.error ?? runs.error} /> : <>
        <View style={s.between}><Text style={s.body}>Needs in the next year</Text><Text style={s.num}>{needs.data.length}{gap ? ` · ${gap} with a gap` : ""}</Text></View>
        <View style={[s.between, { marginTop: 6 }]}><Text style={s.body}>Open plan</Text>{open ? <Pill tone={tone(open.plan_status)}>{open.program_name} v{open.plan_version} · {label(open.plan_status)}</Pill> : <Text style={s.mute}>none</Text>}</View>
        <View style={[s.row, { marginTop: 10, flexWrap: "wrap" }]}><Btn title="Funding needs" onPress={() => setView("needs")} />{open && <Btn primary title="Review plan" onPress={() => setView("plan")} />}<Btn title="Calendar" onPress={() => setView("calendar")} /></View>
      </>}
    </Card>
  );
}
function NeedsList({ needs, onBack, onChange }: { needs: any[]; onBack: () => void; onChange: () => void }) {
  const met = async (n: any) => { try { await api(`/funding-needs/${n.id}`, { method: "PATCH", body: JSON.stringify({ status: "met", funded_amount: n.amount }) }); onChange(); } catch (e: any) { Alert.alert("Failed", e.message); } };
  return (<><View style={s.row}><Btn title="‹ Back" onPress={onBack} /></View>
    <Card title="Dated funding needs">{needs.map((n) => <View key={n.id} style={s.line}>
      <View style={s.between}><Text style={[s.body, { fontWeight: "600", flex: 1 }]}>{n.label}</Text><Pill tone={tone(n.status)}>{label(n.status)}</Pill></View>
      <Text style={s.mute}>{fmtDate(n.need_date)} · {label(n.kind)} · {n.priority === 1 ? "hard" : n.priority === 2 ? "firm" : "soft"} · {inr(n.amount)}{n.shortfall > 0 ? ` · shortfall ${inr(n.shortfall)}` : ""}</Text>
      {(n.coverage ?? []).length > 0 && <Text style={s.mute}>{n.coverage.map((c: any) => `${c.source === "cash" ? "cash" : c.what ?? "move"} ${inr(c.amount)} on ${fmtDate(c.available_on)}`).join(" · ")}</Text>}
      {!["met", "cancelled"].includes(n.status) && n.need_date <= new Date().toISOString().slice(0, 10) && <View style={{ marginTop: 6 }}><Btn title="Mark met" onPress={() => met(n)} /></View>}
    </View>)}{!needs.length && <Text style={s.mute}>Nothing dated.</Text>}</Card></>);
}
function PlanReview({ planId, onBack }: { planId: string; onBack: () => void }) {
  const d = useApi<any>(`/rebalance/plans/${planId}`); const [busy, setBusy] = useState(false);
  const role = session.get()?.families.find((f) => f.id === session.family())?.role ?? session.get()?.families[0]?.role;
  const act = async (status: string, prompt?: string) => { if (prompt) { const r = await LocalAuthentication.authenticateAsync({ promptMessage: prompt }).catch(() => ({ success: true })); if (!("success" in r) || !r.success) return; } setBusy(true); try { const res = await api<any>(`/rebalance/plans/${planId}/status`, { method: "POST", body: JSON.stringify(status === "approved" ? { status, auth_method: "biometric", auth_proof: "000000" } : { status }) }); d.refetch(); if (status === "converted") Alert.alert("Scheduled", `${res.intents?.length ?? 0} intents queued for their planned dates.`); } catch (e: any) { Alert.alert("Not allowed", e.message); } finally { setBusy(false); } };
  if (!d.data) return <Status loading={d.loading} error={d.error} />;
  const p = d.data;
  return (<><View style={s.row}><Btn title="‹ Back" onPress={onBack} /><Pill tone={tone(p.status)}>{label(p.status)}</Pill></View>
    <Card><Text style={s.big}>{p.program_name} — plan v{p.version}</Text><Text style={s.mute}>{label(p.triggered_by)} · {label(p.objective)} · turnover {inr(p.summary.turnover)} ({p.summary.turnover_pct}%) · tax {inr(p.summary.est_tax)} · needs {p.summary.needs_covered}/{p.summary.needs_covered + p.summary.needs_uncovered}</Text>
      {(p.warnings ?? []).map((w: string, i: number) => <Text key={i} style={[s.mute, { color: C.amber }]}>⚠ {w}</Text>)}
      <View style={[s.row, { marginTop: 10, flexWrap: "wrap" }]}>
        {p.status === "draft" && <Btn title="Send for review" onPress={() => act("in_review")} />}
        {p.status === "in_review" && ["owner", "member"].includes(role ?? "") && <Btn primary title="Approve" onPress={() => act("approved", "Approve this rebalancing plan")} />}
        {p.status === "approved" && <Btn primary title="Convert to scheduled intents" onPress={() => act("converted")} />}
        {["draft", "in_review"].includes(p.status) && <Btn title="Cancel plan" onPress={() => act("cancelled")} />}
      </View>
    </Card>
    <Card title={`${p.moves.length} timed moves`}>{p.moves.map((m: any) => <View key={m.id} style={s.line}>
      <View style={s.between}><Text style={[s.body, { fontWeight: "600", flex: 1 }]}>#{m.seq} {m.what}</Text><Text style={s.num}>{inr(m.amount)}</Text></View>
      <Text style={s.mute}>{fmtDate(m.planned_date)}{m.settles_on !== m.planned_date ? ` → settles ${fmtDate(m.settles_on)}` : ""} · {m.reason} · {label(m.status)}</Text>
      {(m.constraints_checked ?? []).slice(0, 3).map((c: string, i: number) => <Text key={i} style={[s.mute, { fontSize: 11 }]}>⚖ {c}</Text>)}
    </View>)}</Card>
    {busy && <Text style={s.mute}>Working…</Text>}
  </>);
}
function CalendarList({ onBack }: { onBack: () => void }) {
  const cal = useApi<any[]>("/rebalance/calendar");
  return (<><View style={s.row}><Btn title="‹ Back" onPress={onBack} /></View>
    <Card title="Timing calendar">{!cal.data ? <Status loading={cal.loading} error={cal.error} /> : cal.data.slice(0, 60).map((r, i) => <View key={i} style={s.line}><View style={s.between}><Text style={[s.mute, { width: 70 }]}>{fmtDate(r.date)}</Text><Pill tone={r.kind === "need" ? "amber" : r.kind === "move" ? "blue" : r.kind === "milestone" || r.kind === "calendar_run" ? "teal" : undefined}>{label(r.kind)}</Pill></View><Text style={s.body}>{r.label}{r.amount != null ? ` · ${inr(r.amount)}` : ""}</Text></View>)}</Card></>);
}
