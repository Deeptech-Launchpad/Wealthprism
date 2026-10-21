import React, { useEffect, useState } from "react";
import { View, Text, Linking } from "react-native";
import { api, API_URL } from "../lib/api";
import { Card, Btn, Pill, s } from "../ui";

const abs = (u: string) => (u.startsWith("http") ? u : API_URL.replace(/\/api\/v1$/, "") + u);
const when = (d?: string | null) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "");
/** Reports on the phone: the latest generated reports and packs, open the PDF, generate the net worth statement now. */
export function ReportsPanel() {
  const [jobs, setJobs] = useState<any[]>([]); const [packs, setPacks] = useState<any[]>([]); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState("");
  const load = () => { api<any[]>("/reports/jobs?limit=6").then(setJobs).catch(() => {}); api<any[]>("/report-packs").then(setPacks).catch(() => {}); };
  useEffect(load, []);
  const run = async (code: string) => { setBusy(true); setMsg(""); try { const r = await api<any>(`/reports/${code}/run`, { method: "POST", body: JSON.stringify({ format: "pdf" }) }); setMsg(`${r.name} ready`); load(); if (r.url) Linking.openURL(abs(r.url)); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); } };
  return (
    <Card title="Reports">
      <View style={s.row}><Btn title={busy ? "Generating…" : "Net worth PDF"} primary onPress={() => !busy && run("net_worth")} /><Btn title="Capital gains" onPress={() => !busy && run("capital_gains")} /><Btn title="Performance" onPress={() => !busy && run("performance")} /></View>
      {msg ? <Text style={[s.mute, { marginTop: 6 }]}>{msg}</Text> : null}
      {jobs.map((j) => <View key={j.id} style={[s.between, s.line]}><View style={{ flex: 1 }}><Text style={s.body}>{j.report_code.replace(/_/g, " ")} · {j.format}</Text><Text style={s.mute}>{when(j.created_at)}{j.error ? ` · ${j.error}` : ""}</Text></View>{j.url ? <Btn title="Open" onPress={() => Linking.openURL(abs(j.url))} /> : <Pill tone={j.status === "failed" ? "red" : "amber"}>{j.status}</Pill>}</View>)}
      {packs.filter((p) => p.runs?.length).map((p) => <View key={p.id} style={[s.between, s.line]}><View style={{ flex: 1 }}><Text style={s.body}>{p.name} · v{p.runs[0].version}</Text><Text style={s.mute}>{p.audience} pack · {p.runs[0].period_label} · {p.runs[0].page_count ?? "—"} pages</Text></View>{p.runs[0].url ? <Btn title="Open" onPress={() => Linking.openURL(abs(p.runs[0].url))} /> : null}</View>)}
      {!jobs.length && !packs.some((p) => p.runs?.length) ? <Text style={s.mute}>No reports generated yet.</Text> : null}
    </Card>
  );
}
/** Documents: the newest files in the library and the extraction queue count; opens through the signed link. */
export function DocumentsPanel() {
  const [docs, setDocs] = useState<any[]>([]); const [queue, setQueue] = useState(0);
  useEffect(() => { api<any[]>("/documents?limit=8").then(setDocs).catch(() => {}); api<any[]>("/documents/extractions").then((x) => setQueue(x.filter((e) => ["needs_review", "extracted"].includes(e.status)).length)).catch(() => {}); }, []);
  const open = async (id: string) => { try { const d = await api<any>(`/documents/${id}`); if (d.url) Linking.openURL(abs(d.url)); } catch { /* signed link unavailable */ } };
  return (
    <Card title="Documents">
      {queue ? <Text style={[s.mute, { marginBottom: 6 }]}>{queue} extraction{queue > 1 ? "s" : ""} awaiting review on the web app</Text> : null}
      {docs.map((d) => <View key={d.id} style={[s.between, s.line]}><View style={{ flex: 1 }}><Text style={s.body} numberOfLines={1}>{d.name}</Text><Text style={s.mute}>{d.folder_name ?? d.source}{d.entity_name ? ` · ${d.entity_name}` : ""} · {when(d.created_at)}</Text></View><Btn title="Open" onPress={() => open(d.id)} /></View>)}
      {!docs.length ? <Text style={s.mute}>Nothing in the library yet.</Text> : null}
    </Card>
  );
}
