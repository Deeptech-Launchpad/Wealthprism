-- Phase 2: closing a deposit before maturity ("foreclosure"). The closure itself is one more row in deposit_receipts (kind 'foreclosure'): it is
-- expected until the bank's credit is seen, by hand or on a statement, exactly like an interest or maturity payment. That reuses the reminders,
-- the statement matching and the Books posting that receipts already have.
alter table deposit_receipts drop constraint if exists deposit_receipts_kind_check;
alter table deposit_receipts add constraint deposit_receipts_kind_check check (kind in ('interest','contribution','maturity','foreclosure'));
-- variance = a credit was found but is further from the amount recorded than the tolerance; cancelled = an interest row the closure settled
alter table deposit_receipts drop constraint if exists deposit_receipts_status_check;
alter table deposit_receipts add constraint deposit_receipts_status_check check (status in ('expected','received','partial','overdue','variance','cancelled'));
-- how a foreclosure credit splits: principal returned, and tax the bank deducted (the rest of the credit is interest, or a recovery when negative)
alter table deposit_receipts add column if not exists principal_component numeric(14,2);
alter table deposit_receipts add column if not exists tds_component numeric(14,2) not null default 0;

alter table deposits add column if not exists closed_on date;
alter table deposits add column if not exists closure_penalty_pct numeric(4,2);
alter table deposits add column if not exists closure_exception_reason text;   -- set only when a type that forbids early closure was closed as a bank exception
alter table deposits add column if not exists closed_by uuid references users(id);

-- Books: one journal when the credit arrives. interest_up / interest_down are the interest earned beyond, or given back against, what had
-- already been accrued; only one of the two is ever non-zero, so the journal always balances.
insert into gl_posting_rules (event_type, instrument_class, lines) values
('deposit.foreclosed', null, '[{"side":"debit","account_code":"1110","amount":"received"},{"side":"debit","account_code":"1420","amount":"tds"},{"side":"debit","account_code":"4300","amount":"interest_down"},{"side":"credit","account_code":"1260","amount":"principal"},{"side":"credit","account_code":"1470","amount":"accrued"},{"side":"credit","account_code":"4300","amount":"interest_up"}]');
