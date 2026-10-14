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

console.log('Starting Phase 3.3.1 Receipt Selection & Payment Status Verification Suite...\n');

// 1. Storage and Helper Functions (mirroring agent-api.ts)
let activeLatestReceipt = null;
let activeViewingReceipt = null;

function setLatestCollectionReceipt(receipt) {
  activeLatestReceipt = receipt;
  if (receipt) {
    window.sessionStorage.setItem("speedmoney_latest_receipt", JSON.stringify(receipt));
  } else {
    window.sessionStorage.removeItem("speedmoney_latest_receipt");
  }
}

function getLatestCollectionReceipt() {
  if (activeLatestReceipt) return activeLatestReceipt;
  const stored = window.sessionStorage.getItem("speedmoney_latest_receipt");
  if (stored) {
    activeLatestReceipt = JSON.parse(stored);
    return activeLatestReceipt;
  }
  return null;
}

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

function getReceiptStatusLabel(status) {
  if (!status || typeof status !== "string") {
    return "UNKNOWN";
  }
  const normalized = status.trim().toUpperCase();
  switch (normalized) {
    case "SUCCESS":
      return "PAID";
    case "PENDING":
      return "PENDING";
    case "FAILED":
      return "FAILED";
    case "REFUNDED":
      return "REFUNDED";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return "UNKNOWN";
  }
}

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
    paymentStatus: item.payment?.status || "",
    notes: item.notes || null,
    reconciled: Boolean(item.reconciled),
    reconciledAt: item.reconciledAt || null,
    emiStatus: item.emi?.status,
    loanStatus: item.loan?.status,
    remainingLoanBalance: null,
    source: "history",
  };
}

function mapCollectionResponseToHistoricalReceipt(res) {
  const remaining = res.loan?.outstandingAmount
    ? parseFloat(res.loan.outstandingAmount)
    : null;

  return {
    receiptNumber: res.receiptNumber,
    paymentId: res.paymentId || res.payment?.id,
    transactionId: "",
    loanId: res.loanId || res.loan?.id,
    loanNumber: res.loanNumber || res.loan?.loanNumber || res.loanId,
    installmentNo: res.installmentNo || res.emi?.installmentNo || 0,
    customerName: res.customerName || "Customer",
    customerPhone: res.customerPhone || null,
    collectedAmount: res.collectedAmount || res.payment?.amount || "0",
    collectedAt: res.collectedAt || res.payment?.paidAt,
    paymentMode: res.payment?.mode || "CASH",
    paymentStatus: res.payment?.status || "",
    notes: res.notes || null,
    reconciled: Boolean(res.reconciled),
    reconciledAt: null,
    emiStatus: res.emi?.status,
    loanStatus: res.loan?.status,
    remainingLoanBalance: remaining,
    source: "collection",
  };
}

// Receipt screen resolver helper
function resolveCurrentReceipt() {
  const viewing = getViewingReceipt();
  const latest = getLatestCollectionReceipt();
  return viewing || (latest ? mapCollectionResponseToHistoricalReceipt(latest) : null);
}

// Mock items
const receiptA_Historical = {
  id: "coll-A",
  receiptNumber: "RCPT-OLD-A001",
  collectedAmount: "1500.00",
  collectedAt: "2026-10-10T10:00:00.000Z",
  reconciled: true,
  reconciledAt: "2026-10-10T12:00:00.000Z",
  notes: "Collected at shop A",
  payment: {
    id: "pay-A",
    amount: "1500.00",
    mode: "CASH",
    status: "SUCCESS",
    transactionId: "CASH-agent-A",
    paidAt: "2026-10-10T10:00:00.000Z",
  },
  loan: {
    id: "loan-A",
    loanNumber: "LN-A001",
    status: "ACTIVE",
  },
  emi: {
    id: "emi-A",
    installmentNo: 1,
    dueDate: "2026-10-10T00:00:00.000Z",
    status: "PAID",
  },
  customer: {
    name: "Customer Alpha",
    phone: "9999999991",
  },
};

