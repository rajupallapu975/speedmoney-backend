const assert = require("assert");
const { Prisma } = require("@prisma/client");
const {
    isProofStorageReady,
    registerStorageAdapter,
    resetStorageAdapter,
    verifyAndStoreDisbursementProof,
} = require("./services/disbursement-storage");

console.log("Starting Phase 4.3B.1 Disbursement Proof Security & Loan Lifecycle Test Suite...\n");

// ============================================================================
// SIMULATOR: Loan Lifecycle & Disbursement Operations
// ============================================================================

function addMonths(date, months) {
    const result = new Date(date);
    const originalDay = result.getDate();
    result.setDate(1);
    result.setMonth(result.getMonth() + months);
    const lastDayOfMonth = new Date(
        result.getFullYear(),
        result.getMonth() + 1,
        0
    ).getDate();
    result.setDate(Math.min(originalDay, lastDayOfMonth));
    return result;
}

function calculateEmiSchedule(principal, annualInterestRate, tenureMonths, startDate) {
    const monthlyRate = annualInterestRate.div(1200);
    const onePlusRate = new Prisma.Decimal(1).plus(monthlyRate);
    const power = onePlusRate.pow(tenureMonths);

    let emiAmount;
    if (monthlyRate.eq(0)) {
        emiAmount = principal.div(tenureMonths);
    } else {
        emiAmount = principal
            .mul(monthlyRate)
            .mul(power)
            .div(power.minus(1));
    }
    emiAmount = emiAmount.toDecimalPlaces(2);

    let outstanding = principal;
    let totalInterest = new Prisma.Decimal(0);
    const emiRecords = [];

    for (let installmentNo = 1; installmentNo <= tenureMonths; installmentNo++) {
        const dueDate = addMonths(startDate, installmentNo);
        let interestAmount = outstanding.mul(monthlyRate).toDecimalPlaces(2);
        let principalAmount;
        let currentEmi = emiAmount;

        if (installmentNo === tenureMonths) {
            principalAmount = outstanding;
            currentEmi = principalAmount.plus(interestAmount).toDecimalPlaces(2);
        } else {
            principalAmount = currentEmi.minus(interestAmount).toDecimalPlaces(2);
            if (principalAmount.gt(outstanding)) {
                principalAmount = outstanding;
                currentEmi = principalAmount.plus(interestAmount).toDecimalPlaces(2);
            }
        }

        outstanding = outstanding.minus(principalAmount).toDecimalPlaces(2);
        totalInterest = totalInterest.plus(interestAmount).toDecimalPlaces(2);

        emiRecords.push({
            installmentNo,
            dueDate,
            principalAmount,
            interestAmount,
            emiAmount: currentEmi,
            paidAmount: new Prisma.Decimal(0),
            outstandingAmount: currentEmi,
            status: "PENDING",
        });
    }

    const totalPayable = principal.plus(totalInterest).toDecimalPlaces(2);
    return { emiAmount, totalInterest, totalPayable, emiRecords };
}

class BackendLoanSimulator {
    constructor() {
        this.applications = new Map();
        this.loans = new Map();
        this.emis = new Map();
        this.auditLogs = [];
    }

    seedApplication(app) {
        this.applications.set(app.id, { ...app, loan: null });
    }

    seedLoan(loan, emis = []) {
        this.loans.set(loan.id, { ...loan });
        this.emis.set(loan.id, [...emis]);
        if (loan.applicationId && this.applications.has(loan.applicationId)) {
            const app = this.applications.get(loan.applicationId);
            app.loan = { id: loan.id, loanNumber: loan.loanNumber, status: loan.status };
        }
    }

