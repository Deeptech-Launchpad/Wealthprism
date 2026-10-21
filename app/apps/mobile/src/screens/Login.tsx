import React, { useState } from "react";
import { View, Text, TextInput, KeyboardAvoidingView, Platform } from "react-native";
import { login } from "../lib/api";
import { s, C, Btn } from "../ui";
export function LoginScreen({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("arjun@example.com"); const [pw, setPw] = useState("Prototype!2026"); const [err, setErr] = useState("");
  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: C.navy, justifyContent: "center", padding: 24 }}>
      <View style={[s.card, { gap: 10 }]}>
        <Text style={[s.h3, { fontSize: 18 }]}>Family Office</Text>
        <TextInput style={s.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="Email" />
        <TextInput style={s.input} value={pw} onChangeText={setPw} secureTextEntry placeholder="Password" />
        {err ? <Text style={{ color: C.red, fontSize: 12 }}>{err}</Text> : null}
        <Btn primary title="Sign in" onPress={async () => { try { await login(email, pw); onDone(); } catch (e: any) { setErr(e.message); } }} />
      </View>
    </KeyboardAvoidingView>
  );
}