const receiptB_NewResponse = {
  success: true,
  message: "Cash collection recorded successfully",
  duplicate: false,
  paymentId: "pay-B",
  receiptNumber: "RCPT-NEW-B002",
  loanId: "loan-B",
  loanNumber: "LN-B002",
  emiId: "emi-B",
  installmentNo: 4,
  collectedAmount: "4500.00",
  collectedAt: "2026-10-12T15:00:00.000Z",
  notes: "Collected at house B",
  reconciled: false,
  customerName: "Customer Beta",
  customerPhone: "9999999992",
  payment: {
    id: "pay-B",
    receiptNumber: "RCPT-NEW-B002",
    amount: "4500.00",
    mode: "CASH",
    status: "SUCCESS",
    paidAt: "2026-10-12T15:00:00.000Z",
  },
  emi: {
    id: "emi-B",
    installmentNo: 4,
    status: "PAID",
    paidAmount: "4500.00",
    outstandingAmount: "0.00",
    paidAt: "2026-10-12T15:00:00.000Z",
  },
  loan: {
    id: "loan-B",
    loanNumber: "LN-B002",
    outstandingAmount: "9000.00",
    status: "ACTIVE",
  },
};

// -------------------------------------------------------------
// Test 1: Full Sequence Verification
// -------------------------------------------------------------
console.log("Test 1: Full Sequence - Old Receipt A -> History -> New Collection B -> Open B -> Reopen A");

// Step 1: User opens old receipt A from History
setViewingReceipt(mapCollectionItemToHistoricalReceipt(receiptA_Historical));
let activeReceipt = resolveCurrentReceipt();
assert.ok(activeReceipt !== null);
assert.strictEqual(activeReceipt.receiptNumber, "RCPT-OLD-A001");
assert.strictEqual(activeReceipt.customerName, "Customer Alpha");
assert.strictEqual(activeReceipt.source, "history");
console.log("  Step 1 PASS: Receipt A opened from History and rendered accurately.");

// Step 2: User returns to History (viewing selection is NOT cleared simply by returning/rendering)
activeReceipt = resolveCurrentReceipt();
assert.strictEqual(activeReceipt.receiptNumber, "RCPT-OLD-A001");
console.log("  Step 2 PASS: Viewing receipt A preserved while navigating.");

// Step 3: Complete separately confirmed collection B
// handleConfirmPayment runs:
//   setLatestCollectionReceipt(receiptB);
//   setViewingReceipt(null);
setLatestCollectionReceipt(receiptB_NewResponse);
setViewingReceipt(null);

// Step 4: Open B's receipt
activeReceipt = resolveCurrentReceipt();
assert.ok(activeReceipt !== null);
assert.strictEqual(activeReceipt.receiptNumber, "RCPT-NEW-B002", "Receipt B must be displayed, not stale receipt A!");
assert.strictEqual(activeReceipt.customerName, "Customer Beta");
assert.strictEqual(activeReceipt.collectedAmount, "4500.00");
assert.strictEqual(activeReceipt.source, "collection");
console.log("  Step 4 PASS: New collection B's receipt displayed with precedence over stale historical selection.");

// Step 5: Refresh page while viewing receipt B
activeLatestReceipt = null;
activeViewingReceipt = null;
activeReceipt = resolveCurrentReceipt();
assert.strictEqual(activeReceipt.receiptNumber, "RCPT-NEW-B002");
console.log("  Step 5 PASS: Refreshing on new collection B keeps receipt B visible from storage.");

// Step 6: User returns to History and opens receipt A again
setViewingReceipt(mapCollectionItemToHistoricalReceipt(receiptA_Historical));
activeReceipt = resolveCurrentReceipt();
assert.strictEqual(activeReceipt.receiptNumber, "RCPT-OLD-A001");
assert.strictEqual(activeReceipt.customerName, "Customer Alpha");
assert.strictEqual(activeReceipt.source, "history");
console.log("  Step 6 PASS: Opening receipt A again from History correctly displays A.");

