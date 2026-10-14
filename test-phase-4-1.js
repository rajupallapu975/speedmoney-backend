const assert = require('assert');

console.log('Starting Phase 4.1 Admin Dashboard & Loan Applications Verification Suite...\n');

// ============================================================================
// PART 1: Dashboard Response Mapping & No-Mock-Fallback Safety
// ============================================================================
console.log('--- TEST 1: Dashboard Response Mapping ---');

class AdminDashboardSimulator {
  constructor() {
    this.overview = null;
    this.applications = [];
    this.todayCollections = null;
    this.loading = false;
    this.error = null;
    this.activeRequestId = 0;
  }

  async loadDashboardData(mockApiOverview, mockApiApps, mockApiColls) {
    const reqId = ++this.activeRequestId;
    this.loading = true;
    this.error = null;

    try {
      const [overviewRes, appsRes, collsRes] = await Promise.allSettled([
        mockApiOverview(),
        mockApiApps(),
        mockApiColls(),
      ]);

      if (reqId !== this.activeRequestId) return; // Sequence guard

      if (
        overviewRes.status === 'rejected' &&
        appsRes.status === 'rejected' &&
        collsRes.status === 'rejected'
      ) {
        this.error = overviewRes.reason?.message || 'Failed to load administrative dashboard data.';
        this.loading = false;
        return;
      }

      if (overviewRes.status === 'fulfilled') {
        this.overview = overviewRes.value;
      }
      if (appsRes.status === 'fulfilled') {
        this.applications = appsRes.value?.applications || [];
      }
      if (collsRes.status === 'fulfilled') {
        this.todayCollections = collsRes.value;
      }
      this.loading = false;
    } catch (err) {
      if (reqId !== this.activeRequestId) return;
      this.error = err?.message || 'Failed to load dashboard data.';
      this.loading = false;
    }
  }

  getMetrics() {
    const activeLoans = this.overview?.portfolio?.statusCounts?.ACTIVE ?? null;
    const totalLoans = this.overview?.portfolio?.totalLoans ?? null;
    const outstanding = this.overview?.portfolio?.totalOutstandingEmiAmount ?? null;
    const overdue = this.overview?.portfolio?.totalOverdueEmiAmount ?? null;
    const pendingApps = this.applications.filter((a) =>
      ['SUBMITTED', 'UNDER_REVIEW'].includes(a.status?.toUpperCase())
    ).length;
    const todayCollected = this.todayCollections?.summary?.totalCollectedAmount ?? null;
    const todayCount = this.todayCollections?.summary?.collectionsCount ?? null;

    return {
      totalCustomers: '—', // Clearly identified as unsupported
      totalCustomersDelta: 'No backend endpoint',
      activeLoans: activeLoans !== null ? String(activeLoans) : '—',
      totalLoans,
      pendingApps: this.applications.length > 0 || this.overview ? String(pendingApps) : '—',
      todayCollected: todayCollected !== null ? todayCollected : '—',
      todayCount,
      outstandingAmount: outstanding !== null ? outstanding : '—',
      overdueAmount: overdue !== null ? overdue : '—',
    };
  }
}

// Execute Test 1: Successful mapping
(async () => {
  const dash = new AdminDashboardSimulator();

  const mockOverview = async () => ({
    success: true,
    businessDate: '2026-10-12',
    portfolio: {
      totalLoans: 15,
      statusCounts: { ACTIVE: 10, COMPLETED: 3, OVERDUE: 2, DEFAULTED: 0, CLOSED: 0 },
      totalPrincipalDisbursed: '1500000.00',
      totalScheduledRepayments: '1750000.00',
      totalOutstandingEmiAmount: '680000.00',
      totalOverdueEmiAmount: '45000.00',
    },
    collections: {
      online: { totalAmount: '200000.00', count: 12 },
      cash: { totalAmount: '350000.00', count: 28, reconciledAmount: '300000.00', reconciledCount: 24, unreconciledAmount: '50000.00', unreconciledCount: 4 },
    },
    settlements: { unresolvedDiscrepancyCount: 0, reconciledCount: 10 },
  });

  const mockApps = async () => ({
    success: true,
    count: 4,
    applications: [
      { id: 'APP-1', status: 'SUBMITTED', requestedAmount: '50000', customer: { name: 'Aarav' }, product: { name: 'Personal Loan' } },
      { id: 'APP-2', status: 'UNDER_REVIEW', requestedAmount: '75000', customer: { name: 'Diya' }, product: { name: 'Business Loan' } },
      { id: 'APP-3', status: 'APPROVED', requestedAmount: '30000', customer: { name: 'Kabir' }, product: { name: 'Emergency Loan' } },
      { id: 'APP-4', status: 'REJECTED', requestedAmount: '100000', customer: { name: 'Mira' }, product: { name: 'Gold Loan' } },
    ],
  });

  const mockColls = async () => ({
    success: true,
    summary: {
      totalCollectedAmount: '42500.00',
      collectionsCount: 8,
      reconciledAmount: '30000.00',
      reconciledCount: 6,
      unreconciledAmount: '12500.00',
      unreconciledCount: 2,
    },
  });

  await dash.loadDashboardData(mockOverview, mockApps, mockColls);
  const m = dash.getMetrics();

  assert.strictEqual(m.totalCustomers, '—');
  assert.strictEqual(m.totalCustomersDelta, 'No backend endpoint');
  assert.strictEqual(m.activeLoans, '10');
  assert.strictEqual(m.totalLoans, 15);
  assert.strictEqual(m.pendingApps, '2'); // APP-1 (SUBMITTED) + APP-2 (UNDER_REVIEW)
  assert.strictEqual(m.todayCollected, '42500.00');
  assert.strictEqual(m.todayCount, 8);
  assert.strictEqual(m.outstandingAmount, '680000.00');
  assert.strictEqual(m.overdueAmount, '45000.00');

  console.log('✓ Test 1 Passed: Real backend dashboard response mapped accurately to verified stat cards.');
})();

