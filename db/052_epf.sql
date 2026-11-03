-- Government savings, round 3a: EPF. It reuses the PPF/SSY account engine (savings_accounts + savings_entries) with two differences: the contributions come out of
-- the salary every month, so the app adds them by itself (entries marked auto), and the interest is worked out on the running monthly balance, added on 31 March.
alter table savings_accounts drop constraint if exists savings_accounts_scheme_check;
alter table savings_accounts add constraint savings_accounts_scheme_check check (scheme in ('ppf','ssy','epf'));
alter table savings_accounts add column employee_monthly numeric(14,2) not null default 0;
alter table savings_accounts add column employer_monthly numeric(14,2) not null default 0;
alter table savings_entries add column auto boolean not null default false;   -- a monthly contribution the app added from the account's monthly amounts
create unique index savings_auto_once on savings_entries (account_id, entry_date) where auto;

update asset_types set enabled = true, label = 'EPF (Provident Fund)', description = 'Your provident fund through an employer. The contribution goes in every month; the interest (set yearly by EPFO) is added once a year.' where code = 'epf';
