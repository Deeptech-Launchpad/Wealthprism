-- A goal can be funded by a savings account (PPF, EPF, Sukanya Samriddhi), not only by holdings, stakes, flats and deposits.
alter table goal_links add column if not exists savings_account_id uuid references savings_accounts(id) on delete cascade;
alter table goal_links drop constraint if exists goal_links_check;
alter table goal_links add constraint goal_links_check check (num_nonnulls(holding_id, private_investment_id, property_id, deposit_id, savings_account_id) = 1);
