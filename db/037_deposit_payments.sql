-- Deposits step 3: a bank debit/credit can now be linked to a deposit receipt, and a *confirmed* RD instalment
-- (paid by hand or matched from a statement) posts to Books as a transfer into the deposit asset (not an expense).
alter type link_type add value if not exists 'deposit';

insert into gl_posting_rules (event_type, instrument_class, lines) values
('deposit.contribution_paid', null, '[{"side":"debit","account_code":"1260","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]');
