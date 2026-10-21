export * from "./types.js";
export * from "./zerodha.js";
export * from "./genericMapped.js";
export * from "./cas.js";
export * from "./bank.js";
export * from "./form26as.js";
export * from "./pms.js";
export * from "./ecas.js";
import { parseZerodhaTradebook } from "./zerodha.js";
import { parseCasText } from "./cas.js";
import { parseBankCsv, parseAaDeposit } from "./bank.js";
import { parseForm26AS } from "./form26as.js";
import { parsePmsStatement, parseAifStatement, isPmsText, isAifText } from "./pms.js";
import { parseEcas, isEcasText } from "./ecas.js";
import { csv } from "./types.js";
/** Detects the source from content; returns the parser to use, or null when the mapping assistant is needed. */
export function detect(text: string): "zerodha" | "cas" | "bank_csv" | "form26as" | "aa" | "pms" | "aif" | "ecas" | null {
  const head = text.slice(0, 4000);
  if (/^\s*\{/.test(head) && /maskedAccNumber|"Transactions"/.test(head)) return "aa";
  if (isEcasText(head)) return "ecas";
  if (isAifText(head)) return "aif";
  if (isPmsText(head)) return "pms";
  if (/Consolidated Account Statement/i.test(head) || /Folio No:/.test(head)) return "cas";
  if (/Form 26AS/i.test(head)) return "form26as";
  const h = csv(head.split("\n").slice(0, 2).join("\n"))[0]?.map((x) => x.trim().toLowerCase()) ?? [];
  if (h.includes("trade_id") && h.includes("trade_type")) return "zerodha";
  if (parseBankCsv(head).provider !== "unknown") return "bank_csv";
  return null;
}
export function parseAny(text: string) {
  const kind = detect(text);
  switch (kind) {
    case "zerodha": return { kind, result: parseZerodhaTradebook(text) };
    case "cas": return { kind, result: parseCasText(text) };
    case "bank_csv": return { kind, result: parseBankCsv(text) };
    case "form26as": return { kind, result: parseForm26AS(text) };
    case "aa": return { kind, result: parseAaDeposit(JSON.parse(text)) };
    case "pms": return { kind, result: parsePmsStatement(text) };
    case "aif": return { kind, result: parseAifStatement(text) };
    case "ecas": return { kind, result: parseEcas(text) };
    default: return { kind: null, result: null };
  }
}
export * from "./feeds.js";
