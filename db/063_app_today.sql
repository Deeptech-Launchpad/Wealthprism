-- The app's "today" for SQL. Normally this is Postgres current_date. The API test run can set app.today for one
-- transaction (lib/db.ts, FO_TEST_TODAY), so the database and the JavaScript clock agree on the demo date. Nothing
-- else sets app.today, so production behaviour is unchanged.
create or replace function app_today() returns date language sql stable as $$
  select coalesce(nullif(current_setting('app.today', true), '')::date, current_date)
$$;
