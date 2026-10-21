-- Milestone 15: Section 112A grandfathering flag on realised gains (the 31 Jan 2018 FMV per ISIN lives on instruments.meta and lots.grandfathered_fmv).
alter table realized_gains add column if not exists grandfathered boolean not null default false;
alter table realized_gains add column if not exists fmv_31jan2018 numeric(18,4);
