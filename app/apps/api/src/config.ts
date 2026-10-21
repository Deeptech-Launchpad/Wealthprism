import { fileURLToPath } from "node:url";

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://app_user:app@localhost:5432/familyoffice",
  migrationDatabaseUrl: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/familyoffice",
  jwtSecret: process.env.JWT_SECRET ?? "dev-only-change-me",
  refreshSecret: process.env.REFRESH_SECRET ?? "dev-only-change-me-too",
  accessTtl: 900,
  refreshTtl: 60 * 60 * 24 * 30,
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  dbDir: process.env.DB_DIR ?? fileURLToPath(new URL("../../../../db", import.meta.url)),
  // WebAuthn/passkey step-up (FO-122): rpID must be the bare domain (no scheme/port) the browser is on; origin is the
  // full web app URL. Defaults match the local dev stack (web on :5173); set both in production.
  webauthnRpId: process.env.WEBAUTHN_RP_ID ?? "localhost",
  webauthnRpName: process.env.WEBAUTHN_RP_NAME ?? "WealthPrism",
  webauthnOrigin: process.env.WEBAUTHN_ORIGIN ?? "http://localhost:5173",
};
