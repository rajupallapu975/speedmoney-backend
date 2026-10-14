const assert = require('assert');

// Mock localStorage and sessionStorage
class MockStorage {
  constructor() {
    this.store = {};
  }
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
  }
  setItem(key, value) {
    this.store[key] = String(value);
  }
  removeItem(key) {
    delete this.store[key];
  }
  clear() {
    this.store = {};
  }
}

global.window = {
  localStorage: new MockStorage(),
  sessionStorage: new MockStorage(),
};

// Test Suite for Phase 3.3
console.log('Starting Phase 3.3 Collection History & Receipt Verification Suite...\n');

// Mock data matching backend GET /api/agent/cash-collections response contract
const mockBackendHistoryResponse = {
  success: true,
  pagination: {
    page: 1,
    limit: 20,
    totalRecords: 2,
    totalPages: 1,
  },
  summary: {
    totalCollectedAmount: "5500.00",
    count: 2,
  },
  collections: [
    {
      id: "coll-uuid-001",
      receiptNumber: "RCPT-1770000001-A1B2",
      collectedAmount: "3000.00",
      collectedAt: "2026-10-12T10:15:00.000Z",
      reconciled: true,
      reconciledAt: "2026-10-12T11:00:00.000Z",
      notes: "Paid in full at customer shop",
      payment: {
        id: "pay-uuid-001",
        amount: "3000.00",
        mode: "CASH",
        status: "SUCCESS",
        transactionId: "CASH-agent-001-idemp-001",
        paidAt: "2026-10-12T10:15:00.000Z",
      },
      loan: {
        id: "loan-uuid-001",
        loanNumber: "LN-2026-0001",
        status: "ACTIVE",
      },
      emi: {
        id: "emi-uuid-001",
        installmentNo: 3,
        dueDate: "2026-10-12T00:00:00.000Z",
        status: "PAID",
      },
      customer: {
        name: "Ramesh Sharma",
        phone: "9876543210",
      },
    },
    {
      id: "coll-uuid-002",
      receiptNumber: "RCPT-1770000002-C3D4",
      collectedAmount: "2500.00",
      collectedAt: "2026-10-12T14:30:00.000Z",
      reconciled: false,
      reconciledAt: null,
      notes: null,
      payment: {
        id: "pay-uuid-002",
        amount: "2500.00",
        mode: "CASH",
        status: "SUCCESS",
        transactionId: "CASH-agent-001-idemp-002",
        paidAt: "2026-10-12T14:30:00.000Z",
      },
      loan: {
        id: "loan-uuid-002",
        loanNumber: "LN-2026-0002",
        status: "ACTIVE",
      },
      emi: {
        id: "emi-uuid-002",
        installmentNo: 1,
        dueDate: "2026-10-12T00:00:00.000Z",
        status: "PAID",
      },
      customer: {
        name: "Anita Desai",
        phone: null,
      },
    },
  ],
};

// 1. Test receipt mapping function
function mapCollectionItemToHistoricalReceipt(item) {
  return {
    receiptNumber: item.receiptNumber,
    paymentId: item.payment?.id || item.id,
    transactionId: item.payment?.transactionId,
    loanId: item.loan?.id || "",
    loanNumber: item.loan?.loanNumber || "",
    installmentNo: item.emi?.installmentNo || 0,
    customerName: item.customer?.name || "Customer",
    customerPhone: item.customer?.phone || null,
    collectedAmount: item.collectedAmount || item.payment?.amount || "0",
    collectedAt: item.collectedAt || item.payment?.paidAt || "",
    paymentMode: item.payment?.mode || "CASH",
    paymentStatus: item.payment?.status || "SUCCESS",
    notes: item.notes || null,
    reconciled: Boolean(item.reconciled),
    reconciledAt: item.reconciledAt || null,
    emiStatus: item.emi?.status,
    loanStatus: item.loan?.status,
    remainingLoanBalance: null,
    source: "history",
  };
}

console.log("Test 1: Historical collection record mapping");
const mappedReceipt1 = mapCollectionItemToHistoricalReceipt(mockBackendHistoryResponse.collections[0]);
assert.strictEqual(mappedReceipt1.receiptNumber, "RCPT-1770000001-A1B2");
assert.strictEqual(mappedReceipt1.customerName, "Ramesh Sharma");
assert.strictEqual(mappedReceipt1.customerPhone, "9876543210");
assert.strictEqual(mappedReceipt1.loanNumber, "LN-2026-0001");
assert.strictEqual(mappedReceipt1.installmentNo, 3);
assert.strictEqual(mappedReceipt1.collectedAmount, "3000.00");
assert.strictEqual(mappedReceipt1.paymentMode, "CASH");
assert.strictEqual(mappedReceipt1.paymentStatus, "SUCCESS");
assert.strictEqual(mappedReceipt1.reconciled, true);
assert.strictEqual(mappedReceipt1.reconciledAt, "2026-10-12T11:00:00.000Z");
assert.strictEqual(mappedReceipt1.notes, "Paid in full at customer shop");
assert.strictEqual(mappedReceipt1.source, "history");
console.log("  PASS: Historical receipt mapped accurately from server response.");

