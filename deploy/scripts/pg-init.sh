#!/bin/sh
# Runs once on first Postgres start: apply schema, create app role password, seed only if SEED_ON_START.
set -e
psql -v ON_ERROR_STOP=1 -U postgres -d familyoffice -f /db/001_init.sql
psql -v ON_ERROR_STOP=1 -U postgres -d familyoffice -f /db/003_planning_taxation.sql
psql -v ON_ERROR_STOP=1 -U postgres -d familyoffice -f /db/005_asset_class_coverage.sql
psql -v ON_ERROR_STOP=1 -U postgres -d familyoffice -f /db/006_balance_sheet_analytics.sql
psql -v ON_ERROR_STOP=1 -U postgres -d familyoffice -f /db/007_general_ledger.sql
psql -v ON_ERROR_STOP=1 -U postgres -d familyoffice -f /db/008_action_plane.sql
psql -v ON_ERROR_STOP=1 -U postgres -d familyoffice -f /db/009_investment_policy.sql
psql -v ON_ERROR_STOP=1 -U postgres -d familyoffice -f /db/010_research_proposals.sql
psql -v ON_ERROR_STOP=1 -U postgres -d familyoffice -f /db/011_rebalancing_engine.sql
psql -v ON_ERROR_STOP=1 -U postgres -d familyoffice -f /db/012_executor_grants.sql
psql -v ON_ERROR_STOP=1 -U postgres -d familyoffice -f /db/013_app_functions.sql
psql -v ON_ERROR_STOP=1 -U postgres -d familyoffice -c "alter role executor_user with password '${EXECUTOR_DB_PASSWORD}';"
psql -v ON_ERROR_STOP=1 -U postgres -d familyoffice -c "alter role app_user with password '${APP_DB_PASSWORD}';"
if [ "${SEED_ON_START}" = "true" ]; then
  psql -v ON_ERROR_STOP=1 -U postgres -d familyoffice -f /db/002_seed.sql
  psql -v ON_ERROR_STOP=1 -U postgres -d familyoffice -f /db/004_seed_planning.sql
  # demo users get a real bcrypt hash for Prototype!2026 (pgcrypto's bf is compatible with bcryptjs)
  psql -v ON_ERROR_STOP=1 -U postgres -d familyoffice -c "update users set password_hash = crypt('Prototype!2026', gen_salt('bf', 10)) where email like '%@example.com';"
fi
