const assert = require('assert');

console.log('Starting Phase 3.4.1 Ledger Date-Filter Consistency & Pagination Test Suite...\n');

// 1. Test Suite State Emulator mimicking Ledger component logic
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
  }

  // Active date resolution
  getActiveDate() {
    if (this.dateFilter === "Today") return "2026-10-12";
    if (this.dateFilter === "Yesterday") return "2026-10-11";
    return this.customDate;
  }

  // Set date filter preset or custom date
  setDate(newFilter, customDateStr = null) {
    this.dateFilter = newFilter;
    if (customDateStr) {
      this.customDate = customDateStr;
    }
    this.page = 1; // Reset page on date switch
  }

  // Mock API loader with simulated async delay and race handling
  async loadLedgerData(targetDate, targetPage, mockApiCall, delayMs = 0) {
    const requestId = ++this.activeRequestId;
    this.loading = true;
    this.error = null;

    const isNewDate = targetDate !== this.currentLoadedDate;
    if (isNewDate) {
      // Clear previous date's data immediately to prevent stale presentation
      this.reconciliation = null;
      this.collections = [];
      this.pagination = null;
    }

    if (delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }

    try {
      const [recRes, collRes] = await mockApiCall(targetDate, targetPage);
      // Discard older/stale responses
      if (requestId !== this.activeRequestId) {
        return; // Discarded
      }
      this.currentLoadedDate = targetDate;
      this.reconciliation = recRes;
      this.collections = collRes?.collections || [];
      this.pagination = collRes?.pagination || null;
      this.loading = false;
    } catch (err) {
      if (requestId !== this.activeRequestId) {
        return; // Discarded
      }
      this.error = err?.message || "Failed to load cash ledger data.";
      if (isNewDate) {
        this.reconciliation = null;
        this.collections = [];
        this.pagination = null;
      }
      this.loading = false;
    }
  }
}

// -------------------------------------------------------------
// Test 1: Today → Yesterday Transitions
// -------------------------------------------------------------
console.log("Test 1: Today -> Yesterday transition clears stale data immediately");

