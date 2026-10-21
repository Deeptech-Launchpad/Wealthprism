import React from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl, Pressable } from "react-native";
export const C = { navy: "#12213A", ink: "#1B2A41", paper: "#F5F6F8", line: "#E3E6EB", mute: "#6B7686", teal: "#0E7C6B", tealSoft: "#E3F3EF", amber: "#B7791F", amberSoft: "#FBF1DF", red: "#B93B31", redSoft: "#F9E6E4", blue: "#2F5D9C", blueSoft: "#E6EDF7", violet: "#6B4FA0" };
export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.paper }, content: { padding: 14, gap: 12 },
  card: { backgroundColor: "#fff", borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 14 },
  h3: { fontSize: 14, fontWeight: "600", color: C.ink, marginBottom: 8 }, mute: { color: C.mute, fontSize: 12 }, body: { color: C.ink, fontSize: 13.5 },
  hero: { fontSize: 30, fontWeight: "700", color: C.ink, marginVertical: 4 }, big: { fontSize: 20, fontWeight: "600", color: C.ink },
  row: { flexDirection: "row", alignItems: "center", gap: 8 }, between: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  line: { borderBottomWidth: 1, borderBottomColor: "#EFF1F4", paddingVertical: 9 }, num: { fontVariant: ["tabular-nums"], color: C.ink },
  btn: { borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingVertical: 7, paddingHorizontal: 12, backgroundColor: "#fff" }, btnP: { backgroundColor: C.navy, borderColor: C.navy },
  btnT: { color: C.ink, fontSize: 13 }, btnTP: { color: "#fff" }, pill: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: 20, backgroundColor: "#EEF0F3" }, pillT: { fontSize: 11.5, color: C.mute, fontWeight: "500" },
  input: { borderWidth: 1, borderColor: C.line, borderRadius: 6, padding: 10, backgroundColor: "#fff", color: C.ink },
});
export const Card = ({ title, children }: { title?: string; children: React.ReactNode }) => <View style={s.card}>{title ? <Text style={s.h3}>{title}</Text> : null}{children}</View>;
export const Pill = ({ tone, children }: { tone?: "teal" | "amber" | "red" | "blue"; children: React.ReactNode }) => {
  const bg = tone === "teal" ? C.tealSoft : tone === "amber" ? C.amberSoft : tone === "red" ? C.redSoft : tone === "blue" ? C.blueSoft : "#EEF0F3";
  const fg = tone === "teal" ? C.teal : tone === "amber" ? C.amber : tone === "red" ? C.red : tone === "blue" ? C.blue : C.mute;
  return <View style={[s.pill, { backgroundColor: bg }]}><Text style={[s.pillT, { color: fg }]}>{children}</Text></View>;
};
export const Btn = ({ title, onPress, primary }: { title: string; onPress: () => void; primary?: boolean }) => <Pressable onPress={onPress} style={[s.btn, primary && s.btnP]}><Text style={[s.btnT, primary && s.btnTP]}>{title}</Text></Pressable>;
export const Screen = ({ children, refreshing, onRefresh }: { children: React.ReactNode; refreshing?: boolean; onRefresh?: () => void }) => (
  <ScrollView style={s.screen} contentContainerStyle={s.content} refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}>{children}</ScrollView>
);
export const Status = ({ loading, error }: { loading: boolean; error: string | null }) => <Card><Text style={s.mute}>{loading ? "Loading…" : error}</Text></Card>;
