import React, { useState } from "react";
import { View, Text, Alert, TextInput, Pressable } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { useApi } from "../lib/useApi";
import { api, inr, fmtDate, session } from "../lib/api";
import { Card, Pill, Btn, Status, s, C } from "../ui";
const label = (x?: string | null) => (x ?? "").replace(/_/g, " ");
const tone = (x?: string | null) => (x === "approved" || x === "converted" || x === "fits" ? "teal" : x === "in_review" || x === "deferred" || x === "fits_with_conditions" ? "amber" : x === "rejected" || x === "prohibited" || x === "conflicts" ? "red" : undefined);
/** FO-158 — research on the phone: the latest digest with approve / reject / defer under one biometric step-up, a proposal reader, and share-sheet / paste ingestion into the inbox. */
export function ResearchPanel({ shared }: { shared?: string | null } = {}) {
  const [view, setView] = useState<"summary" | "digest" | "proposal" | "paste">(shared ? "paste" : "summary"); const [proposalId, setProposalId] = useState<string | null>(null);
  const digests = useApi<any[]>("/research/digests"); const items = useApi<any>("/research/items?limit=50"); const latest = digests.data?.[0] ?? null;
  if (view === "digest" && latest) return <DigestView id={latest.id} onBack={() => { setView("summary"); digests.refetch(); }} onOpen={(id) => { setProposalId(id); setView("proposal"); }} />;
  if (view === "proposal" && proposalId) return <ProposalView id={proposalId} onBack={() => setView(latest ? "digest" : "summary")} />;
  if (view === "paste") return <PasteView initial={shared ?? ""} onBack={() => { setView("summary"); items.refetch(); }} />;
  const triage = (items.data?.items ?? []).filter((i: any) => !i.source_name).length;
  return (
    <Card title="Research">
      {!digests.data || !items.data ? <Status loading={digests.loading || items.loading} error={digests.error ?? items.error} /> : <>
        <View style={s.between}><Text style={s.body}>Latest digest</Text>{latest ? <Pill tone={latest.status === "open" ? "amber" : "teal"}>{fmtDate(latest.period_start)} – {fmtDate(latest.period_end)} · {latest.awaiting ?? 0} to decide</Pill> : <Text style={s.mute}>none yet</Text>}</View>
        <View style={[s.between, { marginTop: 6 }]}><Text style={s.body}>Inbox</Text><Text style={s.num}>{items.data.items.length} items{triage ? ` · ${triage} in triage` : ""}</Text></View>
        <View style={[s.row, { marginTop: 10, flexWrap: "wrap" }]}>{latest && <Btn primary title="Open digest" onPress={() => setView("digest")} />}<Btn title="Forward a tip" onPress={() => setView("paste")} /></View>
      </>}
    </Card>
  );
}
function DigestView({ id, onBack, onOpen }: { id: string; onBack: () => void; onOpen: (id: string) => void }) {
  const d = useApi<any>(`/research/digests/${id}`); const [dec, setDec] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  const role = session.get()?.families.find((f) => f.id === session.family())?.role ?? "viewer"; const canDecide = ["owner", "member"].includes(role);
  const submit = async () => {
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: `Decide ${Object.keys(dec).length} proposal${Object.keys(dec).length === 1 ? "" : "s"}` }).catch(() => ({ success: true })); if (!("success" in r) || !r.success) return;
    setBusy(true); try { await api(`/research/digests/${id}/decide`, { method: "POST", body: JSON.stringify({ decisions: Object.entries(dec).map(([proposal_id, decision]) => ({ proposal_id, decision, convert: decision === "approve" })), auth_method: "biometric", auth_proof: "000000" }) }); setDec({}); d.refetch(); Alert.alert("Decided", "Approved proposals are now intents in the Action plane for the second approver."); } catch (e: any) { Alert.alert("Not decided", e.message); } finally { setBusy(false); }
  };
  if (!d.data) return <Status loading={d.loading} error={d.error} />;
  const sm = d.data.summary;
  return (<><View style={s.row}><Btn title="‹ Back" onPress={onBack} /><Pill tone={d.data.status === "open" ? "amber" : "teal"}>{d.data.status}</Pill></View>
    <Card title={`Digest · ${fmtDate(d.data.period_start)} – ${fmtDate(d.data.period_end)}`}>
      <Text style={s.mute}>{sm.items} items · {sm.recommendations} recommendations · {sm.clusters} clusters · {sm.declined_count} declined with reasons</Text>
      {sm.themes?.length > 0 && <Text style={[s.mute, { marginTop: 4 }]}>Themes: {sm.themes.join(" · ")}</Text>}
    </Card>
    <Card title="Proposals awaiting decision">
      {d.data.proposals.map((p: any) => <View key={p.id} style={s.line}>
        <Pressable onPress={() => onOpen(p.id)}><Text style={[s.body, { fontWeight: "600" }]}>{p.title}</Text><Text style={s.mute}>fit {Math.round(p.policy_fit?.fit_score ?? 0)} · {label(p.policy_fit?.verdict)} · {p.entity_name}{p.defer_until ? ` · deferred to ${fmtDate(p.defer_until)}` : ""}</Text></Pressable>
        <View style={[s.row, { marginTop: 6, flexWrap: "wrap" }]}><Pill tone={tone(p.status)}>{label(p.status)}</Pill>{canDecide && ["in_review", "deferred"].includes(p.status) && d.data.status === "open" && ["approve", "reject", "defer"].map((k) => <Btn key={k} title={k} primary={dec[p.id] === k} onPress={() => setDec({ ...dec, [p.id]: k })} />)}</View>
      </View>)}
      {!d.data.proposals.length && <Text style={s.mute}>Nothing to decide this period.</Text>}
      {canDecide && Object.keys(dec).length > 0 && <View style={{ marginTop: 10 }}><Btn primary title={busy ? "Submitting…" : `Submit ${Object.keys(dec).length} decision${Object.keys(dec).length === 1 ? "" : "s"} (biometric)`} onPress={submit} /></View>}
    </Card>
    <Card title="Declined, with reasons">{(sm.dismissed ?? []).map((x: any) => <View key={x.cluster_id} style={s.line}><View style={s.between}><Text style={[s.body, { flex: 1 }]}>{x.instrument} · {x.direction}</Text><Pill tone={tone(x.verdict)}>{label(x.verdict)}</Pill></View><Text style={s.mute}>{x.reason}</Text></View>)}{!(sm.dismissed ?? []).length && <Text style={s.mute}>Nothing declined.</Text>}</Card></>);
}
function ProposalView({ id, onBack }: { id: string; onBack: () => void }) {
  const p = useApi<any>(`/research/proposals/${id}`);
  if (!p.data) return <Status loading={p.loading} error={p.error} />;
  const sec = p.data.sections; const Block = ({ t, children }: { t: string; children: React.ReactNode }) => <View style={{ marginTop: 10 }}><Text style={[s.mute, { color: C.teal, fontWeight: "600" }]}>{t}</Text>{children}</View>;
  return (<><View style={s.row}><Btn title="‹ Back" onPress={onBack} /><Pill tone={tone(p.data.status)}>{label(p.data.status)} · v{p.data.version}</Pill></View>
    <Card><Text style={s.big}>{p.data.title}</Text><Text style={s.mute}>{p.data.entity_name} · {inr(p.data.amount)} · fit {Math.round(sec.policy_fit.fit_score)} ({label(sec.policy_fit.verdict)}) · expires {fmtDate(p.data.expires_at)}</Text>
      <Block t="Summary"><Text style={s.body}>{sec.summary}</Text></Block>
      <Block t="Thesis"><Text style={s.body}>{sec.thesis}</Text></Block>
      <Block t="Counter-view"><Text style={s.body}>{sec.counter_view}</Text></Block>
      <Block t="Sources">{sec.sources.map((x: any) => <Text key={x.name} style={s.mute}>• {x.name} ({label(x.kind)}, trust {Math.round(x.trust_score)}) — {x.action}{x.conflict_of_interest && x.conflict_of_interest !== "none" ? ` · ${x.conflict_of_interest}` : ""}{x.track_record_12m ? ` · ${x.track_record_12m.hit_rate_pct}% hit, ${x.track_record_12m.avg_excess_pct > 0 ? "+" : ""}${x.track_record_12m.avg_excess_pct}% excess` : ""}</Text>)}</Block>
      <Block t="Policy fit">{sec.policy_fit.checks.map((c: any, i: number) => <Text key={i} style={s.mute}>• {c.clause}: <Text style={{ color: c.status === "pass" ? C.teal : c.status === "warning" ? C.amber : c.status === "fail" ? C.red : C.mute }}>{c.status}</Text> — {c.detail}</Text>)}</Block>
      <Block t="Portfolio & tax"><Text style={s.mute}>{sec.portfolio_impact.asset_class.key} {sec.portfolio_impact.asset_class.before_pct}% → {sec.portfolio_impact.asset_class.after_pct}% · cash after {inr(sec.portfolio_impact.cash_after)} · {sec.tax_impact.note}</Text></Block>
      <Block t="Sizing & execution"><Text style={s.mute}>{sec.sizing.rationale}</Text>{sec.execution_plan.map((t: any) => <Text key={t.tranche} style={s.mute}>• Tranche {t.tranche}: {inr(t.amount)} · {t.connector} — {t.instruction}</Text>)}</Block>
      <Block t="Exit & monitoring"><Text style={s.mute}>Target {sec.exit_plan.target_price ?? "—"} · stop {sec.exit_plan.stop_loss ?? "—"} · {sec.exit_plan.horizon_months} months · {sec.exit_plan.review_trigger}</Text>{sec.monitoring.map((m: string, i: number) => <Text key={i} style={s.mute}>• {m}</Text>)}</Block>
      <Text style={[s.mute, { marginTop: 10, fontSize: 11 }]}>{sec.disclaimer}</Text></Card></>);
}
function PasteView({ initial, onBack }: { initial: string; onBack: () => void }) {
  const [text, setText] = useState(initial); const [sender, setSender] = useState(""); const [busy, setBusy] = useState(false); const [result, setResult] = useState<any>(null);
  const send = async () => { setBusy(true); try { setResult(await api("/research/items", { method: "POST", body: JSON.stringify({ body_text: text, sender: sender || undefined, channel_kind: "whatsapp" }) })); } catch (e: any) { Alert.alert("Not ingested", e.message); } finally { setBusy(false); } };
  return (<><View style={s.row}><Btn title="‹ Back" onPress={onBack} /></View>
    <Card title="Forward a tip or note"><Text style={s.mute}>Paste a WhatsApp forward, a newsletter or a note (or share it to the app). Same content twice is one item; unknown senders go to triage.</Text>
      <TextInput style={[s.input, { marginTop: 8 }]} placeholder="sender (phone / e-mail)" value={sender} onChangeText={setSender} />
      <TextInput style={[s.input, { marginTop: 8, minHeight: 120, textAlignVertical: "top" }]} multiline placeholder="Bro, XYZ is going to double…" value={text} onChangeText={setText} />
      <View style={{ marginTop: 8 }}><Btn primary title={busy ? "Sending…" : "Send to inbox"} onPress={send} /></View>
      {result && <Text style={[s.mute, { marginTop: 8 }]}>{result.duplicate ? "Already in the inbox." : `${result.recommendation_count} recommendation${result.recommendation_count === 1 ? "" : "s"} extracted${result.source_name ? ` · ${result.source_name}` : " · in triage (unknown sender)"}${result.review_count ? ` · ${result.review_count} to review on the web` : ""}`}</Text>}
    </Card></>);
}
