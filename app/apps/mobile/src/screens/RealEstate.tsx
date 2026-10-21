import React from "react";
import { View, Text, Alert } from "react-native";
import { useApi } from "../lib/useApi";
import { api, inr, fmtDate } from "../lib/api";
import { Screen, Card, Pill, Btn, Status, s } from "../ui";
const month = new Date().toISOString().slice(0, 7);
export function RealEstateScreen() {
  const p = useApi<any[]>("/properties"); const r = useApi<any[]>(`/rent-schedule?month=${month}`);
  if (!p.data) return <Screen><Status loading={p.loading} error={p.error} /></Screen>;
  return (
    <Screen refreshing={p.loading} onRefresh={() => { p.refetch(); r.refetch(); }}>
      <Card title="Properties">{p.data.map((x) => <View key={x.id} style={s.line}><View style={s.between}><Text style={[s.body, { fontWeight: "600", flex: 1 }]} numberOfLines={1}>{x.name}</Text><Text style={s.num}>{inr(x.current_value)}</Text></View><View style={[s.between, { marginTop: 4 }]}><Text style={s.mute}>{x.active_lease ? `${x.active_lease.tenant} · ${inr(x.active_lease.rent)}/mo` : "vacant"}</Text>{x.active_lease?.gst_applicable ? <Pill tone="blue">GST</Pill> : null}</View></View>)}</Card>
      <Card title={`Rent — ${month}`}>{(r.data ?? []).map((x) => <View key={x.id} style={s.line}>
        <View style={s.between}><View style={{ flex: 1 }}><Text style={s.body}>{x.property}</Text><Text style={s.mute}>{x.tenant} · due {fmtDate(x.due_date)} · {inr(x.net_due ?? x.expected_rent)}</Text></View><Pill tone={x.status === "received" ? "teal" : x.status === "overdue" ? "red" : "amber"}>{x.status}{x.status === "overdue" ? ` ${x.overdue_days} d` : ""}</Pill></View>
        {!["received", "waived"].includes(x.status) && <View style={[s.row, { marginTop: 6 }]}>
          <Btn title="Received" onPress={() => Alert.alert("Record rent", `Mark ${inr(x.net_due ?? x.expected_rent)} from ${x.tenant} as received today?`, [{ text: "Cancel" }, { text: "Yes", onPress: () => api(`/rent-schedule/${x.id}/receive`, { method: "POST", body: JSON.stringify({ amount: Number(x.net_due ?? x.expected_rent) - Number(x.received_amount) }) }).then(() => r.refetch()).catch((e) => Alert.alert("Failed", e.message)) }])} />
          {x.status !== "due" && <Btn title="Remind" onPress={() => api<any>(`/rent-schedule/${x.id}/remind`, { method: "POST", body: JSON.stringify({ channel: "whatsapp" }) }).then((q) => Alert.alert("Reminder queued", `${q.to}\n\n${q.message}`)).catch((e) => Alert.alert("Failed", e.message))} />}
        </View>}
      </View>)}</Card>
    </Screen>
  );
}
