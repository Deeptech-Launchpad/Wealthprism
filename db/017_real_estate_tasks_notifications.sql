-- Milestone 3: real-estate write paths, GST register, task engine, notifications (PRD 3.3, 3.8; FO-55, FO-56)

-- Tenants may be GST-registered; the recipient's state decides CGST/SGST vs IGST on the register.
alter table tenants add column if not exists gstin text;
alter table tenants add column if not exists state_code char(2);
alter table tenants add column if not exists created_at timestamptz not null default now();

-- GST parameters are data, per FY (PRD: "tax rules are data").
create table gst_settings (
  fy text primary key,
  registration_threshold numeric(18,2) not null,   -- aggregate turnover per GSTIN
  commercial_rent_rate numeric(5,2) not null,
  sac_code text not null,
  gstr1_due_day smallint not null,                 -- of the following month
  gstr3b_due_day smallint not null
);
insert into gst_settings values ('2024-25', 2000000, 18, '997212', 11, 20), ('2025-26', 2000000, 18, '997212', 11, 20), ('2026-27', 2000000, 18, '997212', 11, 20), ('2027-28', 2000000, 18, '997212', 11, 20)
on conflict (fy) do nothing;

-- Notifications: in-app inbox rows carry their own text; devices hold Expo push tokens; preferences per user.
alter table notifications add column if not exists family_id uuid references families(id) on delete cascade;
alter table notifications add column if not exists title text;
alter table notifications add column if not exists body text;
alter table notifications add column if not exists created_at timestamptz not null default now();
create index if not exists notifications_user_idx on notifications (user_id, read_at, created_at desc);

create table user_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  platform text not null,                          -- ios | android | web
  push_token text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create table notification_prefs (
  user_id uuid primary key references users(id) on delete cascade,
  inapp boolean not null default true,
  push_min_severity smallint not null default 1,   -- push for tasks at this severity or more urgent (1 = most urgent)
  email_digest text not null default 'daily',      -- off | daily | weekly
  digest_hour_ist smallint not null default 8,
  whatsapp boolean not null default false,
  last_digest_at timestamptz
);

-- Tenant reminders (rent overdue etc.) are queued here; a channel adapter delivers them.
create table rent_reminders (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  rent_schedule_id uuid not null references rent_schedule(id) on delete cascade,
  channel text not null,                           -- email | whatsapp | sms
  template text not null default 'rent_overdue',
  to_contact text,
  message text,
  status text not null default 'queued',           -- queued | sent | failed
  queued_by uuid references users(id),
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  error text
);
alter table rent_reminders enable row level security;
alter table rent_reminders force row level security;
create policy rent_reminders_tenant on rent_reminders using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid);

create index if not exists tasks_source_open_idx on tasks (family_id, source_type, source_id) where status = 'open';

grant select, insert, update, delete on gst_settings, user_devices, notification_prefs, rent_reminders, notifications to app_user;
