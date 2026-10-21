import React from "react";
import { View, Text } from "react-native";
import { useApi } from "../lib/useApi";
import { inr } from "../lib/api";
import { Screen, Card, Pill, Status, s, C } from "../ui";
export function HoldingsScreen() {
  const { data, error, loading, refetch } = useApi<any>("/holdings");
  if (!data) return <Screen><Status loading={loading} error={error} /></Screen>;
  return (
    <Screen refreshing={loading} onRefresh={refetch}>
      <Card><View style={s.between}><Text style={s.mute}>Total value</Text><Text style={s.big}>{inr(data.totals.value)}</Text></View><View style={s.between}><Text style={s.mute}>Cost</Text><Text style={s.num}>{inr(data.totals.cost)}</Text></View></Card>
      <Card title="Holdings">{data.items.map((h: any) => (
        <View key={h.id} style={s.line}>
          <View style={s.between}><Text style={[s.body, { fontWeight: "600", flex: 1 }]} numberOfLines={1}>{h.instrument}</Text><Text style={s.num}>{inr(h.value)}</Text></View>
          <View style={[s.between, { marginTop: 4 }]}><Text style={s.mute}>{h.type} · {h.entity_name} · {Number(h.quantity).toLocaleString("en-IN")}</Text><View style={s.row}><Pill tone={h.bucket === "growth" ? "blue" : h.bucket === "income" ? "teal" : undefined}>{h.bucket}</Pill><Text style={{ color: Number(h.unrealised_gain) >= 0 ? C.teal : C.red, fontSize: 12 }}>{h.unrealised_gain_pct}%</Text>{h.xirr_pct != null && <Text style={s.mute}>XIRR {h.xirr_pct}%</Text>}</View></View>
        </View>))}</Card>
    </Screen>
  );
}
