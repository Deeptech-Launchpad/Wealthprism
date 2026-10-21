import React, { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { api, session } from "../lib/api";
import { Screen, Card, Btn, s } from "../ui";
import { ImportPanel } from "./Import";
import { PolicyPanel } from "./Policy";
import { RebalancePanel } from "./Rebalance";
import { BooksPanel } from "./Books";
import { ResearchPanel } from "./Research";
import { ReportsPanel, DocumentsPanel } from "./Reports";
import { BalancePanel } from "./BalanceSheet";
import { BankingPanel } from "./Banking";
import { GoalsPanel } from "./Goals";

function NotificationPrefs() {
  const [p, setP] = useState<any | null>(null);
  useEffect(() => { api<any>("/notification-preferences").then(setP).catch(() => {}); }, []);
  const save = (patch: any) => api<any>("/notification-preferences", { method: "PUT", body: JSON.stringify(patch) }).then(setP).catch(() => {});
  if (!p) return null;
  return (
    <Card title="Notifications">
      <Text style={s.mute}>Push me for tasks at severity</Text>
      <View style={[s.row, { marginTop: 6 }]}>{[1, 2, 3].map((n) => <Btn key={n} title={n === 1 ? "1 · urgent only" : n === 2 ? "≤ 2" : "all"} primary={p.push_min_severity === n} onPress={() => save({ push_min_severity: n })} />)}</View>
      <Text style={[s.mute, { marginTop: 10 }]}>E-mail digest</Text>
      <View style={[s.row, { marginTop: 6 }]}>{["off", "daily", "weekly"].map((c) => <Btn key={c} title={c} primary={p.email_digest === c} onPress={() => save({ email_digest: c })} />)}</View>
    </Card>
  );
}
export function MoreScreen({ onSignOut }: { onSignOut: () => void }) {
  const u = session.get()!;
  return (
    <Screen>
      <Card title="Account"><Text style={s.body}>{u.user.name}</Text><Text style={s.mute}>{u.user.email}</Text><View style={{ marginTop: 10 }}><Btn title="Sign out" onPress={() => session.set(null).then(onSignOut)} /></View></Card>
      <BalancePanel />
      <BankingPanel />
      <GoalsPanel />
      <ReportsPanel />
      <DocumentsPanel />
      <ResearchPanel />
      <RebalancePanel />
      <PolicyPanel />
      <BooksPanel />
      <NotificationPrefs />
      <ImportPanel />
      <Card title="Family">{u.families.map((f) => <View key={f.id} style={[s.between, s.line]}><Text style={s.body}>{f.name}</Text><Text style={s.mute}>{f.role}{session.family() === f.id ? " · active" : ""}</Text></View>)}</Card>
    </Screen>
  );
}