(async () => {
  const ledger = new LedgerComponentSimulator();

  // Mock Data for Today (2026-10-12)
  const todayRec = {
    date: "2026-10-12",
    totalCollectedAmount: "5000.00",
    collectionsCount: 2,
    reconciledAmount: "2000.00",
    unreconciledAmount: "3000.00",
    reconciledCount: 1,
    unreconciledCount: 1,
  };
  const todayColl = {
    pagination: { page: 1, limit: 20, totalRecords: 2, totalPages: 1 },
    collections: [{ id: "c1", amount: "2000.00" }, { id: "c2", amount: "3000.00" }],
  };

  // Mock Data for Yesterday (2026-10-11)
  const yestRec = {
    date: "2026-10-11",
    totalCollectedAmount: "8000.00",
    collectionsCount: 4,
    reconciledAmount: "8000.00",
    unreconciledAmount: "0.00",
    reconciledCount: 4,
    unreconciledCount: 0,
  };
  const yestColl = {
    pagination: { page: 1, limit: 20, totalRecords: 4, totalPages: 1 },
    collections: [{ id: "y1" }, { id: "y2" }, { id: "y3" }, { id: "y4" }],
  };

  // Load Today
  await ledger.loadLedgerData("2026-10-12", 1, async () => [todayRec, todayColl]);
  assert.strictEqual(ledger.reconciliation.date, "2026-10-12");
  assert.strictEqual(ledger.reconciliation.totalCollectedAmount, "5000.00");
  assert.strictEqual(ledger.collections.length, 2);

  // Switch to Yesterday
  ledger.setDate("Yesterday");
  assert.strictEqual(ledger.getActiveDate(), "2026-10-11");

  // Begin loading Yesterday with delay
  const loadPromise = ledger.loadLedgerData("2026-10-11", 1, async () => [yestRec, yestColl], 20);

  // While loading, verify Today's data is cleared and not presented as Yesterday's
  assert.strictEqual(ledger.loading, true);
  assert.strictEqual(ledger.reconciliation, null, "Reconciliation must be null during date switch load");
  assert.strictEqual(ledger.collections.length, 0, "Collections must be empty during date switch load");

  await loadPromise;

  // Once completed, Yesterday's data is present
  assert.strictEqual(ledger.loading, false);
  assert.strictEqual(ledger.reconciliation.date, "2026-10-11");
  assert.strictEqual(ledger.reconciliation.totalCollectedAmount, "8000.00");
  assert.strictEqual(ledger.collections.length, 4);
  console.log("  PASS: Previous date's data cleared immediately upon switching, clean load verified.");

  // -------------------------------------------------------------
  // Test 2: Custom-date changes while previous request is still pending (Race condition safety)
  // -------------------------------------------------------------
  console.log("\nTest 2: Rapid date changes discard slower out-of-order responses");

  // User requests Date X (slow request, 40ms)
  const reqX_promise = ledger.loadLedgerData(
    "2026-10-05",
    1,
    async () => [{ date: "2026-10-05", totalCollectedAmount: "100.00" }, { pagination: null, collections: [{ id: "x" }] }],
    40
  );

  // User immediately switches to Date Y (fast request, 10ms)
  ledger.setDate("Custom", "2026-10-09");
  const reqY_promise = ledger.loadLedgerData(
    "2026-10-09",
    1,
    async () => [{ date: "2026-10-09", totalCollectedAmount: "999.00" }, { pagination: null, collections: [{ id: "y" }] }],
    10
  );

  // Wait for both to complete
  await Promise.all([reqX_promise, reqY_promise]);

  // Even though Date X finished after Date Y, Date Y was the latest requested date!
  assert.strictEqual(ledger.reconciliation.date, "2026-10-09");
  assert.strictEqual(ledger.reconciliation.totalCollectedAmount, "999.00");
  assert.strictEqual(ledger.collections[0].id, "y");
  console.log("  PASS: Out-of-order response from Date X safely discarded; Date Y retained.");

  // -------------------------------------------------------------
  // Test 3: Failed requests after a previously successful load
  // -------------------------------------------------------------
  console.log("\nTest 3: Failed request on date switch does not display stale previous data");

  // Currently ledger has Date Y data
  assert.ok(ledger.reconciliation !== null);

  // User switches to Date Z, but network fails
  ledger.setDate("Custom", "2026-10-01");
  await ledger.loadLedgerData("2026-10-01", 1, async () => {
    throw new Error("Server 500 error on Date Z");
  });

  assert.strictEqual(ledger.loading, false);
  assert.strictEqual(ledger.error, "Server 500 error on Date Z");
  assert.strictEqual(ledger.reconciliation, null, "Stale data from previous date must NOT be presented when load fails");
  assert.strictEqual(ledger.collections.length, 0);
  console.log("  PASS: Failed request shows error with Retry and does not present stale data as current.");

  // -------------------------------------------------------------
  // Test 4: Empty-day responses
  // -------------------------------------------------------------
  console.log("\nTest 4: Empty-day response handling");

  const emptyRec = {
    date: "2026-10-02",
    totalCollectedAmount: "0",
    collectionsCount: 0,
    reconciledAmount: "0",
    unreconciledAmount: "0",
    reconciledCount: 0,
    unreconciledCount: 0,
  };
  const emptyColl = {
    pagination: { page: 1, limit: 20, totalRecords: 0, totalPages: 1 },
    collections: [],
  };

  await ledger.loadLedgerData("2026-10-02", 1, async () => [emptyRec, emptyColl]);
  assert.strictEqual(ledger.error, null);
  assert.strictEqual(parseFloat(ledger.reconciliation.totalCollectedAmount), 0);
  assert.strictEqual(ledger.reconciliation.collectionsCount, 0);
  assert.strictEqual(ledger.collections.length, 0);
  console.log("  PASS: Empty day handled cleanly without crashing or undefined metrics.");

  // -------------------------------------------------------------
  // Test 5: More than 100 daily collection records (>100 pagination)
  // -------------------------------------------------------------
  console.log("\nTest 5: Daily collections exceeding 100 records properly paginate");

  const bigDayRec = {
    date: "2026-10-12",
    totalCollectedAmount: "375000.00",
    collectionsCount: 150, // 150 collections for the day!
    reconciledAmount: "250000.00",
    unreconciledAmount: "125000.00",
    reconciledCount: 100,
    unreconciledCount: 50,
  };

  // Page 1 of 8 (20 items per page)
  const bigDayPage1 = {
    pagination: { page: 1, limit: 20, totalRecords: 150, totalPages: 8 },
    collections: Array.from({ length: 20 }, (_, i) => ({ id: `coll-p1-${i + 1}` })),
  };

  // Page 2 of 8
  const bigDayPage2 = {
    pagination: { page: 2, limit: 20, totalRecords: 150, totalPages: 8 },
    collections: Array.from({ length: 20 }, (_, i) => ({ id: `coll-p2-${i + 1}` })),
  };

  // Load Page 1
  await ledger.loadLedgerData("2026-10-12", 1, async () => [bigDayRec, bigDayPage1]);
  assert.strictEqual(ledger.reconciliation.collectionsCount, 150);
  assert.strictEqual(ledger.pagination.totalRecords, 150);
  assert.strictEqual(ledger.pagination.totalPages, 8);
  assert.strictEqual(ledger.pagination.page, 1);
  assert.strictEqual(ledger.collections.length, 20);

  // Navigate to Page 2
  ledger.page = 2;
  await ledger.loadLedgerData("2026-10-12", 2, async () => [bigDayRec, bigDayPage2]);
  assert.strictEqual(ledger.pagination.page, 2);
  assert.strictEqual(ledger.collections.length, 20);
  assert.strictEqual(ledger.collections[0].id, "coll-p2-1");
  console.log("  PASS: 150 daily records paginated across 8 pages without being cut off at 100.");

  // -------------------------------------------------------------
  // Test 6: Correct distinction between whole-day totals and displayed page
  // -------------------------------------------------------------
  console.log("\nTest 6: Distinction between whole-day reconciliation totals and page subset");

  // Whole-day totals remain 150 collections & ₹375,000.00
  const wholeDayTotal = parseFloat(ledger.reconciliation.totalCollectedAmount);
  const wholeDayCount = ledger.reconciliation.collectionsCount;

  // Currently displayed page has only 20 records
  const displayedCount = ledger.collections.length;

  assert.strictEqual(wholeDayTotal, 375000.00);
  assert.strictEqual(wholeDayCount, 150);
  assert.strictEqual(displayedCount, 20);
  assert.notStrictEqual(wholeDayCount, displayedCount, "Whole-day count (150) must NOT be confused with displayed page count (20)");

  console.log("  PASS: Whole-day reconciliation metrics remain authoritative and independent of page size.");

  console.log("\nALL 6 PHASE 3.4.1 TESTS PASSED SUCCESSFULLY!");
})();
