-- Roadmap gap (FO-122): passkey (WebAuthn) step-up for approvals, alongside the existing TOTP path. The
-- action_plane / policy / research / connectors approval routes already accept any auth_method + auth_proof
-- and call verifyStepUp() generically (db/008's approvals.auth_method already anticipated 'passkey') — this
-- migration only adds what was missing: somewhere to store registered credentials and the in-flight challenge.

create table if not exists webauthn_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  credential_id text not null unique,          -- base64url, from the authenticator
  public_key bytea not null,
  counter bigint not null default 0,            -- replay protection; must strictly increase each use
  device_name text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index on webauthn_credentials (user_id);
grant select, insert, update on webauthn_credentials to app_user;

-- One challenge in flight per user at a time (registration or authentication); short-lived, overwritten per attempt.
alter table users add column if not exists webauthn_challenge text;
alter table users add column if not exists webauthn_challenge_expires timestamptz;
