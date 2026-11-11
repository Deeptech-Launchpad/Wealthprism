-- More ways to repeat an income or expense: every 3 months (quarterly) and every 6 months (half-yearly), next to monthly, yearly and one-off.
alter table entity_income_sources drop constraint if exists entity_income_sources_frequency_check;
alter table entity_income_sources add constraint entity_income_sources_frequency_check check (frequency in ('monthly','quarterly','half_yearly','yearly'));

alter table household_expenses drop constraint if exists household_expenses_frequency_check;
alter table household_expenses add constraint household_expenses_frequency_check check (frequency in ('monthly','quarterly','half_yearly','yearly','once'));
