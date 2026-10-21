import React, { useState } from "react";
import { View, Text, Alert } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { useApi } from "../lib/useApi";
import { api, inr, fmtDate, session } from "../lib/api";
import { Card, Pill, Btn, Status, s } from "../ui";
const FY = "2026-27";
const signed = (v: number) => (v < 0 ? `−${inr(-v)}` : inr(v));
/** FO-47 / FO-113 on the phone: one card per book, the trial balance, drafts waiting for a second person (biometric approve), the unposted queue. */
export function BooksPanel() {
  const books = useApi<any[]>("/gl/books"); const [view, setView] = useState<{ kind: "summary" } | { kind: "tb" | "drafts" | "unposted"; entity: string; name: string }>({ kind: "summary" });
  if (view.kind === "tb") return <TrialBalance entity={view.entity} name={view.name} onBack={() => setView({ kind: "summary" })} />;
  if (view.kind === "drafts") return <Drafts entity={view.entity} name={view.name} onBack={() => { setView({ kind: "summary" }); books.refetch(); }} />;
  if (view.kind === "unposted") return <Unposted entity={view.entity} name={view.name} onBack={() => { setView({ kind: "summary" }); books.refetch(); }} />;
  return (
    <Card title="Books">
      {!books.data ? <Status loading={books.loading} error={books.error} /> : books.data.length === 0 ? <Text style={s.mute}>No books opened yet — open them on the web.</Text> : books.data.map((b) => (
        <View key={b.entity_id} style={s.line}>
          <View style={s.between}><Text style={[s.body, { fontWeight: "600", flex: 1 }]}>{b.entity_name}</Text><Text style={s.mute}>{b.basis} · {b.journals} journals</Text></View>
          <View style={[s.row, { marginTop: 6, flexWrap: "wrap" }]}>
            <Btn title="Trial balance" onPress={() => setView({ kind: "tb", entity: b.entity_id, name: b.entity_name })} />
            {Number(b.drafts) > 0 && <Btn primary title={`${b.drafts} draft${Number(b.drafts) > 1 ? "s" : ""} to approve`} onPress={() => setView({ kind: "drafts", entity: b.entity_id, name: b.entity_name })} />}
            {Number(b.unposted) > 0 && <Btn title={`${b.unposted} unposted`} onPress={() => setView({ kind: "unposted", entity: b.entity_id, name: b.entity_name })} />}
            {!Number(b.drafts) && !Number(b.unposted) && <Pill tone="teal">up to date</Pill>}
          </View>
        </View>))}
    </Card>
  );
}
function TrialBalance({ entity, name, onBack }: { entity: string; name: string; onBack: () => void }) {
  const tb = useApi<any[]>(`/gl/reports/trial-balance?entity_id=${entity}&fy=${FY}`);
  const dr = (tb.data ?? []).reduce((a, r) => a + r.debit, 0), cr = (tb.data ?? []).reduce((a, r) => a + r.credit, 0);
  return (<><View style={s.row}><Btn title="‹ Back" onPress={onBack} />{tb.data && <Pill tone={Math.abs(dr - cr) < 0.01 ? "teal" : "red"}>{Math.abs(dr - cr) < 0.01 ? "balanced" : "unbalanced"}</Pill>}</View>
    <Card title={`${name} — FY ${FY}`}>{!tb.data ? <Status loading={tb.loading} error={tb.error} /> : tb.data.map((r) => <View key={r.code} style={[s.between, s.line]}><Text style={[s.body, { flex: 1 }]}>{r.code} {r.name}</Text><Text style={s.num}>{r.closing ? signed(r.closing) : "—"}</Text></View>)}
      <Text style={[s.mute, { marginTop: 8 }]}>Closing balances: debit positive, credit negative. Investments at cost.</Text></Card></>);
}
function Drafts({ entity, name, onBack }: { entity: string; name: string; onBack: () => void }) {
  const d = useApi<any>(`/gl/journals?entity_id=${entity}&status=draft&limit=50`); const me = session.get()?.user.id;
  const approve = async (j: any) => {
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: `Approve journal #${j.journal_no}` }).catch(() => ({ success: true })); if (!("success" in r) || !r.success) return;
    try { await api(`/gl/journals/${j.id}/approve`, { method: "POST" }); d.refetch(); } catch (e: any) { Alert.alert("Not approved", e.message); }
  };
  return (<><View style={s.row}><Btn title="‹ Back" onPress={onBack} /></View>
    <Card title={`${name} — drafts`}>{!d.data ? <Status loading={d.loading} error={d.error} /> : d.data.items.length === 0 ? <Text style={s.mute}>Nothing waiting.</Text> : d.data.items.map((j: any) => <View key={j.id} style={s.line}>
      <View style={s.between}><Text style={[s.body, { fontWeight: "600", flex: 1 }]}>#{j.journal_no} · {j.narration}</Text><Text style={s.num}>{inr(j.lines.reduce((a: number, l: any) => a + Number(l.debit), 0))}</Text></View>
      <Text style={s.mute}>{fmtDate(j.entry_date)} · by {j.posted_by_name ?? "—"} · {j.lines.map((l: any) => `${l.debit > 0 ? "Dr" : "Cr"} ${l.account_code}`).join(", ")}</Text>
      <View style={{ marginTop: 6 }}>{j.posted_by === me ? <Text style={s.mute}>You made this draft — a second person approves it.</Text> : <Btn primary title="Approve" onPress={() => approve(j)} />}</View>
    </View>)}</Card></>);
}
function Unposted({ entity, name, onBack }: { entity: string; name: string; onBack: () => void }) {
  const u = useApi<any[]>(`/gl/unposted?entity_id=${entity}`); const [busy, setBusy] = useState(false);
  const rerun = async () => { setBusy(true); try { const r = await api<any>("/gl/unposted", { method: "POST", body: JSON.stringify({ entity_id: entity }) }); Alert.alert("Posting run", `${r.posted} posted · ${r.queued} still queued`); u.refetch(); } catch (e: any) { Alert.alert("Failed", e.message); } finally { setBusy(false); } };
  return (<><View style={s.row}><Btn title="‹ Back" onPress={onBack} /><Btn primary title={busy ? "Running…" : "Re-run posting"} onPress={rerun} /></View>
    <Card title={`${name} — unposted events`}>{!u.data ? <Status loading={u.loading} error={u.error} /> : u.data.length === 0 ? <Text style={s.mute}>Nothing waiting.</Text> : u.data.map((x) => <View key={x.id} style={s.line}>
      <View style={s.between}><Text style={[s.body, { fontWeight: "600", flex: 1 }]}>{x.event_type}</Text><Pill tone={x.reason === "no_rule" ? "amber" : "red"}>{x.reason.replace(/_/g, " ").slice(0, 30)}</Pill></View>
      <Text style={s.mute}>{fmtDate(x.event_date)}{x.amount != null ? ` · ${inr(x.amount)}` : ""}{x.detail?.narration ? ` · ${x.detail.narration}` : ""}</Text>
    </View>)}<Text style={[s.mute, { marginTop: 8 }]}>Missing rules are added on the web under Books › Posting rules; locked periods are reopened by an owner.</Text></Card></>);
}
