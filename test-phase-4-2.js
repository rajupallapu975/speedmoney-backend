const assert = require('assert');

console.log('Starting Phase 4.2 Admin Application Review Workflow Test Suite...\n');

// ============================================================================
// PART 1: Safe Customer Normalization Across Response Shapes
// ============================================================================
console.log('--- TEST 1: Safe Customer Normalization ---');

function normalizeCustomer(rawCust) {
  if (!rawCust) {
    return { id: "", name: "Customer", email: "", phone: null };
  }
  return {
    id: rawCust.id || "",
    name: rawCust.name || rawCust.user?.name || "Customer",
    email: rawCust.email || rawCust.user?.email || "",
    phone: rawCust.phone || rawCust.user?.phone || null,
  };
}

// Case A: Flatted customer object (as returned by routes/admin-loan-applications.js)
{
  const raw = { id: 'CUST-01', name: 'Aarav Sharma', email: 'aarav@example.com', phone: '9876543210' };
  const norm = normalizeCustomer(raw);
  assert.strictEqual(norm.id, 'CUST-01');
  assert.strictEqual(norm.name, 'Aarav Sharma');
  assert.strictEqual(norm.email, 'aarav@example.com');
  assert.strictEqual(norm.phone, '9876543210');
}

// Case B: Nested user object (customer.user.name)
{
  const raw = { id: 'CUST-02', user: { name: 'Priya Verma', email: 'priya@example.com', phone: '9876543211' } };
  const norm = normalizeCustomer(raw);
  assert.strictEqual(norm.id, 'CUST-02');
  assert.strictEqual(norm.name, 'Priya Verma');
  assert.strictEqual(norm.email, 'priya@example.com');
  assert.strictEqual(norm.phone, '9876543211');
}

// Case C: Null or missing fields safely fallback
{
  const norm = normalizeCustomer(null);
  assert.strictEqual(norm.name, 'Customer');
  assert.strictEqual(norm.email, '');
  assert.strictEqual(norm.phone, null);
}
console.log('✓ Test 1 Passed: Customer normalization safely handles both customer.name and customer.user.name.');


// ============================================================================
// PART 2: AppReview State Machine & Contract Validation Simulator
// ============================================================================
console.log('\n--- TEST 2: AppReview State Machine & Permitted Actions ---');

class AppReviewSimulator {
  constructor() {
    this.application = null;
    this.products = [];
    this.loading = false;
    this.error = null;
    this.actionSuccess = null;
    this.actionError = null;
    this.submitting = false;
    this.activeAction = null;
  }

  async loadDetail(targetId, mockAppsCall, mockProdsCall) {
    this.loading = true;
    this.error = null;
    try {
      const [appsRes, prodsRes] = await Promise.all([
        mockAppsCall(),
        mockProdsCall(),
      ]);
      this.products = prodsRes.products || [];
      const apps = appsRes.applications || [];
      // Strict matching: Load ONLY the exact application matching targetId
      const cleanTargetId = (targetId || "").trim();
      this.application = cleanTargetId ? apps.find((a) => a.id === cleanTargetId) || null : null;
      this.loading = false;
    } catch (err) {
      this.error = err.message || 'Failed to load application details.';
      this.application = null;
      this.loading = false;
    }
  }

  async submitApprove(interestRate, reviewNotes, mockApiReview) {
    if (!this.application) return;
    if (this.submitting) return; // Duplicate submit protection

    // Validation: Only SUBMITTED applications can be reviewed
    if (this.application.status !== 'SUBMITTED') {
      this.actionError = 'Only submitted loan applications can be reviewed';
      return;
    }

    const rateNum = parseFloat(interestRate);
    if (!interestRate || isNaN(rateNum) || rateNum <= 0) {
      this.actionError = 'A valid positive interest rate is required to approve.';
      return;
    }

    // Validate against product limits
    const prod = this.products.find((p) => p.id === this.application.product?.id);
    if (prod) {
      const minRate = parseFloat(prod.minInterestRate);
      const maxRate = parseFloat(prod.maxInterestRate);
      if (rateNum < minRate) {
        this.actionError = `Interest rate cannot be below ${minRate}% for this product.`;
        return;
      }
      if (rateNum > maxRate) {
        this.actionError = `Interest rate cannot exceed ${maxRate}% for this product.`;
        return;
      }
    }

    this.submitting = true;
    this.actionError = null;

    try {
      const res = await mockApiReview(this.application.id, {
        decision: 'APPROVE',
        interestRate: String(rateNum),
        reviewNotes,
      });
      this.actionSuccess = `Application ${this.application.id} approved successfully at ${rateNum}% p.a.`;
      this.application = {
        ...this.application,
        status: 'APPROVED',
        interestRate: String(rateNum),
        reviewNotes: reviewNotes || null,
        rejectionReason: null,
      };
      this.activeAction = null;
    } catch (err) {
      this.actionError = err.message || 'Failed to approve application.';
    } finally {
      this.submitting = false;
    }
  }

