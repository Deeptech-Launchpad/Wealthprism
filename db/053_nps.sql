-- Government savings, round 3b: NPS. It is units x NAV like a mutual fund, so it uses the market-holdings engine (instruments, holdings, lots, investment_txns):
-- each NPS scheme (fund manager + E / C / G / A + tier) is one instrument, a contribution buys units at the NAV, and the NAV is typed from the CRA statement
-- because there is no price feed. The Add-asset screen still lists it under Government savings.
update asset_types set
  category = 'market', enabled = true, label = 'NPS (National Pension System)', instrument_type = 'nps', asset_class = 'nps', alloc_class = null, default_bucket = 'growth',
  description = 'Your pension account. Each contribution buys units of a scheme at the day''s NAV. Add one holding for each scheme your statement lists; the NAV is typed from the statement.',
  price_mode = 'manual', price_help = 'There is no price feed for NPS. Type the NAV from your CRA statement (Protean, KFintech or CAMS) and use Update price when you get a new one.',
  fields = '[{"key":"tier","label":"Tier","type":"select","options":["Tier I","Tier II"]},{"key":"scheme_choice","label":"Scheme","type":"select","options":["Equity (E)","Corporate bond (C)","Government bond (G)","Alternative (A)"],"required":true},{"key":"manager","label":"Pension fund manager","type":"select","options":["SBI Pension Funds","HDFC Pension","ICICI Prudential Pension","Kotak Mahindra Pension","LIC Pension Fund","UTI Retirement Solutions","Aditya Birla Sun Life Pension","Tata Pension","Axis Pension","Max Life Pension"]},{"key":"pran","label":"PRAN (optional)","type":"text"}]'
where code = 'nps';

-- the units are not sold like shares (NPS pays out at 60), so no capital-gains rule applies; a rule row keeps the gains report from failing on the class
insert into tax_rules (fy, asset_class, term, rate, taxed_at_slab, exemption_amount, holding_months_for_long, indexation, notes)
select f.fy, 'nps', t.term::gain_term, 0, false, 0, 12, false, 'NPS is paid out at retirement: up to 60% tax-free, the rest buys an annuity taxed at slab. Not taxed as units are held.'
from (values ('2026-27'),('2027-28'),('2028-29'),('2029-30')) f(fy) cross join (values ('short'),('long')) t(term)
on conflict (fy, asset_class, term) do nothing;
