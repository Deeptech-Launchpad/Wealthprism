import React, { useState } from "react";
import { View, Text, TextInput, Alert } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import { useApi } from "../lib/useApi";
import { api } from "../lib/api";
import { Card, Pill, Btn, s } from "../ui";

interface JobResult { id: string; status: string; rows_total?: number; rows_ok?: number; rows_error?: number; duplicate_of_previous_upload?: boolean; detected_headers?: string[]; log?: any[] }

/** Pick a CAS text, tradebook / contract-note CSV, bank CSV, AA JSON or Form 26AS from Files (or share it to
 *  Files first) and send it as text. Unknown contract-note layouts need the mapping assistant on the web app. */
export function ImportPanel() {
  const banks = useApi<any[]>("/bank-accounts");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [pasted, setPasted] = useState("");
  const [bank, setBank] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<JobResult | null>(null);

  const pick = async () => {
    const r = await DocumentPicker.getDocumentAsync({ type: ["text/*", "application/json", "text/csv", "text/comma-separated-values"], copyToCacheDirectory: true });
    if (r.canceled || !r.assets[0]) return;
    const a = r.assets[0];
    if ((a.size ?? 0) > 25 * 1024 * 1024) { Alert.alert("Too large", "Files up to 25 MB are accepted."); return; }
    const text = await FileSystem.readAsStringAsync(a.uri, { encoding: FileSystem.EncodingType.UTF8 });
    setFile({ name: a.name, text }); setResult(null);
  };
  const isBank = (t: string) => /Withdrawal|Deposit|Debit|Credit|maskedAccNumber|Closing Balance/i.test(t.slice(0, 2000)) && !/Consolidated Account Statement|Form 26AS|trade_id/i.test(t.slice(0, 2000));
  const text = file?.text ?? pasted;
  const needsBank = !!text && isBank(text);

  const send = async () => {
    if (!text.trim()) return;
    if (needsBank && !bank) { Alert.alert("Choose the bank account", "Bank statements need the account they belong to."); return; }
    setBusy(true);
    try {
      const body: any = { text, ...(needsBank && bank ? { bank_account_id: bank } : {}) };
      const r = await api<JobResult>("/imports", { method: "POST", body: JSON.stringify(body) });
      setResult(r);
      if (r.status === "needs_mapping") Alert.alert("Unknown layout", "This broker's layout has not been mapped yet. Map it once on the web app; after that it imports here too.");
    } catch (e: any) { Alert.alert("Import failed", e.message); } finally { setBusy(false); }
  };

  return (
    <Card title="Import a statement">
      <Text style={s.mute}>CAMS / KFintech CAS text, Zerodha tradebook, bank CSV, Account Aggregator JSON or Form 26AS. Share the file to Files first, then pick it here.</Text>
      <View style={[s.row, { marginTop: 10 }]}><Btn title={file ? `Picked: ${file.name}` : "Pick a file"} onPress={pick} />{file && <Btn title="Clear" onPress={() => { setFile(null); setResult(null); }} />}</View>
      {!file && <TextInput style={[s.input, { marginTop: 10, minHeight: 80 }]} multiline placeholder="…or paste the statement text here" placeholderTextColor="#9AA3B2" value={pasted} onChangeText={(v) => { setPasted(v); setResult(null); }} />}
      {needsBank && (
        <View style={{ marginTop: 10, gap: 6 }}>
          <Text style={s.mute}>Bank account</Text>
          <View style={[s.row, { flexWrap: "wrap" }]}>{(banks.data ?? []).map((b) => <Btn key={b.id} title={`${b.bank} ${b.account_masked}`} primary={bank === b.id} onPress={() => setBank(b.id)} />)}</View>
        </View>
      )}
      <View style={{ marginTop: 10 }}><Btn title={busy ? "Importing…" : "Import"} primary onPress={busy ? () => {} : send} /></View>
      {result && (
        <View style={[s.row, { marginTop: 10, flexWrap: "wrap" }]}>
          <Pill tone={result.status === "done" ? "teal" : result.status === "failed" ? "red" : "amber"}>{result.duplicate_of_previous_upload ? "already imported" : result.status.replace("_", " ")}</Pill>
          <Text style={s.mute}>{result.duplicate_of_previous_upload ? "This exact file was imported before." : `${result.rows_ok ?? 0} of ${result.rows_total ?? 0} rows applied${result.rows_error ? `, ${result.rows_error} errors` : ""}`}</Text>
        </View>
      )}
    </Card>
  );
}