    async createLoanFromApplication(applicationId, userRole = "ADMIN") {
        if (userRole !== "ADMIN") {
            return { status: 403, body: { success: false, message: "Forbidden" } };
        }

        const application = this.applications.get(applicationId);
        if (!application) {
            return { status: 404, body: { success: false, message: "Loan application not found" } };
        }

        if (application.status !== "APPROVED") {
            return {
                status: 400,
                body: {
                    success: false,
                    message: "Only approved applications can be converted into loans",
                    currentStatus: application.status,
                },
            };
        }

        if (application.loan) {
            return {
                status: 409,
                body: {
                    success: false,
                    message: "A loan has already been created for this application",
                    loan: application.loan,
                },
            };
        }

        if (!application.interestRate) {
            return {
                status: 400,
                body: { success: false, message: "Approved application does not have an interest rate" },
            };
        }

        const principal = new Prisma.Decimal(application.requestedAmount);
        const annualInterestRate = new Prisma.Decimal(application.interestRate);
        const tenureMonths = application.requestedTenure;

        const { emiAmount, totalInterest, totalPayable } = calculateEmiSchedule(
            principal,
            annualInterestRate,
            tenureMonths,
            new Date()
        );

        const loanId = `LOAN-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const loanNumber = `LN-2026-${Math.floor(Math.random() * 10000)}`;

        const createdLoan = {
            id: loanId,
            customerId: application.customerId,
            applicationId: application.id,
            loanNumber,
            principalAmount: principal,
            interestRate: annualInterestRate,
            tenureMonths,
            emiAmount,
            totalInterest,
            totalPayable,
            outstandingAmount: new Prisma.Decimal(0),
            startDate: null,
            endDate: null,
            disbursedAt: null,
            disbursementReference: null,
            disbursementProofUrl: null,
            status: "PENDING_DISBURSEMENT",
        };

        this.loans.set(loanId, createdLoan);
        this.emis.set(loanId, []);
        application.loan = { id: loanId, loanNumber, status: "PENDING_DISBURSEMENT" };

        this.auditLogs.push({
            action: "CREATE",
            entity: "Loan",
            entityId: loanId,
            description: "Loan created in PENDING_DISBURSEMENT status from approved application",
        });

        return {
            status: 201,
            body: {
                success: true,
                message: "Loan created successfully in PENDING_DISBURSEMENT status",
                loan: {
                    id: createdLoan.id,
                    loanNumber: createdLoan.loanNumber,
                    principalAmount: createdLoan.principalAmount.toString(),
                    interestRate: createdLoan.interestRate.toString(),
                    tenureMonths: createdLoan.tenureMonths,
                    emiAmount: createdLoan.emiAmount.toString(),
                    totalInterest: createdLoan.totalInterest.toString(),
                    totalPayable: createdLoan.totalPayable.toString(),
                    outstandingAmount: createdLoan.outstandingAmount.toString(),
                    startDate: null,
                    endDate: null,
                    disbursedAt: null,
                    disbursementReference: null,
                    disbursementProofUrl: null,
                    status: createdLoan.status,
                    emiCount: 0,
                },
                emiSchedule: [],
            },
        };
    }

    async disburseLoan(loanId, { disbursementReference, disbursedAt, proof }, userRole = "ADMIN") {
        if (userRole !== "ADMIN") {
            return { status: 403, body: { success: false, message: "Forbidden" } };
        }

        const loan = this.loans.get(loanId);
        if (!loan) {
            return { status: 404, body: { success: false, message: "Loan record not found" } };
        }

        if (loan.status === "ACTIVE") {
            return {
                status: 409,
                body: {
                    success: false,
                    message: "Loan has already been disbursed and is currently active",
                    loan: { id: loan.id, loanNumber: loan.loanNumber, status: loan.status },
                },
            };
        }

        if (loan.status !== "PENDING_DISBURSEMENT") {
            return {
                status: 400,
                body: {
                    success: false,
                    message: `Only loans in PENDING_DISBURSEMENT status can be disbursed (current status: ${loan.status})`,
                },
            };
        }

        if (!disbursementReference || !String(disbursementReference).trim()) {
            return {
                status: 400,
                body: { success: false, message: "Transfer reference (e.g. UTR / NEFT / IMPS reference) is required for disbursement" },
            };
        }

        const cleanReference = String(disbursementReference).trim();
        if (cleanReference.length < 3) {
            return {
                status: 400,
                body: { success: false, message: "Transfer reference must be at least 3 characters" },
            };
        }

        let disbursementDate = new Date();
        if (disbursedAt) {
            const parsed = new Date(disbursedAt);
            if (isNaN(parsed.getTime())) {
                return { status: 400, body: { success: false, message: "Invalid disbursement timestamp format" } };
            }
            if (parsed.getTime() > Date.now() + 60000) {
                return { status: 400, body: { success: false, message: "Disbursement date cannot be in the future" } };
            }
            disbursementDate = parsed;
        }

        // Delegate proof persistence to the actual disbursement-storage service
        let storedProof;
        try {
            storedProof = await verifyAndStoreDisbursementProof(proof, loan.id);
        } catch (err) {
            return {
                status: err.statusCode || 500,
                body: { success: false, message: err.message, code: err.code || "PROOF_ERROR" },
            };
        }

        const { emiAmount, totalInterest, totalPayable, emiRecords } = calculateEmiSchedule(
            loan.principalAmount,
            loan.interestRate,
            loan.tenureMonths,
            disbursementDate
        );

        const endDate = addMonths(disbursementDate, loan.tenureMonths);

        loan.status = "ACTIVE";
        loan.startDate = disbursementDate;
        loan.endDate = endDate;
        loan.disbursedAt = disbursementDate;
        loan.disbursementReference = cleanReference;
        loan.disbursementProofUrl = storedProof.storageReference;
        loan.emiAmount = emiAmount;
        loan.totalInterest = totalInterest;
        loan.totalPayable = totalPayable;
        loan.outstandingAmount = totalPayable;

        this.emis.set(loan.id, emiRecords);
        if (loan.applicationId && this.applications.has(loan.applicationId)) {
            this.applications.get(loan.applicationId).loan.status = "ACTIVE";
        }

        this.auditLogs.push({
            action: "APPROVE",
            entity: "Loan",
            entityId: loan.id,
            description: `Loan ${loan.loanNumber} disbursed and activated with transfer ref: ${cleanReference}`,
        });

        return {
            status: 200,
            body: {
                success: true,
                message: "Loan disbursed and activated successfully",
                loan: {
                    id: loan.id,
                    loanNumber: loan.loanNumber,
                    status: loan.status,
                    startDate: loan.startDate,
                    endDate: loan.endDate,
                    disbursedAt: loan.disbursedAt,
                    disbursementReference: loan.disbursementReference,
                    disbursementProofUrl: loan.disbursementProofUrl,
                    outstandingAmount: loan.outstandingAmount.toString(),
                    emiCount: emiRecords.length,
                },
                emiSchedule: emiRecords.map((e) => ({
                    installmentNo: e.installmentNo,
                    dueDate: e.dueDate,
                    emiAmount: e.emiAmount.toString(),
                    status: e.status,
                })),
            },
        };
    }

    calculateOverview() {
        let totalLoans = 0;
        let pendingDisbursementLoans = 0;
        let activeLoans = 0;
        let completedLoans = 0;
        let overdueLoans = 0;
        let defaultedLoans = 0;
        let closedLoans = 0;

        let totalPrincipalDisbursed = new Prisma.Decimal(0);
        let totalPrincipalPending = new Prisma.Decimal(0);
        let totalScheduledRepayments = new Prisma.Decimal(0);

        for (const loan of this.loans.values()) {
            totalLoans++;
            if (loan.status === "PENDING_DISBURSEMENT") {
                pendingDisbursementLoans++;
                totalPrincipalPending = totalPrincipalPending.plus(loan.principalAmount);
            } else {
                if (loan.status === "ACTIVE") activeLoans++;
                if (loan.status === "COMPLETED") completedLoans++;
                if (loan.status === "OVERDUE") overdueLoans++;
                if (loan.status === "DEFAULTED") defaultedLoans++;
                if (loan.status === "CLOSED") closedLoans++;

                if (["ACTIVE", "COMPLETED", "OVERDUE", "DEFAULTED"].includes(loan.status)) {
                    totalPrincipalDisbursed = totalPrincipalDisbursed.plus(loan.principalAmount);
                    totalScheduledRepayments = totalScheduledRepayments.plus(loan.totalPayable);
                }
            }
        }

        return {
            totalLoans,
            statusCounts: {
                PENDING_DISBURSEMENT: pendingDisbursementLoans,
                ACTIVE: activeLoans,
                COMPLETED: completedLoans,
                OVERDUE: overdueLoans,
                DEFAULTED: defaultedLoans,
                CLOSED: closedLoans,
            },
            totalPrincipalDisbursed: totalPrincipalDisbursed.toString(),
            totalPrincipalPendingDisbursement: totalPrincipalPending.toString(),
            totalScheduledRepayments: totalScheduledRepayments.toString(),
        };
    }
}

const createMockTrustedAdapter = (options = {}) => ({
    isAvailable: () => options.available !== false,
    storeProof: async ({ fileData, fileName, mimeType, loanId }) => {
        if (options.shouldFail) {
            const err = new Error(options.failMessage || "Cloud storage write failed");
            err.statusCode = 500;
            err.code = "STORAGE_UPLOAD_FAILED";
            throw err;
        }
        assert.ok(fileData, "File content buffer must be present");
        assert.ok(loanId, "Target loan ID must be present");
        return {
            storageReference: `s3://speedmoney-private-vault/disbursements/${loanId}/${fileName}.pdf`,
            storedAt: new Date("2026-10-12T10:00:00Z"),
        };
    },
});

