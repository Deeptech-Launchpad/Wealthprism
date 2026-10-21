-- Roadmap gap: buildings were never included in the depreciation schedule, only lifestyle assets and capital
-- improvements (see glperiod.ts depreciationSchedule). The depreciation_rates for 'building' (residential, 5%)
-- and 'building_commercial' (10%) already existed as data since 028 but nothing fed properties into the schedule.
--
-- Land is never depreciable under the Income-tax Act, and this platform does not split acquisition_cost into
-- land vs structure, so land_value lets a family record that split per property (defaults to 0, i.e. the whole
-- acquisition cost is treated as depreciable building until set — accurate for a flat/apartment with no separate
-- land component, an approximation for an independent house on its own plot until corrected).
alter table properties add column if not exists land_value numeric(18,2) not null default 0;
comment on column properties.land_value is 'Portion of acquisition_cost + stamp_duty + registration attributable to land; excluded from depreciation. Set this for an independent house / plot to avoid overstating depreciable cost.';
