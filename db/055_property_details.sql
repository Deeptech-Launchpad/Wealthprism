-- Property size and registration details: extent (area + unit), built-up / carpet area, survey and patta numbers,
-- unit number, sale-deed registration number and sub-registrar office, boundaries.
alter table properties add column if not exists area_value numeric(14,4);
alter table properties add column if not exists area_unit text;
alter table properties add column if not exists built_up_sqft numeric(12,2);
alter table properties add column if not exists carpet_sqft numeric(12,2);
alter table properties add column if not exists survey_no text;
alter table properties add column if not exists patta_no text;
alter table properties add column if not exists land_use text;
alter table properties add column if not exists unit_no text;
alter table properties add column if not exists registration_no text;
alter table properties add column if not exists sub_registrar text;
alter table properties add column if not exists boundaries text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'properties_area_unit_chk') then
    alter table properties add constraint properties_area_unit_chk check (area_unit is null or area_unit in ('sqft','sqm','cent','ground','acre','hectare'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'properties_land_use_chk') then
    alter table properties add constraint properties_land_use_chk check (land_use is null or land_use in ('agricultural','residential_plot','commercial_plot'));
  end if;
end $$;
