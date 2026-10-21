import React, { useState } from "react";
import { View, Text, Alert, TextInput, Pressable } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { useApi } from "../lib/useApi";
import { api, inr, fmtDate, session } from "../lib/api";
import { Screen, Card, Pill, Btn, Status, s, C } from "../ui";
const tone = (st: string) => st === "in_review" ? "amber" : st === "approved" || st === "executing" ? "blue" : st === "completed" ? "teal" : st === "archived" ? "red" : undefined;
const signed = (n: number | null | undefined) => n == null ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${inr(Math.abs(n))}`;
/** FO-81 — scenario review on the phone: what changes, the tax/cash/allocation deltas, comments, then approve (owner, biometric) or send back. */
export function PlansScreen() {
  const list = useApi<any[]>("/plans");
  const [openId, setOpenId] = useState<string | null>(null);
  if (openId) return <PlanDetail id={openId} onBack={() => { setOpenId(null); list.refetch(); }} />;
  if (!list.data) return <Screen><Status loading={list.loading} error={list.error} /></Screen>;
  const review = list.data.filter((p) => p.status === "in_review"), active = list.data.filter((p) => ["approved", "executing"].includes(p.status)), rest = list.data.filter((p) => !p.is_baseline && !["in_review", "approved", "executing"].includes(p.status));
  const Row = ({ p }: { p: any }) => (
    <Pressable key={p.id} style={s.line} onPress={() => setOpenId(p.id)}>
      <View style={s.between}><Text style={[s.body, { fontWeight: "600", flex: 1 }]}>{p.name}</Text><Pill tone={tone(p.status)}>{p.status.replace("_", " ")}</Pill></View>
      <Text style={[s.mute, { marginTop: 3 }]}>{p.action_count} action{Number(p.action_count) === 1 ? "" : "s"} · {p.horizon_fys} FY · tax vs baseline {signed(p.latest_result?.summary?.tax_vs_baseline)}{p.status === "executing" ? ` · ${p.execution?.pct ?? 0}% done` : ""}</Text>
    </Pressable>);
  return (
    <Screen refreshing={list.loading} onRefresh={list.refetch}>
      <Card title={`${review.length} awaiting review`}>{review.map((p) => <Row key={p.id} p={p} />)}{!review.length && <Text style={s.mute}>Nothing to review.</Text>}</Card>
      <Card title="Approved & executing">{active.map((p) => <Row key={p.id} p={p} />)}{!active.length && <Text style={s.mute}>None in flight.</Text>}</Card>
      {rest.length > 0 && <Card title="Drafts & history">{rest.map((p) => <Row key={p.id} p={p} />)}</Card>}
    </Screen>
  );
}
function PlanDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const d = useApi<any>(`/plans/${id}`);
  const [note, setNote] = useState(""); const [busy, setBusy] = useState(false);
  const role = session.get()?.families.find((f) => f.id === session.family())?.role ?? session.get()?.families[0]?.role;
  const move = async (status: string) => {
    if (status === "approved") { const r = await LocalAuthentication.authenticateAsync({ promptMessage: "Approve this plan" }).catch(() => ({ success: true })); if (!("success" in r) || !r.success) return; }
    setBusy(true);
    try { const r = await api<any>(`/plans/${id}/status`, { method: "POST", body: JSON.stringify({ status, note: note || undefined }) }); setNote(""); d.refetch(); if (r.tasks_created) Alert.alert("Approved", `${r.tasks_created} execution task${r.tasks_created === 1 ? "" : "s"} created.`); }
    catch (e: any) { Alert.alert("Not allowed", e.message); } finally { setBusy(false); }
  };
  const comment = async () => { if (!note.trim()) return; setBusy(true); try { await api(`/plans/${id}/comments`, { method: "POST", body: JSON.stringify({ body: note }) }); setNote(""); d.refetch(); } catch (e: any) { Alert.alert("Failed", e.message); } finally { setBusy(false); } };
  if (!d.data) return <Screen><Status loading={d.loading} error={d.error} /></Screen>;
  const p = d.data, r = p.latest_result, sum = r?.summary ?? {};
  return (
    <Screen refreshing={d.loading || busy} onRefresh={d.refetch}>
      <View style={s.row}><Btn title="‹ Plans" onPress={onBack} /><Pill tone={tone(p.status)}>{p.status.replace("_", " ")}</Pill></View>
      <Card>
        <Text style={s.big}>{p.name}</Text>
        <Text style={s.mute}>{p.horizon_fys} FY from {fmtDate(p.base_date)} · by {p.created_by_name ?? "—"} · v{p.version}{p.approved_at ? ` · approved ${fmtDate(p.approved_at)}` : ""}</Text>
        {p.description ? <Text style={[s.body, { marginTop: 6 }]}>{p.description}</Text> : null}
      </Card>
      <Card title="Effect vs baseline">
        {r ? <>
          <View style={s.between}><Text style={s.body}>Tax over horizon</Text><Text style={s.num}>{inr(sum.tax_total)}</Text></View>
          <View style={s.between}><Text style={s.body}>Saving vs baseline</Text><Text style={[s.num, { color: (sum.tax_vs_baseline ?? 0) <= 0 ? C.teal : C.red, fontWeight: "600" }]}>{signed(sum.tax_vs_baseline == null ? null : -sum.tax_vs_baseline)}</Text></View>
          <View style={s.between}><Text style={s.body}>Post-tax cash</Text><Text style={s.num}>{inr(sum.post_tax_cash)}</Text></View>
          <View style={s.between}><Text style={s.body}>Max bucket drift after</Text><Text style={s.num}>{sum.drift_max_pp ?? 0} pp</Text></View>
          <View style={s.between}><Text style={s.body}>Net worth at horizon</Text><Text style={s.num}>{inr(sum.net_worth_end)}</Text></View>
          {(r.allocation_after ?? []).map((a: any) => <View key={a.bucket} style={s.between}><Text style={s.mute}>{a.bucket}</Text><Text style={[s.mute, a.breached && { color: C.red }]}>{a.pct}% (target {a.target_pct}%)</Text></View>)}
          {(r.warnings ?? []).map((w: string, i: number) => <Text key={i} style={[s.mute, { color: C.amber, marginTop: 4 }]}>⚠ {w}</Text>)}
        </> : <Text style={s.mute}>Not simulated yet — simulate from the web before review.</Text>}
      </Card>
      <Card title={`${p.actions.length} actions`}>
        {p.actions.map((a: any) => <View key={a.id} style={s.line}>
          <View style={s.between}><Text style={[s.body, { fontWeight: "600", flex: 1 }]}>{a.seq}. {a.kind.replace(/_/g, " ")}</Text><Pill tone={a.status === "done" ? "teal" : a.status === "skipped" ? "red" : undefined}>{a.status}</Pill></View>
          <Text style={s.mute}>{fmtDate(a.planned_date)}{a.planned_amount != null ? ` · ${inr(a.planned_amount)}` : ""}{a.simulated_effect?.tax != null ? ` · tax ${signed(a.simulated_effect.tax)}` : ""}{a.simulated_effect?.gain != null ? ` · gain ${signed(a.simulated_effect.gain)}` : ""}</Text>
          {(a.simulated_effect?.warnings ?? []).map((w: string, i: number) => <Text key={i} style={[s.mute, { color: C.amber }]}>⚠ {w}</Text>)}
        </View>)}
      </Card>
      <Card title="Discussion">
        {p.comments.map((c: any) => <View key={c.id} style={s.line}><Text style={s.body}>{c.body}</Text><Text style={s.mute}>{c.user_name} · {fmtDate(c.created_at)}</Text></View>)}
        <TextInput style={[s.input, { marginTop: 8 }]} placeholder="Note or question…" value={note} onChangeText={setNote} multiline />
        <View style={[s.row, { marginTop: 8, flexWrap: "wrap" }]}>
          <Btn title="Comment" onPress={comment} />
          {p.status === "in_review" && role === "owner" && <Btn primary title="Approve" onPress={() => move("approved")} />}
          {p.status === "in_review" && <Btn title="Send back to draft" onPress={() => move("draft")} />}
          {p.status === "draft" && <Btn primary title="Submit for review" onPress={() => move("in_review")} />}
          {["draft", "in_review"].includes(p.status) && <Btn title="Archive" onPress={() => move("archived")} />}
        </View>
        {p.status === "in_review" && role !== "owner" && <Text style={[s.mute, { marginTop: 6 }]}>Only an owner can approve; approving raises one execution task per action.</Text>}
      </Card>
    </Screen>
  );
}