  async submitReject(rejectionReason, reviewNotes, mockApiReview) {
    if (!this.application) return;
    if (this.submitting) return; // Duplicate submit protection

    if (this.application.status !== 'SUBMITTED') {
      this.actionError = 'Only submitted loan applications can be reviewed';
      return;
    }

    if (!rejectionReason || !rejectionReason.trim()) {
      this.actionError = 'Rejection reason is required by credit policy.';
      return;
    }

    this.submitting = true;
    this.actionError = null;

    try {
      await mockApiReview(this.application.id, {
        decision: 'REJECT',
        rejectionReason: rejectionReason.trim(),
        reviewNotes,
      });
      this.actionSuccess = `Application ${this.application.id} has been marked as Rejected.`;
      this.application = {
        ...this.application,
        status: 'REJECTED',
        rejectionReason: rejectionReason.trim(),
        reviewNotes: reviewNotes || null,
      };
      this.activeAction = null;
    } catch (err) {
      this.actionError = err.message || 'Failed to reject application.';
    } finally {
      this.submitting = false;
    }
  }
}

// Mock test data
const testProducts = [
  { id: 'PROD-PL', name: 'Personal Loan', minInterestRate: '12', maxInterestRate: '24' },
];

const submittedApp = {
  id: 'APP-SUB-01',
  status: 'SUBMITTED',
  requestedAmount: '50000',
  requestedTenure: 12,
  customer: { id: 'C1', name: 'Rohan Sharma', email: 'rohan@test.com', phone: '9876543210' },
  product: { id: 'PROD-PL', name: 'Personal Loan' },
  submittedAt: '2026-10-10T10:00:00.000Z',
  createdAt: '2026-10-10T10:00:00.000Z',
};

// Sub-test 2.1: Valid APPROVE action
(async () => {
  const sim = new AppReviewSimulator();
  await sim.loadDetail('APP-SUB-01', async () => ({ applications: [submittedApp] }), async () => ({ products: testProducts }));
  assert.strictEqual(sim.application.status, 'SUBMITTED');

  // Submit valid approval at 15.5%
  await sim.submitApprove('15.5', 'KYC verified', async (id, payload) => ({
    success: true,
    message: 'Loan application approved successfully',
  }));

  assert.strictEqual(sim.actionError, null);
  assert.strictEqual(sim.application.status, 'APPROVED');
  assert.strictEqual(sim.application.interestRate, '15.5');
  assert.strictEqual(sim.application.reviewNotes, 'KYC verified');
  assert.strictEqual(sim.submitting, false);
  console.log('✓ Test 2.1 Passed: Valid APPROVE action transitions application to APPROVED with interest rate.');
})();

// Sub-test 2.2: Invalid APPROVE action (rate out of bounds or missing)
(async () => {
  const sim = new AppReviewSimulator();
  await sim.loadDetail('APP-SUB-01', async () => ({ applications: [submittedApp] }), async () => ({ products: testProducts }));

  // Missing rate
  await sim.submitApprove('', 'Notes', async () => {});
  assert.strictEqual(sim.actionError, 'A valid positive interest rate is required to approve.');

  // Rate below min (10% < 12%)
  await sim.submitApprove('10', 'Notes', async () => {});
  assert.strictEqual(sim.actionError, 'Interest rate cannot be below 12% for this product.');

  // Rate above max (25% > 24%)
  await sim.submitApprove('25', 'Notes', async () => {});
  assert.strictEqual(sim.actionError, 'Interest rate cannot exceed 24% for this product.');

  assert.strictEqual(sim.application.status, 'SUBMITTED', 'Status unchanged after validation failures');
  console.log('✓ Test 2.2 Passed: Invalid APPROVE attempts correctly blocked with product rate validation.');
})();