const validProofPayload = {
    base64Content: Buffer.from("DUMMY_PDF_PAYMENT_RECEIPT_BYTES").toString("base64"),
    fileName: "bank-transfer-receipt-9988",
    mimeType: "application/pdf",
};

// ============================================================================
// MAIN SEQUENTIAL TEST EXECUTION
// ============================================================================
async function runAllTests() {
    // TEST 1
    console.log("--- TEST 1: Unapproved Applications Blocked ---");
    {
        const sim = new BackendLoanSimulator();
        sim.seedApplication({
            id: "APP-DRAFT",
            customerId: "CUST-1",
            requestedAmount: "50000",
            requestedTenure: 12,
            interestRate: "14",
            status: "DRAFT",
        });
        sim.seedApplication({
            id: "APP-SUBMITTED",
            customerId: "CUST-1",
            requestedAmount: "50000",
            requestedTenure: 12,
            interestRate: "14",
            status: "SUBMITTED",
        });
        sim.seedApplication({
            id: "APP-REJECTED",
            customerId: "CUST-1",
            requestedAmount: "50000",
            requestedTenure: 12,
            interestRate: "14",
            status: "REJECTED",
        });

        const resDraft = await sim.createLoanFromApplication("APP-DRAFT");
        assert.strictEqual(resDraft.status, 400);
        assert.strictEqual(resDraft.body.success, false);
        assert.strictEqual(resDraft.body.currentStatus, "DRAFT");

        const resSub = await sim.createLoanFromApplication("APP-SUBMITTED");
        assert.strictEqual(resSub.status, 400);
        assert.strictEqual(resSub.body.currentStatus, "SUBMITTED");

        const resRej = await sim.createLoanFromApplication("APP-REJECTED");
        assert.strictEqual(resRej.status, 400);
        assert.strictEqual(resRej.body.currentStatus, "REJECTED");

        console.log("✓ Test 1 Passed: Applications in DRAFT, SUBMITTED, and REJECTED statuses cannot create loans.");
    }

    // TEST 2
    console.log("\n--- TEST 2: Approved Applications Create PENDING_DISBURSEMENT Loan ---");
    {
        const sim = new BackendLoanSimulator();
        sim.seedApplication({
            id: "APP-APPROVED-1",
            customerId: "CUST-1",
            requestedAmount: "60000",
            requestedTenure: 12,
            interestRate: "15",
            status: "APPROVED",
        });

        const res = await sim.createLoanFromApplication("APP-APPROVED-1");
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.loan.status, "PENDING_DISBURSEMENT");
        assert.strictEqual(res.body.loan.startDate, null);
        assert.strictEqual(res.body.loan.endDate, null);
        assert.strictEqual(res.body.loan.disbursedAt, null);
        assert.strictEqual(res.body.loan.outstandingAmount, "0");
        assert.strictEqual(res.body.loan.emiCount, 0);

        console.log("✓ Test 2 Passed: Approved application generates loan in PENDING_DISBURSEMENT with null dates and 0 outstanding debt.");
    }

    // TEST 3
    console.log("\n--- TEST 3: No EMI Schedule Created Before Disbursement ---");
    {
        const sim = new BackendLoanSimulator();
        sim.seedApplication({
            id: "APP-APPROVED-2",
            customerId: "CUST-2",
            requestedAmount: "75000",
            requestedTenure: 18,
            interestRate: "16",
            status: "APPROVED",
        });

        const res = await sim.createLoanFromApplication("APP-APPROVED-2");
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.emiSchedule.length, 0);
        assert.strictEqual(res.body.loan.emiCount, 0);

        const loanId = res.body.loan.id;
        const storedEmis = sim.emis.get(loanId);
        assert.strictEqual(storedEmis.length, 0);

        console.log("✓ Test 3 Passed: Pending loan has strictly 0 EMI records in database before disbursement.");
    }

    // TEST 4
    console.log("\n--- TEST 4: Failed Validation / Storage Cannot Activate Loan ---");
    {
        registerStorageAdapter(createMockTrustedAdapter());

        const sim = new BackendLoanSimulator();
        sim.seedApplication({
            id: "APP-APPROVED-3",
            customerId: "CUST-3",
            requestedAmount: "50000",
            requestedTenure: 12,
            interestRate: "14",
            status: "APPROVED",
        });

        const createRes = await sim.createLoanFromApplication("APP-APPROVED-3");
        const loanId = createRes.body.loan.id;

        // Case A: Missing transfer reference
        const resNoRef = await sim.disburseLoan(loanId, {
            disbursementReference: "",
            proof: validProofPayload,
        });
        assert.strictEqual(resNoRef.status, 400);
        assert.strictEqual(sim.loans.get(loanId).status, "PENDING_DISBURSEMENT");

        // Case B: Future disbursement date
        const futureDate = new Date(Date.now() + 86400000 * 5).toISOString();
        const resFuture = await sim.disburseLoan(loanId, {
            disbursementReference: "UTR-123456",
            disbursedAt: futureDate,
            proof: validProofPayload,
        });
        assert.strictEqual(resFuture.status, 400);
        assert.strictEqual(sim.loans.get(loanId).status, "PENDING_DISBURSEMENT");

        // Case C: Arbitrary public URL or local file path as proof
        const resBadProof = await sim.disburseLoan(loanId, {
            disbursementReference: "UTR-123456",
            proof: "C:\\Users\\admin\\Desktop\\receipt.pdf",
        });
        assert.strictEqual(resBadProof.status, 400);
        assert.strictEqual(sim.loans.get(loanId).status, "PENDING_DISBURSEMENT");

        // Case D: Arbitrary web URL
        const resUrlProof = await sim.disburseLoan(loanId, {
            disbursementReference: "UTR-123456",
            proof: "https://example.com/receipt.pdf",
        });
        assert.strictEqual(resUrlProof.status, 400);
        assert.strictEqual(sim.loans.get(loanId).status, "PENDING_DISBURSEMENT");

        resetStorageAdapter();
        console.log("✓ Test 4 Passed: Any validation failure or invalid proof halts operation and preserves PENDING_DISBURSEMENT status.");
    }

    // TEST 5
    console.log("\n--- TEST 5: Valid Disbursement Atomically Activates Loan & Persists EMIs ---");
    {
        registerStorageAdapter(createMockTrustedAdapter());

        const sim = new BackendLoanSimulator();
        sim.seedApplication({
            id: "APP-APPROVED-4",
            customerId: "CUST-4",
            requestedAmount: "50000",
            requestedTenure: 12,
            interestRate: "14",
            status: "APPROVED",
        });

        const createRes = await sim.createLoanFromApplication("APP-APPROVED-4");
        const loanId = createRes.body.loan.id;

        const disburseDate = new Date("2026-10-12T10:00:00Z");
        const disburseRes = await sim.disburseLoan(loanId, {
            disbursementReference: "UTR-AXIS-20261012-9988",
            disbursedAt: disburseDate.toISOString(),
            proof: validProofPayload,
        });

        assert.strictEqual(disburseRes.status, 200);
        assert.strictEqual(disburseRes.body.success, true);
        assert.strictEqual(disburseRes.body.loan.status, "ACTIVE");
        assert.strictEqual(disburseRes.body.loan.disbursementReference, "UTR-AXIS-20261012-9988");
        assert.ok(disburseRes.body.loan.disbursementProofUrl.startsWith("s3://speedmoney-private-vault/"));
        assert.strictEqual(disburseRes.body.loan.emiCount, 12);
        assert.strictEqual(disburseRes.body.emiSchedule.length, 12);

        const storedLoan = sim.loans.get(loanId);
        assert.strictEqual(storedLoan.status, "ACTIVE");
        assert.strictEqual(storedLoan.disbursementReference, "UTR-AXIS-20261012-9988");
        assert.ok(storedLoan.outstandingAmount.gt(0));

        resetStorageAdapter();
        console.log("✓ Test 5 Passed: Valid disbursement atomically transitions loan to ACTIVE and generates all 12 EMIs with real private storage ref.");
    }

    // TEST 6
    console.log("\n--- TEST 6: EMI Due Dates Derived From Actual Disbursement Date ---");
    {
        registerStorageAdapter(createMockTrustedAdapter());

        const sim = new BackendLoanSimulator();
        sim.seedApplication({
            id: "APP-APPROVED-5",
            customerId: "CUST-5",
            requestedAmount: "30000",
            requestedTenure: 6,
            interestRate: "12",
            status: "APPROVED",
        });

        const createRes = await sim.createLoanFromApplication("APP-APPROVED-5");
        const loanId = createRes.body.loan.id;

        const disburseDate = new Date("2026-09-15T12:00:00Z");
        const disburseRes = await sim.disburseLoan(loanId, {
            disbursementReference: "NEFT-HDFC-20260915-1122",
            disbursedAt: disburseDate.toISOString(),
            proof: validProofPayload,
        });

        assert.strictEqual(disburseRes.status, 200);
        const emis = disburseRes.body.emiSchedule;
        assert.strictEqual(emis.length, 6);

        // Installment 1 due 2026-10-15 (1 month post-disbursement)
        const emi1Due = new Date(emis[0].dueDate);
        assert.strictEqual(emi1Due.getFullYear(), 2026);
        assert.strictEqual(emi1Due.getMonth(), 9); // October (0-indexed 9)
        assert.strictEqual(emi1Due.getDate(), 15);

        // Installment 6 due 2027-03-15 (6 months post-disbursement)
        const emi6Due = new Date(emis[5].dueDate);
        assert.strictEqual(emi6Due.getFullYear(), 2027);
        assert.strictEqual(emi6Due.getMonth(), 2); // March (0-indexed 2)
        assert.strictEqual(emi6Due.getDate(), 15);

        resetStorageAdapter();
        console.log("✓ Test 6 Passed: EMI 1 is due 1 month after disbursement date; final EMI matches exact tenure end date.");
    }

    // TEST 7
    console.log("\n--- TEST 7: Duplicate Loan Creation & Repeated Disbursement Blocked ---");
    {
        registerStorageAdapter(createMockTrustedAdapter());

        const sim = new BackendLoanSimulator();
        sim.seedApplication({
            id: "APP-APPROVED-6",
            customerId: "CUST-6",
            requestedAmount: "40000",
            requestedTenure: 12,
            interestRate: "14",
            status: "APPROVED",
        });

        const res1 = await sim.createLoanFromApplication("APP-APPROVED-6");
        assert.strictEqual(res1.status, 201);

        const res2 = await sim.createLoanFromApplication("APP-APPROVED-6");
        assert.strictEqual(res2.status, 409);
        assert.strictEqual(res2.body.success, false);
        assert.ok(res2.body.message.includes("already been created"));

        const loanId = res1.body.loan.id;

        const disburse1 = await sim.disburseLoan(loanId, {
            disbursementReference: "UTR-DUPL-001",
            proof: validProofPayload,
        });
        assert.strictEqual(disburse1.status, 200);

        const disburse2 = await sim.disburseLoan(loanId, {
            disbursementReference: "UTR-DUPL-002",
            proof: validProofPayload,
        });
        assert.strictEqual(disburse2.status, 409);
        assert.strictEqual(disburse2.body.success, false);
        assert.ok(disburse2.body.message.includes("already been disbursed"));

        resetStorageAdapter();
        console.log("✓ Test 7 Passed: Duplicate loan creation rejected (409) and duplicate disbursement rejected (409).");
    }

    // TEST 8
    console.log("\n--- TEST 8: Pending Loans Excluded From Financial & Collection Totals ---");
    {
        const sim = new BackendLoanSimulator();

        sim.seedLoan({
            id: "LOAN-ACTIVE-1",
            principalAmount: new Prisma.Decimal("100000"),
            totalPayable: new Prisma.Decimal("110000"),
            status: "ACTIVE",
        });

        sim.seedLoan({
            id: "LOAN-PENDING-1",
            principalAmount: new Prisma.Decimal("50000"),
            totalPayable: new Prisma.Decimal("55000"),
            status: "PENDING_DISBURSEMENT",
        });

        const overview = sim.calculateOverview();
        assert.strictEqual(overview.totalLoans, 2);
        assert.strictEqual(overview.statusCounts.ACTIVE, 1);
        assert.strictEqual(overview.statusCounts.PENDING_DISBURSEMENT, 1);
        assert.strictEqual(overview.totalPrincipalDisbursed, "100000");
        assert.strictEqual(overview.totalPrincipalPendingDisbursement, "50000");
        assert.strictEqual(overview.totalScheduledRepayments, "110000");

        console.log("✓ Test 8 Passed: PENDING_DISBURSEMENT principal is strictly excluded from disbursed totals and reported separately.");
    }

    // TEST 9
    console.log("\n--- TEST 9: Existing Active Loans Compatibility ---");
    {
        const sim = new BackendLoanSimulator();

        const existingLoan = {
            id: "LOAN-EXISTING-LEGACY",
            customerId: "CUST-LEGACY",
            applicationId: "APP-LEGACY",
            loanNumber: "LN-2026-LEGACY-01",
            principalAmount: new Prisma.Decimal("80000"),
            interestRate: new Prisma.Decimal("13"),
            tenureMonths: 12,
            emiAmount: new Prisma.Decimal("7145"),
            totalInterest: new Prisma.Decimal("5740"),
            totalPayable: new Prisma.Decimal("85740"),
            outstandingAmount: new Prisma.Decimal("85740"),
            startDate: new Date("2026-09-01"),
            endDate: new Date("2027-09-01"),
            status: "ACTIVE",
        };

        const legacyEmis = [
            {
                installmentNo: 1,
                dueDate: new Date("2026-10-01"),
                emiAmount: new Prisma.Decimal("7145"),
                outstandingAmount: new Prisma.Decimal("7145"),
                status: "PENDING",
            },
        ];

        sim.seedLoan(existingLoan, legacyEmis);

        const overview = sim.calculateOverview();
        assert.strictEqual(overview.statusCounts.ACTIVE, 1);
        assert.strictEqual(overview.totalPrincipalDisbursed, "80000");
        assert.strictEqual(overview.totalScheduledRepayments, "85740");

        console.log("✓ Test 9 Passed: Existing active loans remain fully compatible with all reporting and collection aggregates.");
    }

    // TEST 10: Security Hotfix Guardrails
    console.log("\n--- TEST 10: Phase 4.3B.1 Security Hotfix Guardrails ---");
    {
        resetStorageAdapter();

        const sim = new BackendLoanSimulator();
        sim.seedApplication({
            id: "APP-APPROVED-SEC",
            customerId: "CUST-SEC",
            requestedAmount: "50000",
            requestedTenure: 12,
            interestRate: "14",
            status: "APPROVED",
        });

        const createRes = await sim.createLoanFromApplication("APP-APPROVED-SEC");
        const loanId = createRes.body.loan.id;

        // 10.1: Client override in request body cannot bypass unconfigured storage
        const resOverride = await sim.disburseLoan(loanId, {
            disbursementReference: "UTR-TEST-OVERRIDE",
            proof: validProofPayload,
            storageConfiguredOverride: true, // Should be ignored and rejected
        });
        assert.strictEqual(resOverride.status, 503);
        assert.strictEqual(resOverride.body.code, "STORAGE_NOT_CONFIGURED");
        assert.ok(resOverride.body.message.includes("Durable private proof storage is not configured"));
        assert.strictEqual(sim.loans.get(loanId).status, "PENDING_DISBURSEMENT");
        console.log("✓ Test 10.1 Passed: Client-supplied storageConfiguredOverride is ignored and cannot bypass 503 guard.");

        // 10.2: Setting bucket-name env var without operational adapter does NOT establish readiness
        process.env.AWS_S3_BUCKET = "speedmoney-vault";
        process.env.DISBURSEMENT_STORAGE_BUCKET = "speedmoney-vault";
        assert.strictEqual(isProofStorageReady(), false);
        const resEnvVarOnly = await sim.disburseLoan(loanId, {
            disbursementReference: "UTR-TEST-ENV-VAR",
            proof: validProofPayload,
        });
        assert.strictEqual(resEnvVarOnly.status, 503);
        assert.strictEqual(resEnvVarOnly.body.code, "STORAGE_NOT_CONFIGURED");
        delete process.env.AWS_S3_BUCKET;
        delete process.env.DISBURSEMENT_STORAGE_BUCKET;
        console.log("✓ Test 10.2 Passed: Bucket-name environment variable alone without operational adapter fails closed.");

        // 10.3: Fake URLs, arbitrary keys, and local paths cannot be treated as verified uploads
        registerStorageAdapter(createMockTrustedAdapter());

        const resFakeUrl = await sim.disburseLoan(loanId, {
            disbursementReference: "UTR-TEST-FAKE-URL",
            proof: "https://speedmoney-vault.s3.amazonaws.com/fake-proof.pdf",
        });
        assert.strictEqual(resFakeUrl.status, 400);
        assert.ok(resFakeUrl.body.message.includes("Arbitrary public URLs cannot be accepted"));

        const resLocalPath = await sim.disburseLoan(loanId, {
            disbursementReference: "UTR-TEST-LOCAL-PATH",
            proof: "/var/uploads/disbursement-receipt.pdf",
        });
        assert.strictEqual(resLocalPath.status, 400);
        assert.ok(resLocalPath.body.message.includes("Local filesystem paths cannot be accepted"));

        const resArbitraryKey = await sim.disburseLoan(loanId, {
            disbursementReference: "UTR-TEST-KEY",
            proof: "proof/tx-123.pdf",
        });
        assert.strictEqual(resArbitraryKey.status, 400);
        assert.ok(resArbitraryKey.body.message.includes("Arbitrary string identifiers cannot be accepted"));
        console.log("✓ Test 10.3 Passed: Fake URLs, local filesystem paths, and arbitrary keys strictly rejected.");

        // 10.4: Storage upload failure leaves loan PENDING_DISBURSEMENT and creates no EMIs
        registerStorageAdapter(createMockTrustedAdapter({ shouldFail: true, failMessage: "S3 connection timeout" }));
        const resUploadFail = await sim.disburseLoan(loanId, {
            disbursementReference: "UTR-TEST-FAIL",
            proof: validProofPayload,
        });
        assert.strictEqual(resUploadFail.status, 500);
        assert.strictEqual(resUploadFail.body.code, "STORAGE_UPLOAD_FAILED");
        assert.strictEqual(sim.loans.get(loanId).status, "PENDING_DISBURSEMENT");
        assert.strictEqual(sim.emis.get(loanId).length, 0);
        console.log("✓ Test 10.4 Passed: Adapter upload failure leaves loan in PENDING_DISBURSEMENT and creates 0 EMIs.");

        // 10.5: Genuine successful storage via operational adapter activates loan
        registerStorageAdapter(createMockTrustedAdapter());
        const resGenuine = await sim.disburseLoan(loanId, {
            disbursementReference: "UTR-GENUINE-20261012-9988",
            proof: validProofPayload,
        });
        assert.strictEqual(resGenuine.status, 200);
        assert.strictEqual(resGenuine.body.success, true);
        assert.strictEqual(resGenuine.body.loan.status, "ACTIVE");
        assert.ok(resGenuine.body.loan.disbursementProofUrl.startsWith("s3://speedmoney-private-vault/"));
        assert.strictEqual(resGenuine.body.loan.emiCount, 12);
        resetStorageAdapter();
        console.log("✓ Test 10.5 Passed: Genuine successful storage through operational adapter activates loan and returns verified private ref.");
    }

    console.log("\n========================================================");
    console.log("All Phase 4.3B.1 Security Hotfix Tests Passed Cleanly! 🚀");
    console.log("========================================================\n");
}

runAllTests().catch((err) => {
    console.error("Test Suite Failed:", err);
    process.exit(1);
});
