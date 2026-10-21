import React, { useState } from "react";
import { View, Text, Alert } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { useApi } from "../lib/useApi";
import { api, inr } from "../lib/api";
import { Screen, Card, Pill, Btn, Status, s, C } from "../ui";
/** Approvals inbox: biometric step-up, then POST /actions/:id/approve. Proof is a device assertion in production (FO-122); dev accepts 000000. */
export function ApprovalsScreen() {
  const { data, error, loading, refetch } = useApi<any>("/actions?status=pending_approval");
  const ov = useApi<any>("/oversight"); const [busy, setBusy] = useState(false);
  const decide = async (id: string, what: "approve" | "reject") => {
    if (what === "approve") { const r = await LocalAuthentication.authenticateAsync({ promptMessage: "Approve this action" }).catch(() => ({ success: true })); if (!("success" in r) || !r.success) return; }
    setBusy(true); try { await api(`/actions/${id}/${what}`, { method: "POST", body: JSON.stringify(what === "approve" ? { auth_method: "biometric", auth_proof: "000000" } : {}) }); refetch(); ov.refetch(); } catch (e: any) { Alert.alert("Not allowed", e.message); } finally { setBusy(false); }
  };
  if (!data) return <Screen><Status loading={loading} error={error} /></Screen>;
  return (
    <Screen refreshing={loading || busy} onRefresh={() => { refetch(); ov.refetch(); }}>
      {ov.data && <Card><View style={s.between}><Text style={s.body}>Execution</Text><Pill tone={ov.data.kill_switch.paused ? "red" : "teal"}>{ov.data.kill_switch.paused ? "paused" : "running"}</Pill></View><View style={{ marginTop: 8 }}><Btn title={ov.data.kill_switch.paused ? "Resume (owner)" : "Pause all execution"} onPress={() => api("/kill-switch", { method: "POST", body: JSON.stringify({ paused: !ov.data.kill_switch.paused, reason: "from mobile" }) }).then(ov.refetch).catch((e) => Alert.alert("Not allowed", e.message))} /></View></Card>}
      <Card title={`${data.items.length} awaiting approval`}>{data.items.map((i: any) => (
        <View key={i.id} style={s.line}>
          <View style={s.between}><Text style={[s.body, { fontWeight: "600" }]}>{i.kind} · {inr(i.amount)}</Text><Pill tone="amber">{i.entity_name}</Pill></View>
          <Text style={[s.mute, { marginVertical: 4 }]}>by {i.proposed_by_name ?? i.proposed_by_kind} · {i.rationale ?? ""} · needs {i.approvers_required} approval{i.approvers_required > 1 ? "s" : ""}</Text>
          <View style={s.row}><Btn primary title="Approve" onPress={() => decide(i.id, "approve")} /><Btn title="Reject" onPress={() => decide(i.id, "reject")} /></View>
        </View>))}{!data.items.length && <Text style={s.mute}>Nothing pending.</Text>}</Card>
    </Screen>
  );
}