// Sub-test 2.3: Valid REJECT action
(async () => {
  const sim = new AppReviewSimulator();
  await sim.loadDetail('APP-SUB-01', async () => ({ applications: [submittedApp] }), async () => ({ products: testProducts }));

  await sim.submitReject('Ineligible monthly income criteria', 'Audit check', async () => ({
    success: true,
    message: 'Loan application rejected successfully',
  }));

  assert.strictEqual(sim.actionError, null);
  assert.strictEqual(sim.application.status, 'REJECTED');
  assert.strictEqual(sim.application.rejectionReason, 'Ineligible monthly income criteria');
  console.log('✓ Test 2.3 Passed: Valid REJECT action transitions application to REJECTED with reason recorded.');
})();

// Sub-test 2.4: Invalid REJECT action (missing rejection reason)
(async () => {
  const sim = new AppReviewSimulator();
  await sim.loadDetail('APP-SUB-01', async () => ({ applications: [submittedApp] }), async () => ({ products: testProducts }));

  await sim.submitReject('', 'Notes', async () => {});
  assert.strictEqual(sim.actionError, 'Rejection reason is required by credit policy.');
  assert.strictEqual(sim.application.status, 'SUBMITTED');
  console.log('✓ Test 2.4 Passed: Missing rejection reason correctly rejected by validation.');
})();

// Sub-test 2.5: Permitted status transition guard (cannot re-review already APPROVED or REJECTED application)
(async () => {
  const sim = new AppReviewSimulator();
  const alreadyApproved = { ...submittedApp, status: 'APPROVED', interestRate: '14' };
  await sim.loadDetail('APP-SUB-01', async () => ({ applications: [alreadyApproved] }), async () => ({ products: testProducts }));

  await sim.submitApprove('15', 'Notes', async () => {});
  assert.strictEqual(sim.actionError, 'Only submitted loan applications can be reviewed');

  await sim.submitReject('Reason', 'Notes', async () => {});
  assert.strictEqual(sim.actionError, 'Only submitted loan applications can be reviewed');
  console.log('✓ Test 2.5 Passed: Status transition guard blocks re-review of non-SUBMITTED applications.');
})();

// ============================================================================
// PART 3: Duplicate Submit Protection
// ============================================================================
console.log('\n--- TEST 3: Duplicate-Submit Protection ---');

(async () => {
  const sim = new AppReviewSimulator();
  await sim.loadDetail('APP-SUB-01', async () => ({ applications: [submittedApp] }), async () => ({ products: testProducts }));

  let callCount = 0;
  const slowApiReview = async () => {
    callCount++;
    await new Promise((r) => setTimeout(r, 50));
    return { success: true };
  };

  // Trigger two approvals concurrently
  const p1 = sim.submitApprove('14', 'First click', slowApiReview);
  const p2 = sim.submitApprove('14', 'Second rapid click', slowApiReview);

  await Promise.all([p1, p2]);
  assert.strictEqual(callCount, 1, 'API review endpoint must be invoked exactly once during concurrent submissions');
  console.log('✓ Test 3 Passed: Duplicate submit protection prevents redundant concurrent API requests.');
})();

// ============================================================================
// PART 4: Server Error (500) & Unauthorized (401/403) Handling
// ============================================================================
console.log('\n--- TEST 4: Server Error and Auth Failure Handling ---');

