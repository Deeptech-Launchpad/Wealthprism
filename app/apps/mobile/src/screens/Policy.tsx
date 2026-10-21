import React, { useState } from "react";
import { View, Text, Alert, Pressable } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { useApi } from "../lib/useApi";
import { api, fmtDate, session } from "../lib/api";
import { Card, Pill, Btn, Status, s, C } from "../ui";
const tone = (x?: string | null) => x === "compliant" || x === "in_band" || x === "active" ? "teal" : x === "warning" || x === "in_review" ? "amber" : x === "breach" ? "red" : x === "draft" ? "blue" : undefined;
const label = (x: string) => x.replace(/_/g, " ");
const val = (v: any): string => (v == null ? "—" : typeof v === "object" ? ("target_pct" in v ? `${v.target_pct}%${v.min_pct != null || v.max_pct != null ? ` (${v.min_pct ?? "—"}–${v.max_pct ?? "—"})` : ""}` : "limit_value" in v ? `${v.operator} ${v.limit_value}` : "params" in v ? Object.values(v.params).join(" ") : Array.isArray(v) ? v.map((x) => (typeof x === "object" && x ? Object.entries(x).map(([k, y]) => `${label(k)} ${typeof y === "object" && y ? Object.entries(y).map(([a, b]) => `${a} ${b}`).join(" ") : y}`).join(" · ") : x)).join("; ") : Object.entries(v).map(([k, x]) => `${label(k)} ${Array.isArray(x) ? x.join(", ") : String(x)}`).join(" · ")) : String(v));
/** FO-147 — investment policy on the phone: read policies and compliance, complete the questionnaire, sign / activate a version with biometrics. */
export function PolicyPanel() {
  const list = useApi<any[]>("/policies");
  const [openId, setOpenId] = useState<string | null>(null); const [quiz, setQuiz] = useState(false);
  if (quiz) return <Questionnaire onDone={() => { setQuiz(false); list.refetch(); }} />;
  if (openId) return <PolicyDetail id={openId} onBack={() => { setOpenId(null); list.refetch(); }} />;
  if (!list.data) return <Status loading={list.loading} error={list.error} />;
  return (
    <Card title="Investment policy">
      {list.data.map((p) => <Pressable key={p.id} style={s.line} onPress={() => setOpenId(p.id)}>
        <View style={s.between}><Text style={[s.body, { fontWeight: "600", flex: 1 }]}>{p.name}</Text><Pill tone={tone(p.compliance?.overall)}>{p.compliance?.overall ?? "—"}</Pill></View>
        <Text style={s.mute}>{p.scope}{p.current_version ? ` · v${p.current_version.version} · ${label(p.current_version.risk?.profile ?? "")}` : " · no active version"}{p.open_draft ? ` · draft v${p.open_draft.version} ${label(p.open_draft.status)}` : ""}{p.open_reviews ? ` · ${p.open_reviews} review${p.open_reviews > 1 ? "s" : ""} open` : ""}</Text>
      </Pressable>)}
      <View style={{ marginTop: 10 }}><Btn title="Answer the risk questionnaire" onPress={() => setQuiz(true)} /></View>
    </Card>
  );
}
function PolicyDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const d = useApi<any>(`/policies/${id}`); const comp = useApi<any>(`/policies/${id}/compliance`); const [busy, setBusy] = useState(false);
  const role = session.get()?.families.find((f) => f.id === session.family())?.role ?? session.get()?.families[0]?.role;
  const stepUp = async (prompt: string) => { const r = await LocalAuthentication.authenticateAsync({ promptMessage: prompt }).catch(() => ({ success: true })); return "success" in r && r.success; };
  const sign = async (vid: string) => { if (!(await stepUp("Sign this policy version"))) return; setBusy(true); try { await api(`/policy-versions/${vid}/sign`, { method: "POST", body: JSON.stringify({ auth_method: "biometric", auth_proof: "000000" }) }); d.refetch(); Alert.alert("Signed", "Your signature is on the version."); } catch (e: any) { Alert.alert("Not allowed", e.message); } finally { setBusy(false); } };
  const activate = async (vid: string) => { if (!(await stepUp("Approve and activate this policy"))) return; setBusy(true); try { const r = await api<any>(`/policy-versions/${vid}/status`, { method: "POST", body: JSON.stringify({ status: "active", auth_method: "biometric", auth_proof: "000000" }) }); d.refetch(); comp.refetch(); Alert.alert("Activated", `Effective ${fmtDate(r.effective_from)} · next review ${fmtDate(r.next_review_on)}`); } catch (e: any) { Alert.alert("Not allowed", e.message); } finally { setBusy(false); } };
  if (!d.data) return <Status loading={d.loading} error={d.error} />;
  const p = d.data; const items: any[] = (p.effective?.items ?? []).filter((i: any) => !/_id$/.test(i.key)); const draft = p.open_draft ? p.versions.find((v: any) => v.id === p.open_draft.id) : null; const c = comp.data;
  return (<>
    <View style={s.row}><Btn title="‹ Policies" onPress={onBack} />{c && <Pill tone={tone(c.overall)}>{c.overall}</Pill>}</View>
    <Card>
      <Text style={s.big}>{p.name}</Text>
      <Text style={s.mute}>{p.scope}{p.parent_name ? ` · inherits ${p.parent_name}` : ""}{p.current_version ? ` · v${p.current_version.version} effective ${fmtDate(p.current_version.effective_from)}` : ""} · next review {fmtDate(p.next_review_on)}</Text>
      {p.current_version?.signed_by?.length ? <Text style={[s.mute, { marginTop: 4 }]}>Signed: {p.current_version.signed_by.map((x: any) => x.name).join(", ")}</Text> : null}
    </Card>
    {draft && <Card title={`Draft v${draft.version} · ${label(draft.status)}`}>
      <Text style={s.mute}>{draft.change_summary ?? ""}</Text>
      <Text style={[s.mute, { marginTop: 4 }]}>Signatures: {(draft.signed_by ?? []).map((x: any) => x.name).join(", ") || "none yet"}</Text>
      <View style={[s.row, { marginTop: 8, flexWrap: "wrap" }]}>
        {["owner", "member"].includes(role ?? "") && <Btn title="Sign" onPress={() => sign(draft.id)} />}
        {role === "owner" && draft.status === "in_review" && <Btn primary title="Approve & activate" onPress={() => activate(draft.id)} />}
      </View>
      {role !== "owner" && <Text style={[s.mute, { marginTop: 6 }]}>Only an owner can activate; activation writes targets, bands, rules and guardrails.</Text>}
    </Card>}
    {c && <Card title={`Compliance · ${fmtDate(c.as_of)}`}>
      {c.checks.filter((x: any) => x.status !== "n/a").map((x: any, i: number) => <View key={i} style={s.line}><View style={s.between}><Text style={[s.body, { flex: 1 }]}>{label(x.kind)} · {label(x.key)}</Text><Pill tone={tone(x.status)}>{label(x.status)}</Pill></View><Text style={s.mute}>{x.actual} vs {x.target}{x.detail ? ` · ${x.detail}` : ""}</Text></View>)}
      <Text style={[s.mute, { marginTop: 6 }]}>{c.breaches} breach · {c.warnings} warning</Text>
    </Card>}
    <Card title="Effective clauses">
      {items.map((i, k) => <View key={k} style={s.line}><View style={s.between}><Text style={[s.mute, { flex: 1 }]}>{label(i.section)} · {label(i.key)}</Text>{i.inherited ? <Pill>inherited</Pill> : <Pill tone="blue">{p.parent_name ? "override" : "family"}</Pill>}</View><Text style={s.body}>{val(i.value)}</Text></View>)}
    </Card>
    {busy && <Text style={s.mute}>Working…</Text>}
  </>);
}
function Questionnaire({ onDone }: { onDone: () => void }) {
  const qs = useApi<any[]>("/risk-questionnaires"); const q = qs.data?.find((x) => x.system) ?? qs.data?.[0];
  const [answers, setAnswers] = useState<Record<string, string>>({}); const [res, setRes] = useState<any | null>(null);
  const submit = async () => { try { setRes(await api(`/risk-questionnaires/${q.id}/respond`, { method: "POST", body: JSON.stringify({ answers }) })); } catch (e: any) { Alert.alert("Failed", e.message); } };
  if (!q) return <Status loading={qs.loading} error={qs.error} />;
  if (res) return <Card title="Your risk profile">
    <Text style={s.hero}>{Math.round(res.score)}</Text><Pill tone="amber">{label(res.profile)}</Pill>
    <Text style={[s.mute, { marginTop: 6 }]}>Capacity {Math.round(res.capacity_score)} · tolerance {Math.round(res.tolerance_score)} · horizon {Math.round(res.horizon_score)} · knowledge {Math.round(res.knowledge_score)}. {res.notes.join("; ")}</Text>
    <Text style={[s.body, { marginTop: 6 }]}>Suggested: {Object.entries(res.suggested_model.mix).map(([k, v]) => `${k} ${v}%`).join(" / ")} · drawdown limit {res.suggested_max_drawdown_pct}% · {res.suggested_liquidity_months} months liquidity. The builder on the web pre-fills a draft from this response.</Text>
    <View style={{ marginTop: 10 }}><Btn primary title="Done" onPress={onDone} /></View>
  </Card>;
  return <Card title={q.name}>
    {q.questions.map((qu: any) => <View key={qu.id} style={s.line}><Text style={s.mute}>{qu.dimension}</Text><Text style={s.body}>{qu.text}</Text><View style={[s.row, { flexWrap: "wrap", marginTop: 6 }]}>{qu.options.map((o: any) => <Btn key={o.label} title={o.label} primary={answers[qu.id] === o.label} onPress={() => setAnswers({ ...answers, [qu.id]: o.label })} />)}</View></View>)}
    <View style={[s.row, { marginTop: 10 }]}><Btn title="Cancel" onPress={onDone} />{Object.keys(answers).length >= q.questions.length && <Btn primary title="Score" onPress={submit} />}</View>
  </Card>;
}
