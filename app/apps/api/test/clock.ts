// Some suites were written around the demo date, 12 Sep 2026 (leases, rent due dates, the rebalancing plan, the Varaha
// drawdown, the GST returns). The app takes "today" from the JavaScript clock and from the database (app_today(), which
// reads app.today when FO_TEST_TODAY is set in lib/db.ts). For those files only, pin both to the demo date. Other suites
// keep the real clock, because they are written against today (assets accrual, fund yields, bond coupons).
import { vi, expect } from "vitest";

const DEMO_DATE = "2026-09-12";
const DEMO_DATE_FILES = ["analytics.test.ts", "api.test.ts", "market.test.ts", "policy.test.ts", "realestate.test.ts", "rebalance.test.ts", "tasks.test.ts"];

const file = expect.getState().testPath ?? "";
if (DEMO_DATE_FILES.some((f) => file.endsWith(f))) {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${DEMO_DATE}T06:00:00Z`) });
  process.env.FO_TEST_TODAY = DEMO_DATE;
} else {
  delete process.env.FO_TEST_TODAY;
}
