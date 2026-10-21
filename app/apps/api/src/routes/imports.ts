import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import { requireFamily, requireRole } from "../lib/auth.js";
import { withFamily, money } from "../lib/db.js";
import { detect, parseAny, parseMappedContractNote, headerSignature, parseCasText, parseZerodhaTradebook, parseBankCsv, parseAaDeposit, parseForm26AS, type ParsedInvestmentTxn, type ParsedBankTxn } from "@fo/parsers";
import { consumeFifo, foreclosureCreditMatches } from "@fo/finance";
import { matchActuals } from "../jobs/planning.js";
import { matchMoves } from "../lib/rebalance.js";
import { syncOutflows } from "../lib/balance.js";
import { autopost } from "../lib/gl.js";
import { emitEvent } from "../lib/opendata.js";
import { applyPmsStatement, applyAifStatement, applyEcas } from "../lib/statements.js";

const MAX_BYTES = 25 * 1024 * 1024;
/** "ICICI Direct" and "icicidirect" are the same provider: compare on letters and digits only. $3 is the parser's provider. */
const SAME_PROVIDER = "regexp_replace(lower(provider), '[^a-z0-9]', '', 'g') = regexp_replace(lower($3), '[^a-z0-9]', '', 'g')";

/** Resolve or create an instrument by ISIN / AMFI code / symbol. */
async function resolveInstrument(c: any, ins: ParsedInvestmentTxn["instrument"]) {
  if ((ins as any).id) return (ins as any).id;   // hand-entered transactions name the instrument directly
  let r = ins.isin ? await c.query("select id from instruments where isin=$1", [ins.isin]) : { rows: [] };
  if (!r.rows[0] && ins.amfiCode) r = await c.query("select id from instruments where amfi_code=$1", [ins.amfiCode]);
  if (!r.rows[0] && ins.symbol) r = await c.query("select id from instruments where symbol=$1", [ins.symbol]);
  if (r.rows[0]) return r.rows[0].id;
  const type = ins.type === "mf" ? "mf" : ins.type === "bond" ? "bond" : ins.type === "etf" ? "etf" : "stock";
  const assetClass = type === "bond" ? "listed_bond" : "equity";
  const bucket = type === "bond" ? "income" : "growth";
  const ins2 = await c.query("insert into instruments (type, isin, symbol, name, amfi_code, exchange, default_bucket, asset_class) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
    [type, ins.isin ?? null, ins.symbol ?? null, ins.name, ins.amfiCode ?? null, ins.symbol ? "NSE" : null, bucket, assetClass]);
  return ins2.rows[0].id;
}
export async function resolveEntity(c: any, familyId: string, hint?: { pan?: string; name?: string }, fallback?: string) {
  if (hint?.pan) { const r = await c.query("select id from entities where pan_last4 = $1 and deleted_at is null", [hint.pan.slice(-4)]); if (r.rows[0]) return r.rows[0].id; }
  if (hint?.name) { const r = await c.query("select id from entities where upper(name) = upper($1) and deleted_at is null", [hint.name]); if (r.rows[0]) return r.rows[0].id; }
  return fallback ?? null;
}
/** Find the entity's account for this statement. Stored identifiers are masked (5566xxxx/33 with asterisks), so they are
 *  matched as patterns against the full folio / client id; tradebooks that carry no account number fall back
 *  to the entity's existing account at the same provider. Only then is a new account created. */
