-- Align the demo entities' PAN suffixes with the sample fixtures in samples/ so that
-- importing the sample CAS / Form 26AS attributes folios and TDS to the right entity.
-- ABCDE1234A = Arjun Mehta, ABCDE1234H = Mehta HUF (matches the HUF GSTIN 33AAAAA1234H1Z5).
update entities set pan_last4 = '234A' where id = '33333333-0000-0000-0000-000000000001' and pan_last4 = '123A';
update entities set pan_last4 = '234H' where id = '33333333-0000-0000-0000-000000000002' and pan_last4 = '456H';
