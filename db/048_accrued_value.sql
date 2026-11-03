-- A G-Sec, T-bill or unlisted bond with no market price is worth what was paid, drifting evenly up (or down) to its face value on the maturity date: the value
-- the holder is certain to get if it is held to maturity. accrued_unit_price(holding, cost) is that value per unit; every place that used to fall back to the cost
-- when no price exists now falls back to it. Accrued interest is not in it: the coupons arrive as their own expected payments.
create or replace function accrued_unit_price(p_holding uuid, p_cost numeric) returns numeric
language plpgsql stable as $$
declare t text; m_txt text; f_txt text; m date; face numeric; avg_buy date; frac numeric;
begin
  select i.type::text, i.meta->>'maturity_date', i.meta->>'face_value' into t, m_txt, f_txt
    from holdings h join instruments i on i.id = h.instrument_id where h.id = p_holding;
  if t is null or m_txt is null or t not in ('gsec', 'tbill', 'bond') then return p_cost; end if;
  m := left(m_txt, 10)::date;
  face := coalesce(nullif(f_txt, '')::numeric, case when t = 'bond' then 1000 else 100 end);
  if current_date >= m then return face; end if;   -- matured and not yet recorded: the face value is receivable
  select (to_timestamp(sum(remaining_qty * extract(epoch from buy_date)) / nullif(sum(remaining_qty), 0)))::date into avg_buy from lots where holding_id = p_holding and remaining_qty > 0;
  if avg_buy is null or m <= avg_buy then return p_cost; end if;
  frac := greatest(0, least(1, (current_date - avg_buy)::numeric / (m - avg_buy)));
  return round(p_cost + (face - p_cost) * frac, 4);
exception when others then return p_cost;   -- a malformed date or face value must never break a holdings list
end $$;
grant execute on function accrued_unit_price(uuid, numeric) to app_user;

-- the catalogue says so: G-Secs and T-bills are worked out by the app, bonds are fed when listed and otherwise worked out as well
alter table asset_types drop constraint if exists asset_types_price_mode_check;
alter table asset_types add constraint asset_types_price_mode_check check (price_mode in ('feed','partial','accrued','manual'));
update asset_types set price_mode = 'accrued', price_help = 'There is no price feed, and none to type: the app works the value out for you. It starts at what you paid and moves evenly to the face value by the maturity date. The interest arrives as its own expected payments.' where code in ('gsec', 'tbill');
update asset_types set price_mode = 'partial', price_help = 'A listed bond gets its NSE close when the ISIN matches. Otherwise leave the current price blank and the value moves evenly from what you paid to the face value by the maturity date.' where code = 'bond';