async function resolveAccount(c: any, familyId: string, entityId: string, a: ParsedInvestmentTxn["account"], provider: string) {
  const r = await c.query(`select id from accounts where entity_id=$1 and kind=$2 and deleted_at is null
      and (identifier_masked = $3 or regexp_replace($3, '\\s', '', 'g') ~ ('^' || regexp_replace(regexp_replace(identifier_masked, '\\s', '', 'g'), '\\*+', '.*', 'g') || '$'))
      order by created_at limit 1`, [entityId, a.kind, a.identifier]);
  if (r.rows[0]) return r.rows[0].id;
  if (!/\d/.test(a.identifier)) {
    const p = await c.query(`select id from accounts where entity_id=$1 and kind=$2 and ${SAME_PROVIDER} and deleted_at is null order by created_at limit 1`, [entityId, a.kind, provider]);
    if (p.rows[0]) return p.rows[0].id;
  }
  return (await c.query("insert into accounts (family_id, entity_id, kind, provider, identifier_masked) values ($1,$2,$3,$4,$5) returning id", [familyId, entityId, a.kind, provider, a.identifier])).rows[0].id;
}
/** Apply one investment transaction: insert txn (dedup by hash), then maintain holding + lots. */
export async function applyInvestmentTxn(c: any, familyId: string, entityId: string, t: ParsedInvestmentTxn, jobId: string | null) {
  const instrumentId = await resolveInstrument(c, t.instrument);
  const accountId = await resolveAccount(c, familyId, entityId, t.account, t.provider);
  const dup = await c.query("select 1 from investment_txns where family_id=$1 and hash=$2", [familyId, t.ref]);
  if (dup.rows[0]) return "dup";
  const kind = t.type === "sip" ? "sip" : t.type;
  const txnId = (await c.query("insert into investment_txns (family_id, entity_id, account_id, instrument_id, type, txn_date, quantity, price, amount, charges, source, source_ref, hash) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id",
    [familyId, entityId, accountId, instrumentId, kind, t.date, t.quantity, t.price, t.amount, t.charges, t.source, jobId, t.ref])).rows[0].id;
  const ins = await c.query("select default_bucket from instruments where id=$1", [instrumentId]);
  const h = await c.query(`insert into holdings (family_id, entity_id, account_id, instrument_id, quantity, avg_cost, bucket) values ($1,$2,$3,$4,0,0,$5)
     on conflict (entity_id, account_id, instrument_id) do update set updated_at = now() returning id, quantity, avg_cost`, [familyId, entityId, accountId, instrumentId, ins.rows[0].default_bucket]);
  const holdingId = h.rows[0].id;
  if (["buy", "sip", "switch_in"].includes(kind)) {
    // a lot entered by hand before the statement arrived is adopted, not duplicated
    const manual = await c.query("select id from lots where holding_id=$1 and buy_date=$2 and quantity=$3 and unit_cost=$4 and source_txn_id is null limit 1", [holdingId, t.date, t.quantity, t.price]);
    if (manual.rows[0]) await c.query("update lots set source_txn_id=$2 where id=$1", [manual.rows[0].id, txnId]);
    else await c.query("insert into lots (family_id, holding_id, buy_date, quantity, remaining_qty, unit_cost, charges, source_txn_id) values ($1,$2,$3,$4,$4,$5,$6,$7)", [familyId, holdingId, t.date, t.quantity, t.price, t.charges, txnId]);
  } else if (["sell", "redemption", "switch_out"].includes(kind)) {
    const lots = (await c.query("select id, buy_date, quantity, remaining_qty, unit_cost, charges, grandfathered_fmv from lots where holding_id=$1 and remaining_qty > 0 order by buy_date", [holdingId])).rows
      .map((l: any) => ({ id: l.id, buyDate: new Date(l.buy_date).toISOString().slice(0, 10), quantity: Number(l.quantity), remainingQty: Number(l.remaining_qty), unitCost: Number(l.unit_cost), charges: Number(l.charges), fmv: l.grandfathered_fmv == null ? null : Number(l.grandfathered_fmv) }));
    // Section 112A grandfathering: equity bought before 1 Feb 2018 takes the higher of actual cost and the lower of (31 Jan 2018 FMV, sale price); the FMV comes from the lot or the instrument (loaded per ISIN)
    const instFmv = Number((await c.query("select (meta->>'fmv_31jan2018')::numeric v from instruments where id=$1", [instrumentId])).rows[0]?.v ?? 0) || null;
    const isEquity = t.instrument.type === "stock" || t.instrument.type === "etf" || (t.instrument.type === "mf" && String(ins.rows[0].asset_class ?? "equity") === "equity");
    const avail = lots.reduce((s: number, l: any) => s + l.remainingQty, 0);
    if (avail + 1e-6 < t.quantity) throw new Error(`sell of ${t.quantity} exceeds held ${avail} for ${t.instrument.name} — import purchases first`);
    const { consumed } = consumeFifo(lots, t.quantity);
    for (const cn of consumed) await c.query("update lots set remaining_qty = remaining_qty - $2 where id=$1", [cn.lotId, cn.qty]);
    const fy = fyOf(t.date);
    for (const cn of consumed) {
      const proceeds = +((t.amount - t.charges) * cn.qty / t.quantity).toFixed(2);
      const months = monthsBetween(cn.buyDate, t.date); const long = months >= (t.instrument.type === "mf" || t.instrument.type === "stock" ? 12 : 12);
      const lot = lots.find((l: any) => l.id === cn.lotId); const fmv = lot?.fmv ?? instFmv; let cost = cn.cost; let grandfathered = false;
      if (isEquity && fmv && cn.buyDate < "2018-02-01") { const stepped = +Math.min(fmv * cn.qty, proceeds).toFixed(2); if (stepped > cost) { cost = stepped; grandfathered = true; } }
      await c.query("insert into realized_gains (family_id, entity_id, instrument_id, lot_id, sell_txn_id, fy, buy_date, sell_date, quantity, cost, proceeds, gain, term, asset_class, grandfathered, fmv_31jan2018) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
        [familyId, entityId, instrumentId, cn.lotId, txnId, fy, cn.buyDate, t.date, cn.qty, cost, proceeds, +(proceeds - cost).toFixed(2), long ? "long" : "short", t.instrument.type === "bond" ? "listed_bond" : "equity", grandfathered, grandfathered ? fmv : null]);
    }
  }
  // recompute holding quantity and average cost from lots
  await c.query(`update holdings h set quantity = s.q, avg_cost = case when s.q > 0 then s.c / s.q else 0 end, updated_at = now()
     from (select coalesce(sum(remaining_qty),0) q, coalesce(sum(remaining_qty * unit_cost + case when quantity > 0 then charges * remaining_qty / quantity else 0 end),0) c from lots where holding_id=$1) s where h.id=$1`, [holdingId]);
  return "ok";
}
function fyOf(d: string) { const [y, m] = d.split("-").map(Number); const start = m >= 4 ? y : y - 1; return `${start}-${String(start + 1).slice(-2)}`; }
function monthsBetween(a: string, b: string) { const [ay, am, ad] = a.split("-").map(Number), [by, bm, bd] = b.split("-").map(Number); let m = (by - ay) * 12 + (bm - am); if (bd < ad) m--; return m; }