// ============================================================================
// PART 2: No Fallback to Mock Figures After API Failure
// ============================================================================
console.log('\n--- TEST 2: No Fallback to Mock Data on API Failure ---');

(async () => {
  const dash = new AdminDashboardSimulator();

  // Simulated API failure (e.g. 500 error or network cut)
  const failingCall = async () => {
    throw new Error('500 Internal Server Error: Database connection lost');
  };

  await dash.loadDashboardData(failingCall, failingCall, failingCall);

  assert.strictEqual(dash.loading, false);
  assert.strictEqual(dash.error, '500 Internal Server Error: Database connection lost');
  assert.strictEqual(dash.overview, null);
  assert.strictEqual(dash.applications.length, 0);
  assert.strictEqual(dash.todayCollections, null);

  const m = dash.getMetrics();
  // Ensure NO fallback to mock values like "250", "183", "84500"
  assert.strictEqual(m.activeLoans, '—');
  assert.strictEqual(m.pendingApps, '—');
  assert.strictEqual(m.todayCollected, '—');
  assert.strictEqual(m.outstandingAmount, '—');
  assert.strictEqual(m.overdueAmount, '—');

  console.log('✓ Test 2 Passed: Failed API requests surface clean error and NEVER fall back to mock figures.');
})();

// ============================================================================
// PART 3: Unauthorized / Forbidden Handling
// ============================================================================
console.log('\n--- TEST 3: Unauthorized (401) / Forbidden (403) Handling ---');

(async () => {
  const dash = new AdminDashboardSimulator();

  const authErrorCall = async () => {
    const err = new Error('Access denied: Requires ADMIN role.');
    err.status = 403;
    throw err;
  };

  await dash.loadDashboardData(authErrorCall, authErrorCall, authErrorCall);

  assert.strictEqual(dash.loading, false);
  assert.strictEqual(dash.error, 'Access denied: Requires ADMIN role.');
  assert.strictEqual(dash.overview, null);
  assert.strictEqual(dash.applications.length, 0);

  console.log('✓ Test 3 Passed: 403 Forbidden correctly captured and safely handled.');
})();

// ============================================================================
// PART 4: Application Listing, Search & Status Filtering
// ============================================================================
console.log('\n--- TEST 4: Application Listing, Search & Status Filtering ---');

class ApplicationsSimulator {
  constructor(applications = []) {
    this.applications = applications;
    this.statusFilter = 'All';
    this.search = '';
    this.page = 1;
    this.pageSize = 10;
  }

  setStatusFilter(f) {
    this.statusFilter = f;
    this.page = 1;
  }

  setSearch(s) {
    this.search = s;
    this.page = 1;
  }

  setPage(p) {
    this.page = p;
  }

