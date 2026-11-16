// Some suites were written around the demo date, 12 Sep 2026 (leases, rent due dates, the rebalancing plan, the Varaha
// drawdown, the GST returns). The app reads the real clock, so those suites pass on the day they were written and fail
// later. For those files only, freeze the JavaScript clock at the demo date. Other suites keep the real clock, because
// they are written against today (assets accrual, fund yields, bond coupons).
// Postgres current_date is not affected by this; a test that depends on it must pass the date explicitly.
import { vi, expect } from "vitest";

const DEMO_DATE_FILES = ["analytics.test.ts", "api.test.ts", "market.test.ts", "policy.test.ts", "realestate.test.ts", "rebalance.test.ts", "tasks.test.ts"];

const file = expect.getState().testPath ?? "";
if (DEMO_DATE_FILES.some((f) => file.endsWith(f))) {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-12T06:00:00Z") });
}
