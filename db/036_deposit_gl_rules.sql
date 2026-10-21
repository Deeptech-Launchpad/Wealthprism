-- Books integration for deposits (fd/rd), step 2 of the agreed build order. Only interest income is posted —
-- an rd's monthly contribution is a transfer, not income, and nothing has actually moved yet without a confirmed
-- bank-statement match (a later step), so contributions are deliberately not accrued here to avoid booking a
-- cash movement that hasn't happened. Mirrors rent.accrued / rent.received exactly (db/007, lines ~325-326).
insert into gl_posting_rules (event_type, instrument_class, lines) values
('deposit.interest_accrued', null, '[{"side":"debit","account_code":"1470","amount":"amount"},{"side":"credit","account_code":"4300","amount":"amount"}]'),
('deposit.interest_received', null, '[{"side":"debit","account_code":"1110","amount":"received"},{"side":"debit","account_code":"1420","amount":"tds"},{"side":"credit","account_code":"1470","amount":"received_plus_tds"}]');
