# Sample input files for parser development

All files are **synthetic** and format-faithful, sized to the seed data in `db/002_seed.sql`
(so a successful import should reconcile against the seeded holdings and bank balances).
They are for building and unit-testing parsers. Before release, replace each with 2–3 **real, anonymised**
files from the actual providers — real files vary more than these samples.

| File | Source it imitates | Parser to build | Notes |
|---|---|---|---|
| `zerodha_tradebook_FY2026-27.csv` | Zerodha Console tradebook export | `parsers/contract_note/zerodha.ts` | `trade_type` buy/sell; charges arrive separately in the contract note, not here |
| `icicidirect_contract_note_sample.csv` | ICICI Direct contract-note summary (XLS in reality) | `parsers/contract_note/generic_mapped.ts` | Use for the column-mapping assistant test (`POST /imports/{id}/mapping`) |
| `cams_cas_extracted_text_sample.txt` | Text extracted from a CAMS/KFintech detailed CAS PDF (`pdftotext -layout`) | `parsers/cas/cams.ts` | Multiple PANs → map folio to entity by PAN; parentheses = negative; SIP lines carry "(1)" |
| `hdfc_bank_statement_sep2026.csv` | HDFC NetBanking "Delimited" statement | `parsers/bank_csv/hdfc.ts` | dd/mm/yy dates; separate withdrawal/deposit columns |
| `aa_fi_data_deposit_sample.json` | Account Aggregator FI data (ReBIT deposit schema) after decryption | `integrations/aa/normalise.ts` | Balances and transactions arrive together; de-dup on (account, txnId or reference) |
| `form26as_mehta_huf_FY2026-27.txt` | TRACES Form 26AS Part A text export | `parsers/form26as.ts` | Deductor header row followed by section rows; sum by (TAN, section) |
| `pms_statement_extracted_text_sample.txt` | PMS monthly statement text | `parsers/pms_stmt/generic.ts` | Only closing value, fees and capital contributed are needed; holdings are informational |
| `aif_statement_extracted_text_sample.txt` | AIF capital-account statement text (commitment, drawn, NAV, call notice, distribution) | `parsers/pms.ts` `parseAifStatement` | The call notice becomes a committed outflow + task on its due date; NAV becomes a private mark; the distribution is de-duplicated against `fund_cashflows` |
| `ecas_nsdl_extracted_text_sample.txt` | NSDL e-CAS text: demat ISIN holdings and MF folios for one PAN | `parsers/ecas.ts` | Positions only — imported straight into reconciliation (`ecas_nsdl` / `cas_mf` sources); a quantity that differs from the platform raises an exception |
| `research_kotak_morning_note.txt` | Broker morning note (structured call lines) | `apps/api/src/lib/research.ts` `extractHeuristic` | Six calls: `ACTION \| Instrument (SYMBOL) \| CMP \| TP \| SL \| 12M \| High` with the thesis on the next line; two name instruments outside the master and stay as text |

Expected results after importing all of the above into the seeded family:
- HDFC ••4471 closing balance 21,567.60 → matches within tolerance of the AA balance (21,485 in seed is prior day).
- Kovai Analytics NEFT 2,565 links to the Race Course Road lease (rent 2,850 − TDS 285).
- Form 26AS 194-I total 1,710 for FY reconciles to 6 months × 285.
- Axis Small Cap redemption produces one STCG lot with gain −200 for Mehta HUF.
- `fmv_31jan2018_sample.csv` — 31 Jan 2018 fair market values per ISIN for Section 112A grandfathering (sample figures: replace with the exchange highs of 31 Jan 2018 / the AMFI NAV of that day; load with `POST /instruments/fmv` or `cli fmv:load --file`). Sales of pre-Feb-2018 equity lots then step the cost up to the lower of FMV and sale price.
