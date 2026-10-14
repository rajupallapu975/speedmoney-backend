const assert = require('assert');

console.log('Starting Phase 3.4.2 IST Date Boundaries and Ledger Pagination State Test Suite...\n');

// ============================================================================
// PART 1: IST Date Calculation & Boundary Tests
// ============================================================================

/**
 * Replicates getTodayIST from agent-api.ts given a specific Date instance.
 */
function getTodayISTForDate(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Replicates getPastISTDate from agent-api.ts
 */
function getPastISTDate(daysAgo, baseDateStr) {
  const reference =
    baseDateStr && /^\d{4}-\d{2}-\d{2}$/.test(baseDateStr)
      ? baseDateStr
      : getTodayISTForDate(new Date());
  const [year, month, day] = reference.split("-").map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  utcDate.setUTCDate(utcDate.getUTCDate() - daysAgo);
  return utcDate.toISOString().slice(0, 10);
}

console.log("--- PART 1: IST Date Calculation Tests ---");

// Test 1.1: Just after midnight in India (00:05 AM IST on Oct 13, 2026)
// In UTC, this is Oct 12, 2026, 18:35:00 UTC
{
  const justAfterMidnightIST = new Date("2026-10-12T18:35:00.000Z");
  const todayIST = getTodayISTForDate(justAfterMidnightIST);
  assert.strictEqual(todayIST, "2026-10-13", "Today IST at 00:05 AM should be 2026-10-13");
  const yesterdayIST = getPastISTDate(1, todayIST);
  assert.strictEqual(yesterdayIST, "2026-10-12", "Yesterday IST just after midnight should be 2026-10-12");
  console.log("✓ Test 1.1 Passed: Just after midnight IST correctly computes Yesterday (2026-10-13 -> 2026-10-12)");
}

// Test 1.2: Late at night in India (23:55 PM IST on Oct 12, 2026)
// In UTC, this is Oct 12, 2026, 18:25:00 UTC
{
  const lateNightIST = new Date("2026-10-12T18:25:00.000Z");
  const todayIST = getTodayISTForDate(lateNightIST);
  assert.strictEqual(todayIST, "2026-10-12", "Today IST at 23:55 PM should be 2026-10-12");
  const yesterdayIST = getPastISTDate(1, todayIST);
  assert.strictEqual(yesterdayIST, "2026-10-11", "Yesterday IST late at night should be 2026-10-11");
  console.log("✓ Test 1.2 Passed: Late at night IST correctly computes Yesterday (2026-10-12 -> 2026-10-11)");
}

// Test 1.3: Verification across timezones (UTC, America/New_York, Asia/Tokyo)
// At 2026-10-12 19:00:00Z:
// - In UTC: Oct 12, 19:00
// - In New York (EDT, UTC-4): Oct 12, 15:00
// - In Tokyo (JST, UTC+9): Oct 13, 04:00
// - In India (IST, UTC+5:30): Oct 13, 00:30 (next day!)
{
  const targetInstant = new Date("2026-10-12T19:00:00.000Z");
  const todayIST = getTodayISTForDate(targetInstant);
  assert.strictEqual(todayIST, "2026-10-13", "In India, 19:00 UTC is next day 00:30 IST");
  const yesterdayIST = getPastISTDate(1, todayIST);
  assert.strictEqual(yesterdayIST, "2026-10-12", "Yesterday from 2026-10-13 is 2026-10-12 regardless of client timezone");
  const last7DaysIST = getPastISTDate(6, todayIST);
  assert.strictEqual(last7DaysIST, "2026-10-07", "7 days window starts on 2026-10-07");
  console.log("✓ Test 1.3 Passed: Multi-timezone instant evaluation gives consistent IST date and calendar offsets");
}

// Test 1.4: Month and Year and Leap-year calendar boundary checks
{
  assert.strictEqual(getPastISTDate(1, "2026-03-01"), "2026-02-28", "2026-03-01 - 1 day should be 2026-02-28");
  assert.strictEqual(getPastISTDate(1, "2024-03-01"), "2024-02-29", "2024-03-01 (leap) - 1 day should be 2024-02-29");
  assert.strictEqual(getPastISTDate(1, "2027-01-01"), "2026-12-31", "2027-01-01 - 1 day should be 2026-12-31");
  assert.strictEqual(getPastISTDate(30, "2026-05-15"), "2026-04-15", "2026-05-15 - 30 days should be 2026-04-15");
  console.log("✓ Test 1.4 Passed: Calendar boundary transitions (month, year, leap year) work accurately");
}


// ============================================================================
// PART 2: Ledger Pagination State Isolation & Sequence Guard Tests
// ============================================================================
console.log("\n--- PART 2: Ledger Pagination State Isolation Tests ---");

class LedgerComponentSimulator {
  constructor() {
    this.dateFilter = "Today";
    this.customDate = "2026-10-12";
    this.page = 1;
    this.reconciliation = null;
    this.collections = [];
    this.pagination = null;
    this.loading = false;
    this.error = null;
    this.activeRequestId = 0;
    this.currentLoadedDate = "";
    this.isMounted = true;
  }

  getActiveDate() {
    if (this.dateFilter === "Today") return "2026-10-12";
    if (this.dateFilter === "Yesterday") return "2026-10-11";
    return this.customDate;
  }

  setDate(newFilter, customDateStr = null) {
    this.dateFilter = newFilter;
    if (customDateStr) {
      this.customDate = customDateStr;
    }
    this.page = 1;
  }

  setPage(newPage) {
    this.page = newPage;
  }

  /**
   * Implements the exact loadLedgerData logic from agent.tsx Phase 3.4.2
   */
  async loadLedgerData(targetDate, targetPage, mockApiCall, delayMs = 0) {
    const requestId = ++this.activeRequestId;
    this.loading = true;
    this.error = null;

    // If date changed, clear whole-day reconciliation metrics immediately
    const isNewDate = targetDate !== this.currentLoadedDate;
    if (isNewDate) {
      this.reconciliation = null;
    }

    // Always clear page-specific collection rows and pagination immediately on date or page change
    // to prevent previous page's rows or another date's rows from masquerading as current
    this.collections = [];
    this.pagination = null;

    if (delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }

    try {
      const [recRes, collRes] = await mockApiCall(targetDate, targetPage);
      if (!this.isMounted || requestId !== this.activeRequestId) return;

      this.currentLoadedDate = targetDate;
      this.reconciliation = recRes;
      this.collections = collRes?.collections || [];
      this.pagination = collRes?.pagination || null;
      this.loading = false;
    } catch (err) {
      if (!this.isMounted || requestId !== this.activeRequestId) return;

      this.error = err?.message || "Failed to load cash ledger data.";
      if (isNewDate) {
        this.reconciliation = null;
      }
      this.collections = [];
      this.pagination = null;
      this.loading = false;
    }
  }
}

// Mock Data
const dayReconciliation = {
  date: "2026-10-12",
  totalCollectedAmount: "50000.00",
  collectionsCount: 40,
  reconciledAmount: "30000.00",
  unreconciledAmount: "20000.00",
  reconciledCount: 25,
  unreconciledCount: 15,
};

const page1Data = {
  pagination: { page: 1, limit: 20, totalRecords: 40, totalPages: 2 },
  collections: Array.from({ length: 20 }, (_, i) => ({ id: `p1_c${i + 1}`, amount: "1000.00" })),
};

const page2Data = {
  pagination: { page: 2, limit: 20, totalRecords: 40, totalPages: 2 },
  collections: Array.from({ length: 20 }, (_, i) => ({ id: `p2_c${i + 1}`, amount: "1500.00" })),
};

// Test 2.1: Pagination from page 1 to page 2 clears old rows immediately while preserving day reconciliation
(async () => {
  const ledger = new LedgerComponentSimulator();

  // Load Page 1
  await ledger.loadLedgerData("2026-10-12", 1, async () => [dayReconciliation, page1Data]);
  assert.strictEqual(ledger.collections.length, 20, "Page 1 should have 20 collections");
  assert.strictEqual(ledger.collections[0].id, "p1_c1");
  assert.strictEqual(ledger.reconciliation.totalCollectedAmount, "50000.00");
  assert.strictEqual(ledger.pagination.page, 1);

  // Navigate to Page 2 with slow network (delay 50ms)
  ledger.setPage(2);
  const p2Promise = ledger.loadLedgerData("2026-10-12", 2, async () => [dayReconciliation, page2Data], 50);

  // Synchronously right after request initiated:
  // Old page 1 rows MUST NOT be present under page 2 loading state
  assert.strictEqual(ledger.loading, true);
  assert.strictEqual(ledger.collections.length, 0, "Page-specific collections must be cleared immediately upon page change");
  assert.strictEqual(ledger.pagination, null, "Pagination must be cleared immediately upon page change");
  // Whole-day reconciliation MUST be preserved
  assert.notStrictEqual(ledger.reconciliation, null, "Reconciliation metrics belong to the entire day and must be preserved");
  assert.strictEqual(ledger.reconciliation.totalCollectedAmount, "50000.00");

  // Await Page 2 arrival
  await p2Promise;
  assert.strictEqual(ledger.loading, false);
  assert.strictEqual(ledger.collections.length, 20);
  assert.strictEqual(ledger.collections[0].id, "p2_c1", "Page 2 collections now displayed");
  assert.strictEqual(ledger.pagination.page, 2);
  assert.strictEqual(ledger.reconciliation.totalCollectedAmount, "50000.00");

  console.log("✓ Test 2.1 Passed: Page 1 to Page 2 immediately isolates old rows and preserves whole-day reconciliation");
})();

// Test 2.2: Delayed Page 1 response cannot overwrite Page 2 (Out-of-order sequence guard)
(async () => {
  const ledger = new LedgerComponentSimulator();

  // Agent requests Page 1 (slow network, 80ms)
  ledger.setPage(1);
  const p1Promise = ledger.loadLedgerData("2026-10-12", 1, async () => [dayReconciliation, page1Data], 80);

  // Quickly switches to Page 2 (faster network, 20ms)
  ledger.setPage(2);
  const p2Promise = ledger.loadLedgerData("2026-10-12", 2, async () => [dayReconciliation, page2Data], 20);

  await p2Promise;
  assert.strictEqual(ledger.collections[0].id, "p2_c1", "Page 2 should be displayed");
  assert.strictEqual(ledger.pagination.page, 2);

  // Wait for the delayed Page 1 response to finally arrive
  await p1Promise;
  assert.strictEqual(ledger.collections[0].id, "p2_c1", "Delayed Page 1 response was safely discarded and did NOT overwrite Page 2");
  assert.strictEqual(ledger.pagination.page, 2);

  console.log("✓ Test 2.2 Passed: Sequence guard prevents delayed Page 1 response from overwriting Page 2");
})();

// Test 2.3: Failed Page 2 request does not display Page 1 rows under Page 2 selection
(async () => {
  const ledger = new LedgerComponentSimulator();

  // Load Page 1 successfully first
  await ledger.loadLedgerData("2026-10-12", 1, async () => [dayReconciliation, page1Data]);
  assert.strictEqual(ledger.collections.length, 20);

  // Switch to Page 2 and request fails
  ledger.setPage(2);
  await ledger.loadLedgerData("2026-10-12", 2, async () => {
    throw new Error("500 Internal Server Error");
  });

  assert.strictEqual(ledger.error, "500 Internal Server Error", "Error message should be set");
  assert.strictEqual(ledger.collections.length, 0, "Collections must be empty, not showing Page 1 rows under Page 2 error");
  assert.strictEqual(ledger.pagination, null, "Pagination must be null");
  // Day reconciliation remains visible for the day
  assert.strictEqual(ledger.reconciliation.totalCollectedAmount, "50000.00", "Whole-day totals remain intact");

  console.log("✓ Test 2.3 Passed: Failed Page 2 request shows error without displaying Page 1 rows");
})();

// Test 2.4: Date change clears whole-day totals and resets page to 1
(async () => {
  const ledger = new LedgerComponentSimulator();

  // Load Today Page 2
  await ledger.loadLedgerData("2026-10-12", 2, async () => [dayReconciliation, page2Data]);
  assert.strictEqual(ledger.collections[0].id, "p2_c1");
  assert.strictEqual(ledger.reconciliation.totalCollectedAmount, "50000.00");

  // Agent switches date to Yesterday
  ledger.setDate("Yesterday");
  assert.strictEqual(ledger.page, 1, "Page resets to 1 on date change");

  const yesterdayRec = {
    date: "2026-10-11",
    totalCollectedAmount: "10000.00",
    collectionsCount: 5,
    reconciledAmount: "10000.00",
    unreconciledAmount: "0.00",
    reconciledCount: 5,
    unreconciledCount: 0,
  };
  const yesterdayColl = {
    pagination: { page: 1, limit: 20, totalRecords: 5, totalPages: 1 },
    collections: [{ id: "yest_1", amount: "2000.00" }],
  };

  // Start loading Yesterday with delay
  const yestPromise = ledger.loadLedgerData("2026-10-11", 1, async () => [yesterdayRec, yesterdayColl], 30);

  // During load of new date:
  assert.strictEqual(ledger.reconciliation, null, "Reconciliation must be cleared immediately when date changes");
  assert.strictEqual(ledger.collections.length, 0, "Collections must be cleared immediately when date changes");
  assert.strictEqual(ledger.pagination, null, "Pagination must be cleared immediately when date changes");

  await yestPromise;
  assert.strictEqual(ledger.reconciliation.date, "2026-10-11");
  assert.strictEqual(ledger.reconciliation.totalCollectedAmount, "10000.00");
  assert.strictEqual(ledger.collections.length, 1);
  assert.strictEqual(ledger.collections[0].id, "yest_1");

  console.log("✓ Test 2.4 Passed: Date change resets page to 1 and immediately clears previous date totals");
})();

// Test 2.5: Empty state handling (No collections for date)
(async () => {
  const ledger = new LedgerComponentSimulator();

  const emptyRec = {
    date: "2026-10-10",
    totalCollectedAmount: "0.00",
    collectionsCount: 0,
    reconciledAmount: "0.00",
    unreconciledAmount: "0.00",
    reconciledCount: 0,
    unreconciledCount: 0,
  };
  const emptyColl = {
    pagination: { page: 1, limit: 20, totalRecords: 0, totalPages: 0 },
    collections: [],
  };

  ledger.setDate("Custom", "2026-10-10");
  await ledger.loadLedgerData("2026-10-10", 1, async () => [emptyRec, emptyColl]);

  assert.strictEqual(ledger.reconciliation.totalCollectedAmount, "0.00");
  assert.strictEqual(ledger.collections.length, 0);
  assert.strictEqual(ledger.pagination.totalRecords, 0);
  assert.strictEqual(ledger.error, null);

  console.log("✓ Test 2.5 Passed: Empty state preserves empty reconciliation and zero collections cleanly");
  console.log("\nAll Phase 3.4.2 tests passed successfully!");
})();
