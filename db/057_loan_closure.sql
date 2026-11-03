-- Closing a loan: when it ended (last instalment paid, or paid off early) and how much was paid to the lender to close it early.
alter table liabilities add column if not exists closed_on date;
alter table liabilities add column if not exists closed_amount numeric(18,2);
