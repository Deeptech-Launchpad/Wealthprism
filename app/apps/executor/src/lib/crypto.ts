import { decryptSecret } from "@fo/connectors";
import type pg from "pg";
const KEY = process.env.FIELD_ENCRYPTION_KEY ?? "dev-only-field-key";
if (!process.env.FIELD_ENCRYPTION_KEY && process.env.NODE_ENV === "production") console.error("FIELD_ENCRYPTION_KEY is not set — credentials cannot be read");
// Vault-backed credentials (FO-124): the counterpart to apps/api/src/lib/connectors.ts's secretEncrypt — Vault's own
// ciphertext is self-describing ("vault:v1:…"), so this reads either format without a backend flag of its own.
const vaultAddr = () => process.env.VAULT_ADDR ?? "http://127.0.0.1:8200";
const vaultToken = () => process.env.VAULT_TOKEN ?? "";
const vaultTransitKey = () => process.env.VAULT_TRANSIT_KEY ?? "wealthprism-connector-credentials";
async function secretDecrypt(blob: string): Promise<string> {
  if (!blob.startsWith("vault:")) return decryptSecret(blob, KEY);
  const r = await fetch(`${vaultAddr()}/v1/transit/decrypt/${vaultTransitKey()}`, { method: "POST", headers: { "X-Vault-Token": vaultToken(), "content-type": "application/json" }, body: JSON.stringify({ ciphertext: blob }) });
  if (!r.ok) throw new Error(`Vault decrypt failed (HTTP ${r.status}): ${await r.text()}`);
  const j: any = await r.json(); return Buffer.from(j.data.plaintext, "base64").toString("utf8");
}
/** Only the executor holds the select grant on connector_credentials.ciphertext. */
export async function credentialsFor(c: pg.PoolClient, connectorId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of (await c.query("select name, ciphertext from connector_credentials where connector_id=$1", [connectorId])).rows) { try { out[r.name] = await secretDecrypt(r.ciphertext); } catch { out[r.name] = ""; } }
  return out;
}
export const fieldKey = () => KEY;
