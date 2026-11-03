-- PPF and SSY: money taken out before maturity (a part withdrawal) and closing the account. A withdrawal is an entry like a deposit but in the other direction;
-- closes marks the entry that ended the account. A rule breach is only recorded by an owner with a written reason, kept in override_reason.
alter table savings_entries drop constraint if exists savings_entries_kind_check;
alter table savings_entries add constraint savings_entries_kind_check check (kind in ('deposit','interest','withdrawal'));
alter table savings_entries add column closes boolean not null default false;
alter table savings_entries add column override_reason text;
alter table savings_accounts add column closed_on date;
