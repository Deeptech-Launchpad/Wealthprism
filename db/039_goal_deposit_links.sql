-- A goal can now be funded by a fixed or recurring deposit, like it already can by a holding, a private stake or a property.
alter table goal_links add column if not exists deposit_id uuid references deposits(id) on delete cascade;
alter table goal_links drop constraint if exists goal_links_check;
alter table goal_links add constraint goal_links_check check (num_nonnulls(holding_id, private_investment_id, property_id, deposit_id) = 1);
