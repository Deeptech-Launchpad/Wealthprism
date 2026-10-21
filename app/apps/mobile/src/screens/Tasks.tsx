import React, { useState } from "react";
import { View, Text, Alert } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { useApi } from "../lib/useApi";
import { api, inr, fmtDate } from "../lib/api";
import { Screen, Card, Pill, Btn, Status, s } from "../ui";
export function TasksScreen() {
  const { data, error, loading, refetch } = useApi<any[]>("/tasks?status=open");
  const [busy, setBusy] = useState(false);
  /** Step-up: biometric confirmation before completing a task (same pattern the action plane will use for approvals). */
  const done = async (id: string) => {
    const has = await LocalAuthentication.hasHardwareAsync();
    if (has) { const r = await LocalAuthentication.authenticateAsync({ promptMessage: "Confirm" }); if (!r.success) return; }
    setBusy(true); try { await api(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) }); refetch(); } catch (e: any) { Alert.alert("Could not update", e.message); } finally { setBusy(false); }
  };
  if (!data) return <Screen><Status loading={loading} error={error} /></Screen>;
  return (
    <Screen refreshing={loading || busy} onRefresh={refetch}>
      <Card title={`${data.length} open`}>{data.map((t) => <View key={t.id} style={s.line}><View style={s.row}><Pill tone={t.severity === 1 ? "red" : t.severity === 2 ? "amber" : undefined}>{t.module}</Pill><Text style={s.mute}>{t.entity_name ?? "All"} · due {fmtDate(t.due_date)}{t.amount ? ` · ${inr(t.amount)}` : ""}</Text></View><Text style={[s.body, { marginVertical: 6 }]}>{t.title}</Text><View style={s.row}><Btn title="Done" onPress={() => done(t.id)} /><Btn title="Dismiss" onPress={() => api(`/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({ status: "dismissed" }) }).then(refetch)} /></View></View>)}</Card>
    </Screen>
  );
}