// Step 7: Refresh page while viewing receipt A
activeLatestReceipt = null;
activeViewingReceipt = null;
activeReceipt = resolveCurrentReceipt();
assert.strictEqual(activeReceipt.receiptNumber, "RCPT-OLD-A001");
console.log("  Step 7 PASS: Refreshing on historical receipt A keeps receipt A visible from storage.");

// -------------------------------------------------------------
// Test 2: Authoritative Payment Status Stamp Mapping
// -------------------------------------------------------------
console.log("\nTest 2: Authoritative Payment Status Stamp Mapping");

assert.strictEqual(getReceiptStatusLabel("SUCCESS"), "PAID");
assert.strictEqual(getReceiptStatusLabel("success"), "PAID");
assert.strictEqual(getReceiptStatusLabel("  SUCCESS  "), "PAID");
console.log("  PASS: SUCCESS status maps strictly to 'PAID'.");

assert.strictEqual(getReceiptStatusLabel("PENDING"), "PENDING");
assert.strictEqual(getReceiptStatusLabel("pending"), "PENDING");
console.log("  PASS: PENDING status maps to 'PENDING'.");

assert.strictEqual(getReceiptStatusLabel("FAILED"), "FAILED");
assert.strictEqual(getReceiptStatusLabel("failed"), "FAILED");
console.log("  PASS: FAILED status maps to 'FAILED'.");

assert.strictEqual(getReceiptStatusLabel("REFUNDED"), "REFUNDED");
assert.strictEqual(getReceiptStatusLabel("refunded"), "REFUNDED");
console.log("  PASS: REFUNDED status maps to 'REFUNDED'.");

assert.strictEqual(getReceiptStatusLabel("CANCELLED"), "CANCELLED");
assert.strictEqual(getReceiptStatusLabel("cancelled"), "CANCELLED");
console.log("  PASS: CANCELLED status maps to 'CANCELLED'.");

assert.strictEqual(getReceiptStatusLabel(null), "UNKNOWN");
assert.strictEqual(getReceiptStatusLabel(undefined), "UNKNOWN");
assert.strictEqual(getReceiptStatusLabel(""), "UNKNOWN");
assert.strictEqual(getReceiptStatusLabel("PROCESSING"), "UNKNOWN");
assert.strictEqual(getReceiptStatusLabel("INVALID_STATUS"), "UNKNOWN");
console.log("  PASS: Null, undefined, empty, and unrecognized statuses map to neutral 'UNKNOWN'.");

// -------------------------------------------------------------
// Test 3: Do not infer success from receipt number alone
// -------------------------------------------------------------
console.log("\nTest 3: No inference of success without authoritative status");

const nonSuccessItem = {
  id: "coll-fail",
  receiptNumber: "RCPT-FAIL-001",
  collectedAmount: "1000.00",
  payment: {
    status: "FAILED",
  },
};
const mappedFail = mapCollectionItemToHistoricalReceipt(nonSuccessItem);
assert.strictEqual(mappedFail.paymentStatus, "FAILED");
assert.strictEqual(getReceiptStatusLabel(mappedFail.paymentStatus), "FAILED");
assert.notStrictEqual(getReceiptStatusLabel(mappedFail.paymentStatus), "PAID");
console.log("  PASS: Collection with FAILED payment status displays 'FAILED', not 'PAID'.");

const absentStatusItem = {
  id: "coll-absent",
  receiptNumber: "RCPT-NO-STATUS-002",
  collectedAmount: "1000.00",
  payment: null,
};
const mappedAbsent = mapCollectionItemToHistoricalReceipt(absentStatusItem);
assert.strictEqual(mappedAbsent.paymentStatus, "");
assert.strictEqual(getReceiptStatusLabel(mappedAbsent.paymentStatus), "UNKNOWN");
console.log("  PASS: Collection with absent payment status displays 'UNKNOWN', not 'PAID'.");

console.log("\nALL PHASE 3.3.1 VERIFICATION TESTS PASSED SUCCESSFULLY!");