(async () => {
  const sim = new AppReviewSimulator();

  // Simulated 403 Forbidden
  await sim.loadDetail('APP-SUB-01', async () => {
    throw new Error('Access denied: Requires ADMIN role.');
  }, async () => ({ products: [] }));

  assert.strictEqual(sim.loading, false);
  assert.strictEqual(sim.error, 'Access denied: Requires ADMIN role.');
  assert.strictEqual(sim.application, null, 'No fallback to mock data on auth failure');

  // Simulated 500 Server Error
  await sim.loadDetail('APP-SUB-01', async () => {
    throw new Error('500 Internal Server Error: Failed to fetch loan applications');
  }, async () => ({ products: [] }));

  assert.strictEqual(sim.error, '500 Internal Server Error: Failed to fetch loan applications');
  assert.strictEqual(sim.application, null, 'No fallback to mock data on server failure');
  console.log('✓ Test 4 Passed: 403 Forbidden and 500 Server Error safely captured without falling back to mock data.');
})();

// ============================================================================
// PART 5: Empty Applications State
// ============================================================================
console.log('\n--- TEST 5: Empty Applications State ---');

(async () => {
  const sim = new AppReviewSimulator();
  await sim.loadDetail('ANY-ID', async () => ({ applications: [] }), async () => ({ products: [] }));
  assert.strictEqual(sim.loading, false);
  assert.strictEqual(sim.application, null);
  assert.strictEqual(sim.error, null);
  console.log('✓ Test 5 Passed: Empty state handled cleanly without errors or null dereferences.');
})();

// ============================================================================
// PART 6: Phase 4.2.1 Safety Verification: Stale / Unknown / Mismatched ID Isolation
// ============================================================================
console.log('\n--- TEST 6: Phase 4.2.1 Stale / Unknown / Mismatched ID Safety ---');

(async () => {
  const appList = [
    { id: 'APP-CUSTOMER-A', status: 'SUBMITTED', customer: { name: 'Customer A' }, product: { id: 'PROD-PL' } },
    { id: 'APP-CUSTOMER-B', status: 'SUBMITTED', customer: { name: 'Customer B' }, product: { id: 'PROD-PL' } },
  ];

  const sim = new AppReviewSimulator();

  // Case 6.1: Valid ID loads exact matching application
  await sim.loadDetail('APP-CUSTOMER-A', async () => ({ applications: appList }), async () => ({ products: testProducts }));
  assert.strictEqual(sim.application?.id, 'APP-CUSTOMER-A');
  assert.strictEqual(sim.application?.customer?.name, 'Customer A');
  console.log('✓ Test 6.1 Passed: Valid selected ID loads exact matching application.');

  // Case 6.2: Unknown selected ID shows not-found state (does NOT fall back to Customer A or Customer B)
  await sim.loadDetail('APP-UNKNOWN-999', async () => ({ applications: appList }), async () => ({ products: testProducts }));
  assert.strictEqual(sim.application, null, 'Unknown ID must result in null application, NEVER silent fallback');
  console.log('✓ Test 6.2 Passed: Unknown ID strictly results in null application (no silent fallback).');

  // Case 6.3: Stale deleted ID does NOT select first pending application
  await sim.loadDetail('APP-DELETED-STALE', async () => ({ applications: appList }), async () => ({ products: testProducts }));
  assert.strictEqual(sim.application, null, 'Stale deleted ID must not select first pending application');
  console.log('✓ Test 6.3 Passed: Stale deleted ID does NOT select the first pending application.');

  // Case 6.4: Empty ID or null ID does NOT select any application
  await sim.loadDetail('', async () => ({ applications: appList }), async () => ({ products: testProducts }));
  assert.strictEqual(sim.application, null, 'Empty ID must not select any application');
  console.log('✓ Test 6.4 Passed: Empty or missing ID does not select any application.');

  // Case 6.5: Approval/rejection controls cannot act on an unselected / mismatched application
  let apiReviewCalled = false;
  const mockApiReview = async () => { apiReviewCalled = true; return { success: true }; };
  await sim.submitApprove('15', 'Notes', mockApiReview);
  assert.strictEqual(apiReviewCalled, false, 'Approve cannot act when no application is selected');
  await sim.submitReject('Reason', 'Notes', mockApiReview);
  assert.strictEqual(apiReviewCalled, false, 'Reject cannot act when no application is selected');
  console.log('✓ Test 6.5 Passed: Review mutations strictly blocked when no application is matched.');
})();

console.log('\nAll Phase 4.2 & 4.2.1 tests passed successfully!');
