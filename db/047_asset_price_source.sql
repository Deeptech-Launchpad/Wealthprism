-- Add asset: say, per type, whether its price fills itself in from a feed or has to be kept up to date by the user.
-- 'feed' = a daily feed prices it (AMFI NAV, NSE close); 'partial' = a feed prices it only when it matches; 'manual' = the user keeps the value current.
alter table asset_types add column if not exists price_mode text not null default 'manual' check (price_mode in ('feed','partial','manual'));
alter table asset_types add column if not exists price_help text;

update asset_types set price_mode = 'feed', price_help = 'The latest NAV is filled in automatically from AMFI every night. There is no price to type.' where code = 'mf';
update asset_types set price_mode = 'feed', price_help = 'The price updates every trading day from the NSE closing prices, matched by the NSE symbol or the ISIN. Type the real symbol exactly as on NSE; the current price you type is only the first value until the next feed runs.' where code in ('stock', 'etf', 'gold_etf', 'reit');
update asset_types set price_mode = 'partial', price_help = 'A bond that is listed gets its NSE close when the ISIN matches. Otherwise its value stays at the price you type until you change it.' where code = 'bond';
update asset_types set price_mode = 'manual', price_help = 'There is no price feed for this. The value stays at the price you type until you update it.' where code in ('gsec', 'tbill', 'sgb');
update asset_types set price_mode = 'manual', price_help = 'Value comes from the manager''s statement. Enter it from the latest statement and update it when a new one arrives.' where code in ('pms', 'aif');
update asset_types set price_mode = 'manual', price_help = 'There is no price feed. Enter today''s value and use Revalue when it changes (for gold, weight x the day''s rate).' where category = 'physical';
update asset_types set price_mode = 'manual', price_help = 'There is no feed. Enter the surrender or fund value from the insurer''s statement, and edit it when it changes.' where code in ('ins_endowment', 'ins_ulip');
update asset_types set price_mode = 'manual', price_help = 'Cover only: it has no value to keep current.' where category = 'insurance' and counts_in_net_worth = false;
update asset_types set price_mode = 'manual', price_help = 'The balance comes from your passbook or statement.' where category = 'savings';
