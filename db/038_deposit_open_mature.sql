-- Deposits step 4: the FD principal itself reaches Books (it moves from the bank into account 1260 when the FD opens), and a maturity
-- payout returns the principal and clears any interest accrued at maturity. Mirrors the other deposit.* rules (db/036, db/037).
insert into gl_posting_rules (event_type, instrument_class, lines) values
('deposit.opened',  null, '[{"side":"debit","account_code":"1260","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('deposit.matured', null, '[{"side":"debit","account_code":"1110","amount":"received"},{"side":"credit","account_code":"1260","amount":"principal"},{"side":"credit","account_code":"1470","amount":"interest"}]');