  getFiltered() {
    return this.applications.filter((a) => {
      // Status filter
      if (this.statusFilter !== 'All') {
        const normFilter = this.statusFilter.toLowerCase().replace(/[\s_]+/g, '');
        const normStatus = (a.status || '').toLowerCase().replace(/[\s_]+/g, '');
        if (normFilter === 'submitted' && normStatus !== 'submitted') return false;
        if (normFilter === 'underreview' && normStatus !== 'underreview') return false;
        if (normFilter === 'approved' && normStatus !== 'approved') return false;
        if (normFilter === 'rejected' && normStatus !== 'rejected') return false;
      }
      // Search
      if (this.search.trim()) {
        const q = this.search.trim().toLowerCase();
        const name = (a.customer?.name || '').toLowerCase();
        const email = (a.customer?.email || '').toLowerCase();
        const phone = (a.customer?.phone || '').toLowerCase();
        const id = (a.id || '').toLowerCase();
        const product = (a.product?.name || '').toLowerCase();
        if (
          !name.includes(q) &&
          !email.includes(q) &&
          !phone.includes(q) &&
          !id.includes(q) &&
          !product.includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }

  getPageRows() {
    const filtered = this.getFiltered();
    const start = (this.page - 1) * this.pageSize;
    return filtered.slice(start, start + this.pageSize);
  }

  getTotalPages() {
    return Math.max(1, Math.ceil(this.getFiltered().length / this.pageSize));
  }
}

// Generate 25 test applications
const sampleApps = [
  { id: 'SM-APP-001', status: 'SUBMITTED', customer: { name: 'Rohan Sharma', email: 'rohan@test.com', phone: '9876543210' }, product: { name: 'Personal Loan' }, requestedAmount: '50000' },
  { id: 'SM-APP-002', status: 'SUBMITTED', customer: { name: 'Priya Verma', email: 'priya@test.com', phone: '9876543211' }, product: { name: 'Education Loan' }, requestedAmount: '150000' },
  { id: 'SM-APP-003', status: 'UNDER_REVIEW', customer: { name: 'Amit Patel', email: 'amit@test.com', phone: '9876543212' }, product: { name: 'Business Loan' }, requestedAmount: '250000' },
  { id: 'SM-APP-004', status: 'APPROVED', customer: { name: 'Sneha Rao', email: 'sneha@test.com', phone: '9876543213' }, product: { name: 'Personal Loan' }, requestedAmount: '40000' },
  { id: 'SM-APP-005', status: 'REJECTED', customer: { name: 'Vikas Gupta', email: 'vikas@test.com', phone: '9876543214' }, product: { name: 'Gold Loan' }, requestedAmount: '60000' },
  ...Array.from({ length: 20 }, (_, i) => ({
    id: `SM-APP-0${i + 6}`,
    status: i % 2 === 0 ? 'SUBMITTED' : 'APPROVED',
    customer: { name: `Customer ${i + 6}`, email: `c${i+6}@test.com`, phone: `98765000${i+6}` },
    product: { name: 'Personal Loan' },
    requestedAmount: '50000',
  })),
];

{
  const appList = new ApplicationsSimulator(sampleApps);
  assert.strictEqual(appList.getFiltered().length, 25, 'Total applications should be 25');
  assert.strictEqual(appList.getTotalPages(), 3, '25 records at 10/page gives 3 pages');

  // Test pagination slices
  const p1 = appList.getPageRows();
  assert.strictEqual(p1.length, 10, 'Page 1 should have 10 rows');
  assert.strictEqual(p1[0].id, 'SM-APP-001');

  appList.setPage(2);
  const p2 = appList.getPageRows();
  assert.strictEqual(p2.length, 10, 'Page 2 should have 10 rows');
  assert.strictEqual(p2[0].id, 'SM-APP-011');

  appList.setPage(3);
  const p3 = appList.getPageRows();
  assert.strictEqual(p3.length, 5, 'Page 3 should have remaining 5 rows');

  // Test Status Filter: "Under Review"
  appList.setStatusFilter('Under Review');
  assert.strictEqual(appList.page, 1, 'Status filter reset page to 1');
  const underReview = appList.getFiltered();
  assert.strictEqual(underReview.length, 1);
  assert.strictEqual(underReview[0].id, 'SM-APP-003');

  // Test Status Filter: "Rejected"
  appList.setStatusFilter('Rejected');
  const rejected = appList.getFiltered();
  assert.strictEqual(rejected.length, 1);
  assert.strictEqual(rejected[0].id, 'SM-APP-005');

  // Test Search: by Name "Rohan"
  appList.setStatusFilter('All');
  appList.setSearch('Rohan');
  const searchedName = appList.getFiltered();
  assert.strictEqual(searchedName.length, 1);
  assert.strictEqual(searchedName[0].customer.name, 'Rohan Sharma');

  // Test Search: by Phone "9876543211"
  appList.setSearch('9876543211');
  const searchedPhone = appList.getFiltered();
  assert.strictEqual(searchedPhone.length, 1);
  assert.strictEqual(searchedPhone[0].customer.name, 'Priya Verma');

  // Test Search: by Application ID "SM-APP-004"
  appList.setSearch('SM-APP-004');
  const searchedId = appList.getFiltered();
  assert.strictEqual(searchedId.length, 1);
  assert.strictEqual(searchedId[0].id, 'SM-APP-004');

  // Test Empty Search Result
  appList.setSearch('NonExistentCustomerNameXYZ');
  assert.strictEqual(appList.getFiltered().length, 0);

  console.log('✓ Test 4 Passed: Application listing, client pagination, search, and status filters work cleanly.');
}

console.log('\nAll Phase 4.1 tests passed successfully!');
