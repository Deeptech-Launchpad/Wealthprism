import React, { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { api } from "../lib/api";
import { Card, Btn, Pill, s } from "../ui";

const inr = (v: any) => { const n = Number(v ?? 0); return Math.abs(n) >= 1e5 ? `₹${(n / 1e5).toFixed(2)} L` : `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`; };
const when = (d?: string | null) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "");
/** Banking on the phone: accounts with their sync state and a one-tap AA sync, the 30-day cash flow, and quarantined e-mails to release. */
export function BankingPanel() {
  const [accts, setAccts] = useState<any[]>([]); const [cf, setCf] = useState<any>(null); const [mails, setMails] = useState<any[]>([]); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState("");
  const load = () => { api<any[]>("/bank-accounts").then(setAccts).catch(() => {}); api<any>("/cashflow?days=30").then(setCf).catch(() => {}); api<any[]>("/ingest/email?status=quarantined").then(setMails).catch(() => {}); };
  useEffect(load, []);
  const sync = async (a: any) => { setBusy(a.id); setMsg(""); try { const r = await api<any>(`/bank-accounts/${a.id}/sync`, { method: "POST", body: "{}" }); setMsg(`${a.bank}: ${r.txns_new} new, ${r.txns_dup} known`); load(); } catch (e: any) { setMsg(e.message); } finally { setBusy(""); } };
  const release = async (m: any) => { setBusy(m.id); try { await api(`/ingest/email/${m.id}/release`, { method: "POST", body: JSON.stringify({ allow_sender: true }) }); setMsg(`Released ${m.sender}`); load(); } catch (e: any) { setMsg(e.message); } finally { setBusy(""); } };
  return (
    <Card title="Banking">
      {cf ? <View style={s.between}><View><Text style={s.mute}>30-day inflows</Text><Text style={s.body}>{inr(cf.inflows)}</Text></View><View><Text style={s.mute}>Outflows</Text><Text style={[s.body, { color: "#B93B31" }]}>{inr(cf.outflows)}</Text></View><View><Text style={s.mute}>Net</Text><Text style={s.big}>{inr(cf.net)}</Text></View></View> : <Text style={s.mute}>Loading…</Text>}
      {msg ? <Text style={[s.mute, { marginTop: 6 }]}>{msg}</Text> : null}
      {accts.map((a) => <View key={a.id} style={[s.between, s.line]}><View style={{ flex: 1 }}><Text style={s.body}>{a.bank} {a.account_masked} · {inr(a.balance)}</Text><Text style={s.mute}>{a.entity_name} · {a.sync_mode === "aa" ? `AA to ${when(a.consent_expires_on)}` : a.sync_mode}</Text></View>{a.sync_mode === "aa" ? <Btn title={busy === a.id ? "…" : "Sync"} onPress={() => !busy && sync(a)} /> : null}</View>)}
      {mails.map((m) => <View key={m.id} style={[s.between, s.line]}><View style={{ flex: 1 }}><Text style={s.body}>{m.subject ?? "(no subject)"}</Text><Text style={s.mute}>from {m.sender} · held</Text></View><View style={s.row}><Pill tone="amber">quarantined</Pill><Btn title="Release" onPress={() => !busy && release(m)} /></View></View>)}
    </Card>
  );
}
