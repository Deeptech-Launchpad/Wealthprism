alter table users add column if not exists reset_token_hash text;
alter table users add column if not exists reset_expires_at timestamptz;