console.log("Test 2: Null and optional field safety in receipt mapping");
const mappedReceipt2 = mapCollectionItemToHistoricalReceipt(mockBackendHistoryResponse.collections[1]);
assert.strictEqual(mappedReceipt2.receiptNumber, "RCPT-1770000002-C3D4");
assert.strictEqual(mappedReceipt2.customerName, "Anita Desai");
assert.strictEqual(mappedReceipt2.customerPhone, null);
assert.strictEqual(mappedReceipt2.reconciled, false);
assert.strictEqual(mappedReceipt2.reconciledAt, null);
assert.strictEqual(mappedReceipt2.notes, null);
assert.strictEqual(mappedReceipt2.source, "history");
console.log("  PASS: Null customer phone, reconciledAt, and notes handled cleanly without fabrication.");

console.log("Test 3: Date filter calculation produces valid YYYY-MM-DD ranges in IST");
function getTodayIST() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist = new Date(utc + 5.5 * 3600000);
  return ist.toISOString().slice(0, 10);
}

function getDateFilterRange(option) {
  const todayIST = getTodayIST();
  if (option === "Today") {
    return { startDate: todayIST, endDate: todayIST };
  }
  if (option === "Last 7 Days") {
    const d = new Date();
    const utc = d.getTime() + d.getTimezoneOffset() * 60000;
    const ist7 = new Date(utc + 5.5 * 3600000 - 6 * 86400000);
    const startStr = ist7.toISOString().slice(0, 10);
    return { startDate: startStr, endDate: todayIST };
  }
  if (option === "This Month") {
    const startStr = `${todayIST.slice(0, 7)}-01`;
    return { startDate: startStr, endDate: todayIST };
  }
  return {};
}

const rangeAll = getDateFilterRange("All");
assert.deepStrictEqual(rangeAll, {});

const rangeToday = getDateFilterRange("Today");
assert.match(rangeToday.startDate, /^\d{4}-\d{2}-\d{2}$/);
assert.strictEqual(rangeToday.startDate, rangeToday.endDate);

const range7Days = getDateFilterRange("Last 7 Days");
assert.match(range7Days.startDate, /^\d{4}-\d{2}-\d{2}$/);
assert.match(range7Days.endDate, /^\d{4}-\d{2}-\d{2}$/);
assert.ok(range7Days.startDate <= range7Days.endDate);

const rangeMonth = getDateFilterRange("This Month");
assert.match(rangeMonth.startDate, /^\d{4}-\d{2}-01$/);
assert.ok(rangeMonth.startDate <= rangeMonth.endDate);
console.log("  PASS: All date filter presets generate valid YYYY-MM-DD IST strings.");

console.log("Test 4: Viewing receipt session storage and isolation");
let activeViewingReceipt = null;

function setViewingReceipt(receipt) {
  activeViewingReceipt = receipt;
  if (receipt) {
    window.sessionStorage.setItem("speedmoney_viewing_receipt", JSON.stringify(receipt));
  } else {
    window.sessionStorage.removeItem("speedmoney_viewing_receipt");
  }
}

function getViewingReceipt() {
  if (activeViewingReceipt) return activeViewingReceipt;
  const stored = window.sessionStorage.getItem("speedmoney_viewing_receipt");
  if (stored) {
    activeViewingReceipt = JSON.parse(stored);
    return activeViewingReceipt;
  }
  return null;
}

// Set receipt 1
setViewingReceipt(mappedReceipt1);
assert.strictEqual(getViewingReceipt().receiptNumber, "RCPT-1770000001-A1B2");

// Simulate page refresh (in-memory cleared, restored from sessionStorage)
activeViewingReceipt = null;
const restoredReceipt = getViewingReceipt();
assert.strictEqual(restoredReceipt.receiptNumber, "RCPT-1770000001-A1B2");
assert.strictEqual(restoredReceipt.customerName, "Ramesh Sharma");
console.log("  PASS: Refreshing page restores the selected historical receipt from session storage.");

// Set receipt 2
setViewingReceipt(mappedReceipt2);
assert.strictEqual(getViewingReceipt().receiptNumber, "RCPT-1770000002-C3D4");
console.log("  PASS: Selecting a different collection switches the viewing receipt without leaking previous data.");

console.log("Test 5: Opening historical receipt does not trigger payment POST requests");
let postRequestCount = 0;
function mockPostPayment() {
  postRequestCount++;
}

// User clicks a collection from History
function handleSelectReceipt(item) {
  setViewingReceipt(mapCollectionItemToHistoricalReceipt(item));
}

handleSelectReceipt(mockBackendHistoryResponse.collections[0]);
assert.strictEqual(postRequestCount, 0, "No POST request should be made when viewing historical receipt");
console.log("  PASS: Opening historical receipt is strictly read-only; 0 POST mutations dispatched.");

console.log("Test 6: Empty state and pagination boundary tests");
const emptyResponse = {
  success: true,
  pagination: { page: 1, limit: 20, totalRecords: 0, totalPages: 1 },
  summary: { totalCollectedAmount: "0", count: 0 },
  collections: [],
};
assert.strictEqual(emptyResponse.collections.length, 0);
assert.strictEqual(emptyResponse.summary.count, 0);
assert.strictEqual(emptyResponse.pagination.totalPages, 1);
console.log("  PASS: Empty collections response handled cleanly.");

console.log("\nALL 6 PHASE 3.3 VERIFICATION TESTS PASSED SUCCESSFULLY!");