export async function applyBankTxn(c: any, familyId: string, accountId: string, t: ParsedBankTxn) {
  const dup = await c.query("select 1 from bank_txns where bank_account_id=$1 and hash=$2", [accountId, t.ref]);
  if (dup.rows[0]) return "dup";
  const cat = await categorise(c, familyId, t.narration, t.amount);
  await c.query("insert into bank_txns (family_id, bank_account_id, txn_date, value_date, narration, amount, balance_after, category_id, link_type, link_id, hash, source) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [familyId, accountId, t.date, t.valueDate ?? null, t.narration, t.amount, t.balanceAfter ?? null, cat.categoryId, cat.linkType, cat.linkId, t.ref, t.source === "aa" ? "aa" : "csv"]);
  return "ok";
}
/** Rules first (family patterns by priority), then a small built-in keyword map. */
export async function categorise(c: any, familyId: string, narration: string, amount: number) {
  const rules = (await c.query("select id, pattern, field, category_id, link_type, link_id from categorisation_rules where family_id=$1 and active order by priority, created_at", [familyId])).rows;
  for (const r of rules) { if (r.field === "counterparty") continue; let ok = false; try { ok = new RegExp(r.pattern, "i").test(narration); } catch { ok = narration.toUpperCase().includes(String(r.pattern).toUpperCase()); } if (ok) { await c.query("update categorisation_rules set hits = hits + 1, last_hit_at = now() where id=$1", [r.id]); return { categoryId: r.category_id, linkType: r.link_type ?? "none", linkId: r.link_id }; } }
  const kw: [RegExp, string][] = [[/rent/i, "Rental income"], [/\bdiv\b|dividend/i, "Dividend"], [/interest|\bint\b/i, "Interest"], [/\bsip\b|mf|mutual/i, "Investment / SIP"], [/property tax|ccmc|gcc/i, "Property tax"], [/pharmacy|hospital|apollo/i, "Medical"], [/school|fees/i, "Education"], [/taj|swiggy|zomato|restaurant/i, "Dining"], [/gst/i, "GST payment"], [/tds|income tax|advance tax/i, "Tax payment"]];
  for (const [re, name] of kw) if (re.test(narration)) { const r = await c.query("select id from categories where name=$1 and family_id is null", [name]); if (r.rows[0]) return { categoryId: r.rows[0].id, linkType: name === "Rental income" ? "rent" : name === "Dividend" ? "dividend" : name === "Interest" ? "interest" : name === "Investment / SIP" ? "sip" : name === "Property tax" ? "property_tax" : "none", linkId: null }; }
  const r = await c.query("select id from categories where name=$1 and family_id is null", [amount > 0 ? "Other income" : "Household"]);
  return { categoryId: r.rows[0]?.id ?? null, linkType: "none", linkId: null };
}
/** Reconciliation: match rent credits to due rent rows (tenant name in narration, amount ≈ rent − TDS within 1%, date window). */
export async function reconcileRent(c: any, familyId: string) {
  const open = (await c.query(`select rs.id, rs.expected_rent, rs.expected_tds, rs.due_date, t.name as tenant from rent_schedule rs join leases l on l.id=rs.lease_id join tenants t on t.id=l.tenant_id where rs.status in ('due','overdue','partial')`)).rows;
  let matched = 0;
  for (const r of open) {
    const net = Number(r.expected_rent) - Number(r.expected_tds);
    const first = r.tenant.split(" ")[0];
    const hit = (await c.query(`select id, amount, txn_date from bank_txns where family_id=$1 and link_type in ('none','rent') and link_id is null and amount > 0 and narration ilike $2 and abs(amount - $3) <= greatest(1, $3 * 0.01) and txn_date between $4::date - 15 and $4::date + 45 order by txn_date limit 1`, [familyId, `%${first}%`, net, r.due_date])).rows[0];
    if (hit) { await c.query("update rent_schedule set received_amount=$2, received_on=$3, bank_txn_id=$4, status='received' where id=$1", [r.id, Number(r.expected_rent), hit.txn_date, hit.id]); await c.query("update bank_txns set link_type='rent', link_id=$2 where id=$1", [hit.id, r.id]); await c.query("update tasks set status='done', done_at=now(), verification='verified' where family_id=$1 and status='open' and source_type='rent_schedule' and source_id=$2", [familyId, r.id]); matched++; }
  }
  return matched;
}

/** Deposit reconciliation: an expected interest/maturity credit or an RD instalment debit is matched to a real bank line when
 *  the amount is right (net of 10% TDS for interest), the date is inside the window, it hit the payout account (or any account
 *  of the entity when none is linked) and the narration names the deposit number or says interest/FD/RD. A match is final
 *  and silent — no button needed; anything unmatched stays open for the user's manual Receive / Mark paid. The statement
 *  import itself sets the bank balance, so nothing here touches balances. */
const DEPOSIT_KW = String.raw`(\mint\M|interest|\mfd\M|\mrd\M|recurring|deposit|matur|clos|premat|forecl)`;
export async function reconcileDeposits(c: any, familyId: string) {
  const open = (await c.query(`select r.id, r.kind, r.expected_amount, r.due_date, d.id deposit_id, d.account_no, d.tds_applicable, d.payout_bank_account_id, d.entity_id
    from deposit_receipts r join deposits d on d.id=r.deposit_id where (d.status='active' or r.kind='foreclosure') and r.status in ('expected','overdue','partial') order by r.due_date`)).rows;
  let matched = 0;
  for (const r of open) {
    const exp = Number(r.expected_amount); const credit = r.kind !== "contribution";
    const fc = r.kind === "foreclosure";   // an early-closure credit is searched wide, then judged against the amount recorded
    const lo = fc ? exp * 0.5 : credit && r.tds_applicable ? exp * 0.895 : exp * 0.99, hi = fc ? exp * 1.5 + 1 : exp * 1.01 + 1;
    const acct = r.account_no && String(r.account_no).length >= 4 ? `%${String(r.account_no).slice(-6)}%` : null;
    const hit = (await c.query(`select t.id, t.amount, t.txn_date, ($7::text is not null and t.narration ilike $7::text) as acct_hit from bank_txns t
      where t.family_id=$1 and t.link_type in ('none','interest','sip') and t.link_id is null
        and (($2::boolean and t.amount > 0) or (not $2::boolean and t.amount < 0))
        and abs(t.amount) between $3::numeric and $4::numeric
        and t.txn_date between $5::date - 5 and $5::date + $6::int
        and (($7::text is not null and t.narration ilike $7::text) or t.narration ~* $8::text)
        and (($9::uuid is not null and t.bank_account_id = $9::uuid) or ($9::uuid is null and t.bank_account_id in (select id from bank_accounts where entity_id=$10::uuid)))
        and not exists (select 1 from deposit_receipts x where x.bank_txn_ref = t.id::text)
      order by ($7::text is not null and t.narration ilike $7::text) desc, abs(abs(t.amount) - $11::numeric), t.txn_date limit 1`,
      [familyId, credit, lo, hi, r.due_date, credit ? 15 : 5, acct, DEPOSIT_KW, r.payout_bank_account_id, r.entity_id, exp])).rows[0];
    if (!hit) continue;
    // an early-closure credit searched with the wide band is taken only when it names this deposit's account, or is within tolerance of the amount recorded
    if (fc && !hit.acct_hit && !foreclosureCreditMatches(exp, Math.abs(Number(hit.amount)))) continue;
    if (fc) {
      // within ₹10 / 0.5% of what was recorded: verified. Further apart: a variance for a person to confirm (the credit is linked either way)
      const credited = Math.abs(Number(hit.amount)); const same = foreclosureCreditMatches(exp, credited);
      await c.query("update deposit_receipts set received_amount=$2, received_on=$3, bank_txn_ref=$4, status=$5 where id=$1", [r.id, credited, hit.txn_date, hit.id, same ? "received" : "variance"]);
      await c.query("update bank_txns set link_type='deposit', link_id=$2 where id=$1", [hit.id, r.id]);
      if (same) await c.query("update tasks set status='done', done_at=now(), verification='verified' where family_id=$1 and status='open' and source_type='deposit_receipt' and source_id=$2", [familyId, r.id]);
      matched++; continue;
    }
    await c.query("update deposit_receipts set received_amount=$2, received_on=$3, bank_txn_ref=$4, status='received' where id=$1", [r.id, Math.abs(Number(hit.amount)), hit.txn_date, hit.id]);
    await c.query("update bank_txns set link_type='deposit', link_id=$2 where id=$1", [hit.id, r.id]);
    await c.query("update tasks set status='done', done_at=now(), verification='verified' where family_id=$1 and status='open' and source_type='deposit_receipt' and source_id=$2", [familyId, r.id]);
    if (r.kind === "maturity") await c.query("update deposits set status='closed', updated_at=now() where id=$1", [r.deposit_id]);
    matched++;
  }
  if (matched) await syncOutflows(c, familyId);   // a matched instalment is no longer a pending commitment
  return matched;
}

export interface ImportInput { text: string; filename: string; declared?: string; entityId?: string; bankAccountId?: string; provider?: string; mapping?: any; jobId?: string }
/** Job rows are returned in the contract's ImportJob shape; the raw log stays internal. */
function jobView(r: any) {
  const log: any[] = Array.isArray(r.error_log) ? r.error_log : [];
  return { id: r.id, source: r.source, status: r.status, rows_total: r.rows_total, rows_ok: r.rows_ok, rows_error: r.rows_error,
    filename: log.find((l) => l.filename)?.filename ?? null, errors: log.filter((l) => l.message).map((l) => ({ row: l.row, message: l.message })),
    duplicates: log.filter((l) => l.dup).length, rent_matched: log.find((l) => l.rent_matched != null)?.rent_matched ?? null,
    detected_headers: log.find((l) => l.detected_headers)?.detected_headers ?? null, created_at: r.created_at, finished_at: r.finished_at };
}

/** Detect → parse → apply inside the caller's family transaction. Returns the HTTP status and body for the job. */
export async function runImport(c: any, fam: string, userId: string | null, input: ImportInput): Promise<{ code: number; body: any }> {
  const { text, filename, declared, entityId, bankAccountId, provider } = input; let { mapping } = input;
  const sha = createHash("sha256").update(text).digest("hex");
  // one job per file content per family (re-upload is a no-op)
  const prior = (await c.query("select id, status from import_jobs where family_id=$1 and error_log @> $2::jsonb and status='done'", [fam, JSON.stringify([{ sha }])])).rows[0];
  if (prior) return { code: 200, body: { id: prior.id, status: "done", duplicate_of_previous_upload: true } };
  const jobId = input.jobId ?? (await c.query("insert into import_jobs (family_id, source, status, error_log) values ($1,$2,'running',$3) returning id", [fam, (declared as any) ?? "contract_note", JSON.stringify([{ sha, filename }])])).rows[0].id;
  if (input.jobId) await c.query("update import_jobs set status='running', error_log=$2, finished_at=null where id=$1", [jobId, JSON.stringify([{ sha, filename }])]);
  const log: any[] = [{ sha, filename }]; let total = 0, ok = 0, err = 0; let status = "done";
  try {
    let kind = detect(text); let result: any = null;
    if (mapping) { const sig = headerSignature(text); result = parseMappedContractNote(text, mapping, provider ?? "generic"); kind = "zerodha" as any;
      await c.query("insert into import_mappings (family_id, source, provider, header_signature, mapping) values ($1,'contract_note',$2,$3,$4) on conflict (family_id, source, header_signature) do update set mapping = excluded.mapping, provider = excluded.provider", [fam, provider ?? "generic", sig, JSON.stringify(mapping)]);
      (result as any).provider = provider ?? "generic"; }
    else if (!kind) {
      const sig = headerSignature(text);
      const saved = (await c.query("select provider, mapping from import_mappings where (family_id=$1 or family_id is null) and source='contract_note' and header_signature=$2 order by family_id nulls last limit 1", [fam, sig])).rows[0];
      if (saved) { result = parseMappedContractNote(text, saved.mapping, saved.provider); kind = "zerodha" as any; }
      else {
        const detected_headers = sig.split("|");
        await c.query("update import_jobs set status='needs_mapping', error_log=$2, payload=$3, finished_at=now() where id=$1", [jobId, JSON.stringify([...log, { detected_headers }]), text]);
        return { code: 202, body: { id: jobId, status: "needs_mapping", detected_headers } };
      }
    } else result = parseAny(text).result;
    total = result.rows.length; err = result.errors.length; log.push(...result.errors.map((e: any) => ({ row: e.row, message: e.message })));
    if (kind === "cas" || kind === "zerodha") {
      // statements without a PAN go to the entity that already holds an account at this provider, else the first entity
      const first = result.rows[0] as ParsedInvestmentTxn | undefined;
      const fallback = entityId
        ?? (first && (await c.query(`select entity_id from accounts where kind=$1 and ${SAME_PROVIDER.replace("$3", "$2")} and deleted_at is null order by created_at, id limit 1`, [first.account.kind, first.provider])).rows[0]?.entity_id)
        ?? (await c.query("select id from entities where deleted_at is null order by created_at, id limit 1")).rows[0]?.id;
      const touchedEntities = new Set<string>();
      for (const t of result.rows as ParsedInvestmentTxn[]) {
        const eid = await resolveEntity(c, fam, t.entityHint, fallback);
        if (!eid) { err++; log.push({ message: `no entity for PAN ${t.entityHint?.pan}` }); continue; }
        touchedEntities.add(eid);
        try { const r = await applyInvestmentTxn(c, fam, eid, t, jobId); if (r === "ok") ok++; else log.push({ dup: t.ref }); } catch (e: any) { err++; log.push({ message: e.message }); }
      }
      await c.query("update import_jobs set source=$2 where id=$1", [jobId, kind === "cas" ? "cas" : "contract_note"]);
      // a CAS refresh task is a request for exactly this; closing it here is the only place that actually knows the statement arrived
      if (kind === "cas" && touchedEntities.size) await c.query("update tasks set status='done', done_at=now(), verification='verified' where family_id=$1 and status='open' and source_type='cas_refresh' and entity_id = any($2::uuid[])", [fam, [...touchedEntities]]);
    } else if (kind === "bank_csv" || kind === "aa") {
      let acct = bankAccountId;
      if (!acct && kind === "aa" && result.masked) acct = (await c.query("select id from bank_accounts where account_masked like $1 and deleted_at is null limit 1", [`%${String(result.masked).slice(-4)}`])).rows[0]?.id;
      if (!acct) { throw new Error("bank_account_id is required for bank statements"); }
      for (const t of result.rows as ParsedBankTxn[]) { const r = await applyBankTxn(c, fam, acct, t); if (r === "ok") ok++; else log.push({ dup: t.ref }); }
      if (kind === "aa" && result.balance != null) await c.query("update bank_accounts set balance=$2, balance_as_of=$3, sync_mode='aa' where id=$1", [acct, result.balance, result.balanceAsOf ?? new Date().toISOString()]);
      else { const last = (result.rows as ParsedBankTxn[]).filter((x) => x.balanceAfter != null).sort((a, b) => a.date.localeCompare(b.date)).pop(); if (last) await c.query("update bank_accounts set balance=$2, balance_as_of=$3 where id=$1", [acct, last.balanceAfter, last.date]); }
      const matched = await reconcileRent(c, fam); log.push({ rent_matched: matched });
      log.push({ deposits_matched: await reconcileDeposits(c, fam) });
      await c.query("update import_jobs set source='bank_csv' where id=$1", [jobId]);
    } else if (kind === "pms" || kind === "aif" || kind === "ecas") {
      const st = result.rows[0]; if (!st) throw new Error(`${kind === "ecas" ? "e-CAS" : kind.toUpperCase()} statement could not be read`);
      const r = kind === "pms" ? await applyPmsStatement(c, fam, st, { entityId, jobId }) : kind === "aif" ? await applyAifStatement(c, fam, st, { entityId, jobId }) : await applyEcas(c, fam, st, { entityId, resolveEntity: (hint) => resolveEntity(c, fam, hint, undefined) });
      ok = kind === "ecas" ? (r as any).positions : 1; log.push({ statement: kind, ...r });
      await c.query("update import_jobs set source=$2 where id=$1", [jobId, kind === "ecas" ? "ecas" : "pms_stmt"]);
    } else if (kind === "form26as") {
      const eid = entityId ?? (await resolveEntity(c, fam, { pan: result.rows[0]?.pan, name: result.rows[0]?.assessee }, undefined));
      if (!eid) throw new Error("could not attribute 26AS to an entity (PAN and assessee name not found) — pass entity_id");
      for (const t of result.rows) { const q = Math.ceil(((new Date(t.date).getMonth() + 9) % 12 + 1) / 3); await c.query("insert into tds_26as (family_id, entity_id, fy, quarter, deductor_tan, deductor_name, section, amount_paid, tds_deducted, source_file) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [fam, eid, t.fy ?? fyOf(t.date), q, t.deductorTan, t.deductorName, t.section, t.amountPaid, t.tdsDeducted, jobId]); ok++; }
      await c.query("update import_jobs set source='form26as' where id=$1", [jobId]);
    }
    if (err && !ok) status = "failed";
  } catch (e: any) { status = "failed"; log.push({ message: e.message }); }
  // planned actions in executing scenarios are matched to the transactions this import brought in (FO-77)
  if (ok && status !== "failed") { try { const m = await matchActuals(c, fam); if (m.matched) log.push({ plan_actions_matched: m.matched, plan_variances: m.flagged }); } catch (e: any) { log.push({ message: `plan matching skipped: ${e.message}` }); } }
  if (ok && status !== "failed") { try { const r = await matchMoves(c, fam); if (r.matched) log.push({ rebalance_moves_matched: r.matched }); } catch (e: any) { log.push({ message: `rebalance matching skipped: ${e.message}` }); } }
  if (ok && status !== "failed") { try { const g = await autopost(c, fam); if (g.posted || g.queued) log.push({ gl_posted: g.posted, gl_unposted: g.queued }); } catch (e: any) { log.push({ message: `gl auto-posting skipped: ${e.message}` }); } }
  await c.query("update import_jobs set status=$2, rows_total=$3, rows_ok=$4, rows_error=$5, error_log=$6, payload=null, finished_at=now() where id=$1", [jobId, status, total, ok, err, JSON.stringify(log)]);
  if (status !== "failed") await emitEvent(c, fam, "import.done", { import_job_id: jobId, status, rows_total: total, rows_ok: ok, rows_error: err, filename }).catch(() => null);
  await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'import','import_jobs',$3,$4)", [fam, userId, jobId, JSON.stringify({ status, total, ok, err })]);
  const row = (await c.query("select * from import_jobs where id=$1", [jobId])).rows[0];
  return { code: status === "failed" ? 422 : 201, body: jobView(row) };
}

export default async function routes(app: FastifyInstance) {
  app.addHook("preHandler", requireFamily);

  app.get("/imports", async (req) => withFamily(req.family!.familyId, async (c) => (await c.query("select id, source, status, rows_total, rows_ok, rows_error, error_log, created_at, finished_at from import_jobs order by created_at desc limit 50")).rows.map(jobView)));
  app.get("/imports/:id", async (req, reply) => withFamily(req.family!.familyId, async (c) => { const r = (await c.query("select id, source, status, rows_total, rows_ok, rows_error, error_log, created_at, finished_at from import_jobs where id=$1", [(req.params as any).id])).rows[0]; return r ? jobView(r) : void reply.code(404).send({ title: "Not found", status: 404 }); }));

  /** Upload: multipart (file) or JSON { text, source?, entity_id?, bank_account_id?, provider?, mapping? }. */
  app.post("/imports", { preHandler: requireRole("owner", "member", "operator") }, async (req, reply) => {
    let input: ImportInput = { text: "", filename: "paste.txt" };
    if (req.isMultipart()) {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === "file") { const buf = await part.toBuffer(); if (buf.length > MAX_BYTES) return void reply.code(413).send({ title: "File too large", status: 413 }); input.text = buf.toString("utf8"); input.filename = part.filename; }
        else { const v = String((part as any).value); if (part.fieldname === "source") input.declared = v; if (part.fieldname === "entity_id") input.entityId = v; if (part.fieldname === "bank_account_id") input.bankAccountId = v; if (part.fieldname === "provider") input.provider = v; if (part.fieldname === "mapping") input.mapping = JSON.parse(v); }
      }
    } else {
      const b = z.object({ text: z.string().min(1).max(MAX_BYTES), source: z.string().optional(), entity_id: z.string().uuid().optional(), bank_account_id: z.string().uuid().optional(), provider: z.string().optional(), mapping: z.any().optional() }).parse(req.body);
      input = { text: b.text, filename: "paste.txt", declared: b.source, entityId: b.entity_id, bankAccountId: b.bank_account_id, provider: b.provider, mapping: b.mapping };
    }
    if (!input.text.trim()) return void reply.code(422).send({ title: "Empty file", status: 422 });
    return withFamily(req.family!.familyId, async (c) => { const r = await runImport(c, req.family!.familyId, req.user!.id, input); return void reply.code(r.code).send(r.body); });
  });

  /** Contract: supply a column mapping for a job that stopped at needs_mapping and re-run it on the stored payload. */
  app.post("/imports/:id/mapping", { preHandler: requireRole("owner", "member", "operator") }, async (req, reply) => {
    const b = z.object({ provider: z.string().optional(), mapping: z.record(z.any()), entity_id: z.string().uuid().optional() }).parse(req.body);
    return withFamily(req.family!.familyId, async (c) => {
      const job = (await c.query("select id, status, payload, error_log from import_jobs where id=$1", [(req.params as any).id])).rows[0];
      if (!job) return void reply.code(404).send({ title: "Not found", status: 404 });
      if (job.status !== "needs_mapping" || !job.payload) return void reply.code(409).send({ title: "Job is not waiting for a mapping", status: 409 });
      const filename = (job.error_log as any[]).find((l) => l.filename)?.filename ?? "upload";
      const r = await runImport(c, req.family!.familyId, req.user!.id, { text: job.payload, filename, entityId: b.entity_id, provider: b.provider, mapping: b.mapping, jobId: job.id });
      return void reply.code(r.code).send(r.body);
    });
  });

  app.get("/tds/reconciliation", async (req) => {
    const q = z.object({ fy: z.string(), entity_id: z.string().uuid().optional() }).parse(req.query);
    return withFamily(req.family!.familyId, async (c) => {
      const params: any[] = [q.fy]; const ef = q.entity_id ? (params.push(q.entity_id), " and entity_id=$2") : "";
      const in26 = (await c.query(`select deductor_name, deductor_tan, section, sum(tds_deducted) t from tds_26as where fy=$1 ${ef} group by 1,2,3`, params)).rows;
      const expected = (await c.query(`select t.name as deductor_name, '194I' as section, sum(rs.expected_tds) t from rent_schedule rs join leases l on l.id=rs.lease_id join tenants t on t.id=l.tenant_id where rs.expected_tds > 0 and to_char(rs.period_month,'YYYY') || '-' || to_char(rs.period_month + interval '1 year','YY') = $1 group by 1`, [q.fy])).rows;
      const out: any[] = [];
      for (const e of expected) { const m = in26.find((x) => x.deductor_name.toLowerCase().includes(e.deductor_name.split(" ")[0].toLowerCase()) && x.section === e.section); const a = Number(e.t), b = Number(m?.t ?? 0); out.push({ deductor: e.deductor_name, section: e.section, expected: money(a), in_26as: money(b), difference: money(b - a), status: !m ? "missing" : Math.abs(a - b) < 1 ? "matched" : b < a ? "short" : "extra" }); }
      for (const x of in26) if (!expected.find((e) => x.deductor_name.toLowerCase().includes(e.deductor_name.split(" ")[0].toLowerCase()))) out.push({ deductor: x.deductor_name, section: x.section, expected: "0.00", in_26as: money(x.t), difference: money(x.t), status: "extra" });
      return out;
    });
  });

  app.get("/capital-gains", async (req) => {
    const q = z.object({ fy: z.string(), entity_id: z.string().uuid().optional() }).parse(req.query);
    return withFamily(req.family!.familyId, async (c) => {
      const params: any[] = [q.fy]; const ef = q.entity_id ? (params.push(q.entity_id), " and g.entity_id=$2") : "";
      const lots = (await c.query(`select g.*, e.name as entity_name, i.name as instrument from realized_gains g join entities e on e.id=g.entity_id join instruments i on i.id=g.instrument_id where g.fy=$1 ${ef} order by g.sell_date`, params)).rows;
      const rules = (await c.query("select asset_class, term, rate, taxed_at_slab, exemption_amount from tax_rules where fy=$1", [q.fy])).rows;
      const byEntity: Record<string, any> = {};
      for (const l of lots) {
        const k = l.entity_id + "|" + l.asset_class; byEntity[k] ??= { entity_id: l.entity_id, entity_name: l.entity_name, asset_class: l.asset_class, stcg: 0, ltcg: 0 };
        byEntity[k][l.term === "long" ? "ltcg" : "stcg"] += Number(l.gain);
      }
      const summary = Object.values(byEntity).map((s: any) => {
        const lr = rules.find((r) => r.asset_class === s.asset_class && r.term === "long"), sr = rules.find((r) => r.asset_class === s.asset_class && r.term === "short");
        const ex = Math.max(0, Math.min(s.ltcg, Number(lr?.exemption_amount ?? 0))); const taxable = Math.max(0, s.ltcg - ex) + Math.max(0, s.stcg);
        const tax = Math.max(0, s.ltcg - ex) * Number(lr?.rate ?? 0) / 100 + Math.max(0, s.stcg) * (sr?.taxed_at_slab ? 30 : Number(sr?.rate ?? 0)) / 100;
        return { ...s, stcg: money(s.stcg), ltcg: money(s.ltcg), exemption_used: money(ex), taxable: money(taxable), est_tax: money(tax) };
      });
      return { fy: q.fy, summary, lots: lots.map((l) => ({ entity_name: l.entity_name, instrument: l.instrument, buy_date: l.buy_date, sell_date: l.sell_date, quantity: Number(l.quantity), cost: money(l.cost), proceeds: money(l.proceeds), gain: money(l.gain), term: l.term, asset_class: l.asset_class, grandfathered: false })) };
    });
  });
}
