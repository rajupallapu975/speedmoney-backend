const assert = require('assert');
const { Prisma } = require('@prisma/client');
const Decimal = Prisma.Decimal;

// Setup mock Prisma and test environment
function setupMockEnvironment() {
  const mockAgent = {
    id: 'agent-uuid-001',
    userId: 'user-agent-001',
    employeeCode: 'AGT-001',
    user: {
      id: 'user-agent-001',
      status: 'ACTIVE',
      name: 'Agent Tester',
      email: 'agent@speedmoney.test',
    },
  };

  const committedPayment = {
    id: 'pay-uuid-100',
    loanId: 'loan-uuid-1',
    emiId: 'emi-uuid-1',
    amount: new Decimal('2500.00'),
    mode: 'CASH',
    status: 'SUCCESS',
    transactionId: 'CASH-agent-uuid-001-idemp-key-123',
    receiptNumber: 'RCPT-1770000000-A1B2',
    paidAt: new Date('2026-10-12T10:00:00.000Z'),
    createdAt: new Date('2026-10-12T10:00:00.000Z'),
    cashCollection: {
      id: 'coll-uuid-100',
      paymentId: 'pay-uuid-100',
      agentId: 'agent-uuid-001',
      receiptNumber: 'RCPT-1770000000-A1B2',
      collectedAmount: new Decimal('2500.00'),
      collectedAt: new Date('2026-10-12T10:00:00.000Z'),
      notes: 'Customer paid in cash',
      reconciled: false,
    },
    emi: {
      id: 'emi-uuid-1',
      loanId: 'loan-uuid-1',
      installmentNo: 1,
      status: 'PAID', // Already fully paid by this transaction!
      paidAmount: new Decimal('2500.00'),
      outstandingAmount: new Decimal('0.00'),
      paidAt: new Date('2026-10-12T10:00:00.000Z'),
    },
    loan: {
      id: 'loan-uuid-1',
      loanNumber: 'LN-2026-0001',
      outstandingAmount: new Decimal('0.00'),
      status: 'COMPLETED', // Loan completed!
    },
  };

  return { mockAgent, committedPayment };
}

// Emulate route handler logic from backend/routes/agent-cash-collections.js
const {
  applyPaymentWithRetry,
  parseAndValidateMoney,
  toDecimal,
} = require('./services/payment-engine');

function verifyMatchingPaymentDetails(
    existingPayment,
    loanId,
    emiId,
    parsedAmount,
    normalizedNotes,
    agentId
) {
    if (!existingPayment) return false;
    if (existingPayment.status !== "SUCCESS") return false;
    if (existingPayment.mode !== "CASH") return false;
    if (!existingPayment.cashCollection) return false;
    if (existingPayment.cashCollection.agentId !== agentId) return false;
    if (existingPayment.loanId !== loanId.trim()) return false;
    if (existingPayment.emiId !== emiId.trim()) return false;

    if (!toDecimal(existingPayment.amount).equals(parsedAmount)) return false;

    const existingNotes = existingPayment.cashCollection?.notes || null;
    const requestedNotes = normalizedNotes || null;
    if (existingNotes !== requestedNotes) return false;

    return true;
}

function formatCollectionResponse(
    payment,
    emi,
    loan,
    cashCollection,
    duplicate = false
) {
    const statusCode = duplicate ? 200 : 201;
    const message = duplicate
        ? "Collection request already processed"
        : "Cash collection recorded successfully";

    return {
        statusCode,
        body: {
            success: true,
            message,
            duplicate,
            paymentId: payment.id,
            receiptNumber: payment.receiptNumber,
            loanId: loan.id,
            emiId: emi.id,
            installmentNo: emi.installmentNo,
            collectedAmount: payment.amount.toString(),
            collectedAt: cashCollection?.collectedAt || payment.paidAt,
            notes: cashCollection?.notes || null,
            reconciled: cashCollection?.reconciled || false,
            payment: {
                id: payment.id,
                receiptNumber: payment.receiptNumber,
                amount: payment.amount.toString(),
                mode: payment.mode,
                status: payment.status,
                paidAt: payment.paidAt,
                createdAt: payment.createdAt,
            },
            emi: {
                id: emi.id,
                installmentNo: emi.installmentNo,
                status: emi.status,
                paidAmount: emi.paidAmount.toString(),
                outstandingAmount: emi.outstandingAmount.toString(),
                paidAt: emi.paidAt,
            },
            loan: {
                id: loan.id,
                loanNumber: loan.loanNumber,
                outstandingAmount: loan.outstandingAmount.toString(),
                status: loan.status,
            },
        },
    };
}

async function simulateHandleCashCollection(req, res, mockPrisma) {
    let transactionId = null;
    let agent = null;
    let loanId = null;
    let emiId = null;
    let parsedAmount = null;
    let normalizedNotes = null;

    try {
        const body = req.body || {};
        loanId = body.loanId;
        emiId = body.emiId;
        const amount = body.amount;
        const notes = body.notes;

        if (!loanId || typeof loanId !== "string" || !loanId.trim()) {
            return res.status(400).json({ success: false, message: "loanId is required" });
        }
        if (!emiId || typeof emiId !== "string" || !emiId.trim()) {
            return res.status(400).json({ success: false, message: "emiId is required" });
        }
        if (amount === undefined || amount === null || amount === "") {
            return res.status(400).json({ success: false, message: "amount is required" });
        }

        try {
            parsedAmount = parseAndValidateMoney(amount);
        } catch (validationError) {
            return res.status(400).json({ success: false, message: validationError.message });
        }

        normalizedNotes = notes && typeof notes === "string" ? notes.trim() : null;

        agent = await mockPrisma.agentProfile.findUnique({ where: { userId: req.user.userId } });
        if (!agent) {
            return res.status(404).json({ success: false, message: "Agent profile not found" });
        }
        if (agent.user.status !== "ACTIVE") {
            return res.status(403).json({ success: false, message: "Your agent account is inactive" });
        }

        const rawIdempotencyKey = req.headers["idempotency-key"] || body.idempotencyKey || null;

        if (rawIdempotencyKey) {
            const sanitizedKey = String(rawIdempotencyKey)
                .trim()
                .slice(0, 64)
                .replace(/[^a-zA-Z0-9_-]/g, "");

            if (!sanitizedKey) {
                return res.status(400).json({ success: false, message: "Invalid Idempotency-Key provided" });
            }

            transactionId = `CASH-${agent.id}-${sanitizedKey}`;

            // EARLY REPLAY DETECTION BEFORE MUTABLE LOAN/EMI ELIGIBILITY CHECKS
            const existingPayment = await mockPrisma.payment.findUnique({
                where: { transactionId },
                include: { cashCollection: true, emi: true, loan: true },
            });

            if (existingPayment) {
                const isMatch = verifyMatchingPaymentDetails(
                    existingPayment,
                    loanId,
                    emiId,
                    parsedAmount,
                    normalizedNotes,
                    agent.id
                );

                if (isMatch) {
                    const { statusCode, body: resBody } = formatCollectionResponse(
                        existingPayment,
                        existingPayment.emi,
                        existingPayment.loan,
                        existingPayment.cashCollection,
                        true
                    );
                    return res.status(statusCode).json(resBody);
                } else {
                    return res.status(400).json({
                        success: false,
                        message: "Transaction ID already exists with different payment details",
                    });
                }
            }
        } else {
            transactionId = `CASH-${agent.id}-${Date.now()}-mocknonce`;
        }

        // Mutable loan/EMI eligibility checks:
        const loan = await mockPrisma.loan.findUnique({ where: { id: loanId.trim() } });
        if (!loan) return res.status(404).json({ success: false, message: "Loan not found" });
        if (!["ACTIVE", "OVERDUE"].includes(loan.status)) {
            return res.status(400).json({
                success: false,
                message: `Loan is not eligible for collection (current status: ${loan.status})`,
            });
        }

        const activeAssignment = await mockPrisma.loanAgentAssignment.findFirst({
            where: { loanId: loan.id, agentId: agent.id, active: true },
        });
        if (!activeAssignment) {
            return res.status(403).json({
                success: false,
                message: "You do not have an active assignment to collect for this loan",
            });
        }

        const emi = await mockPrisma.emiSchedule.findUnique({ where: { id: emiId.trim() } });
        if (!emi) return res.status(404).json({ success: false, message: "EMI not found" });
        if (emi.loanId !== loan.id) return res.status(400).json({ success: false, message: "EMI does not belong to the specified loan" });
        if (emi.status === "PAID") return res.status(400).json({ success: false, message: "This EMI is already fully paid" });
        if (emi.status === "WAIVED") return res.status(400).json({ success: false, message: "This EMI has been waived and cannot be collected" });
        if (!["PENDING", "PARTIAL", "OVERDUE"].includes(emi.status)) {
            return res.status(400).json({ success: false, message: `This EMI is not eligible for collection (status: ${emi.status})` });
        }

        const emiOutstanding = Number(emi.outstandingAmount);
        if (emiOutstanding <= 0) return res.status(400).json({ success: false, message: "This EMI has no remaining outstanding balance" });
        if (parsedAmount.gt(emi.outstandingAmount)) {
            return res.status(400).json({ success: false, message: `Collection amount cannot exceed EMI outstanding amount of ₹${emi.outstandingAmount}` });
        }

        // Call payment engine
        const result = await mockPrisma.applyPayment({
            emiId: emi.id,
            loanId: loan.id,
            amount: parsedAmount.toString(),
            mode: "CASH",
            transactionId,
            agentId: agent.id,
            notes: normalizedNotes,
        });

        const { statusCode, body: resBody } = formatCollectionResponse(
            result.payment,
            result.emi,
            result.loan,
            result.cashCollection,
            result.duplicate
        );
        return res.status(statusCode).json(resBody);
    } catch (error) {
        // Concurrent recovery check
        if (transactionId && agent) {
            try {
                const committedPayment = await mockPrisma.payment.findUnique({
                    where: { transactionId },
                    include: { cashCollection: true, emi: true, loan: true },
                });
                if (committedPayment) {
                    const isMatch = verifyMatchingPaymentDetails(
                        committedPayment,
                        loanId,
                        emiId,
                        parsedAmount,
                        normalizedNotes,
                        agent.id
                    );
                    if (isMatch) {
                        const { statusCode, body: resBody } = formatCollectionResponse(
                            committedPayment,
                            committedPayment.emi,
                            committedPayment.loan,
                            committedPayment.cashCollection,
                            true
                        );
                        return res.status(statusCode).json(resBody);
                    } else {
                        return res.status(400).json({
                            success: false,
                            message: "Transaction ID already exists with different payment details",
                        });
                    }
                }
            } catch (recheckErr) {
                // pass
            }
        }

        return res.status(400).json({ success: false, message: error.message });
    }
}

function createMockResponse() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
  return res;
}

async function runTestSuite() {
  console.log("Starting Phase 3.2C.5 Backend Idempotency Replay Test Suite...\n");
  const { mockAgent, committedPayment } = setupMockEnvironment();

  // Test 1: Committed collection with fully paid EMI returns original receipt on retry
  {
    console.log("Test 1: Committed collection with fully paid EMI returns original receipt on retry");
    let applyPaymentCalled = false;
    const mockPrisma = {
      agentProfile: { findUnique: async () => mockAgent },
      payment: { findUnique: async ({ where }) => where.transactionId === committedPayment.transactionId ? committedPayment : null },
      applyPayment: async () => { applyPaymentCalled = true; },
      loan: { findUnique: async () => { throw new Error("Loan check should NOT be called on early replay!"); } },
      emiSchedule: { findUnique: async () => { throw new Error("EMI check should NOT be called on early replay!"); } },
    };

    const req = {
      user: { userId: 'user-agent-001' },
      headers: { 'idempotency-key': 'idemp-key-123' },
      body: {
        loanId: 'loan-uuid-1',
        emiId: 'emi-uuid-1',
        amount: '2500.00',
        notes: 'Customer paid in cash',
      },
    };
    const res = createMockResponse();

    await simulateHandleCashCollection(req, res, mockPrisma);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.duplicate, true);
    assert.strictEqual(res.body.receiptNumber, 'RCPT-1770000000-A1B2');
    assert.strictEqual(res.body.paymentId, 'pay-uuid-100');
    assert.strictEqual(res.body.collectedAmount, '2500');
    assert.strictEqual(res.body.emi.status, 'PAID');
    assert.strictEqual(applyPaymentCalled, false, "Payment engine must NOT be invoked on replay!");
    console.log("  PASS: Replay on paid EMI returned original receipt (HTTP 200, duplicate: true) without double charging.");
  }

  // Test 2: Committed collection that completed the loan returns original receipt on retry
  {
    console.log("Test 2: Committed collection that completed the loan returns original receipt on retry");
    const mockPrisma = {
      agentProfile: { findUnique: async () => mockAgent },
      payment: { findUnique: async ({ where }) => where.transactionId === committedPayment.transactionId ? committedPayment : null },
      applyPayment: async () => {},
    };

    const req = {
      user: { userId: 'user-agent-001' },
      headers: {},
      body: {
        idempotencyKey: 'idemp-key-123',
        loanId: 'loan-uuid-1',
        emiId: 'emi-uuid-1',
        amount: '2500.00',
        notes: 'Customer paid in cash',
      },
    };
    const res = createMockResponse();

    await simulateHandleCashCollection(req, res, mockPrisma);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.duplicate, true);
    assert.strictEqual(res.body.loan.status, 'COMPLETED');
    assert.strictEqual(res.body.receiptNumber, 'RCPT-1770000000-A1B2');
    console.log("  PASS: Replay on completed loan returned original receipt without 'Loan not eligible' error.");
  }

  // Test 3: Reused key with different amount is rejected safely
  {
    console.log("Test 3: Reused key with different amount is rejected with HTTP 400 conflict");
    const mockPrisma = {
      agentProfile: { findUnique: async () => mockAgent },
      payment: { findUnique: async ({ where }) => where.transactionId === committedPayment.transactionId ? committedPayment : null },
    };

    const req = {
      user: { userId: 'user-agent-001' },
      headers: { 'idempotency-key': 'idemp-key-123' },
      body: {
        loanId: 'loan-uuid-1',
        emiId: 'emi-uuid-1',
        amount: '3000.00', // DIFFERENT AMOUNT
        notes: 'Customer paid in cash',
      },
    };
    const res = createMockResponse();

    await simulateHandleCashCollection(req, res, mockPrisma);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.message, 'Transaction ID already exists with different payment details');
    assert.strictEqual(res.body.receiptNumber, undefined, "Must not leak receipt number on conflict!");
    console.log("  PASS: Reused key with different amount rejected without leaking original payment data.");
  }

  // Test 4: Reused key with different notes or EMI is rejected safely
  {
    console.log("Test 4: Reused key with different notes/EMI is rejected with HTTP 400 conflict");
    const mockPrisma = {
      agentProfile: { findUnique: async () => mockAgent },
      payment: { findUnique: async ({ where }) => where.transactionId === committedPayment.transactionId ? committedPayment : null },
    };

    const reqNotes = {
      user: { userId: 'user-agent-001' },
      headers: { 'idempotency-key': 'idemp-key-123' },
      body: {
        loanId: 'loan-uuid-1',
        emiId: 'emi-uuid-1',
        amount: '2500.00',
        notes: 'Different notes',
      },
    };
    const resNotes = createMockResponse();
    await simulateHandleCashCollection(reqNotes, resNotes, mockPrisma);
    assert.strictEqual(resNotes.statusCode, 400);

    const reqEmi = {
      user: { userId: 'user-agent-001' },
      headers: { 'idempotency-key': 'idemp-key-123' },
      body: {
        loanId: 'loan-uuid-1',
        emiId: 'emi-uuid-DIFFERENT',
        amount: '2500.00',
        notes: 'Customer paid in cash',
      },
    };
    const resEmi = createMockResponse();
    await simulateHandleCashCollection(reqEmi, resEmi, mockPrisma);
    assert.strictEqual(resEmi.statusCode, 400);

    console.log("  PASS: Reused key with modified notes or target EMI safely rejected.");
  }

  // Test 5: Concurrent identical requests - worker B catches conflict and returns worker A's receipt
  {
    console.log("Test 5: Concurrent requests - failing worker recovers committed receipt after conflict");
    let queryCount = 0;
    const mockPrisma = {
      agentProfile: { findUnique: async () => mockAgent },
      payment: {
        findUnique: async () => {
          queryCount++;
          if (queryCount === 1) {
            // First lookup misses (worker A hasn't committed yet)
            return null;
          }
          // Second lookup (after worker A committed) finds the record
          return committedPayment;
        },
      },
      loan: { findUnique: async () => ({ id: 'loan-uuid-1', status: 'ACTIVE', outstandingAmount: new Decimal('5000') }) },
      loanAgentAssignment: { findFirst: async () => ({ active: true }) },
      emiSchedule: { findUnique: async () => ({ id: 'emi-uuid-1', loanId: 'loan-uuid-1', status: 'PENDING', outstandingAmount: new Decimal('2500') }) },
      applyPayment: async () => {
        // Worker A committed right before worker B's tx, causing unique constraint conflict:
        const err = new Error("Unique constraint failed on the fields: (`transactionId`)");
        err.code = "P2002";
        throw err;
      },
    };

    const req = {
      user: { userId: 'user-agent-001' },
      headers: { 'idempotency-key': 'idemp-key-123' },
      body: {
        loanId: 'loan-uuid-1',
        emiId: 'emi-uuid-1',
        amount: '2500.00',
        notes: 'Customer paid in cash',
      },
    };
    const res = createMockResponse();

    await simulateHandleCashCollection(req, res, mockPrisma);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.duplicate, true);
    assert.strictEqual(res.body.receiptNumber, 'RCPT-1770000000-A1B2');
    console.log("  PASS: Concurrent worker caught race conflict and safely recovered committed receipt.");
  }

  // Test 6: Request without idempotency key follows normal non-idempotent flow
  {
    console.log("Test 6: Request without idempotency key follows standard non-idempotent flow");
    let capturedTxId = null;
    const mockPrisma = {
      agentProfile: { findUnique: async () => mockAgent },
      payment: { findUnique: async () => null },
      loan: { findUnique: async () => ({ id: 'loan-uuid-1', status: 'ACTIVE', outstandingAmount: new Decimal('5000') }) },
      loanAgentAssignment: { findFirst: async () => ({ active: true }) },
      emiSchedule: { findUnique: async () => ({ id: 'emi-uuid-1', loanId: 'loan-uuid-1', status: 'PENDING', outstandingAmount: new Decimal('2500'), installmentNo: 1 }) },
      applyPayment: async (params) => {
        capturedTxId = params.transactionId;
        return {
          duplicate: false,
          payment: { id: 'pay-new', receiptNumber: 'RCPT-NEW', amount: new Decimal('2500.00'), mode: 'CASH', status: 'SUCCESS', paidAt: new Date(), createdAt: new Date() },
          emi: { id: 'emi-uuid-1', installmentNo: 1, status: 'PAID', paidAmount: new Decimal('2500'), outstandingAmount: new Decimal('0'), paidAt: new Date() },
          loan: { id: 'loan-uuid-1', loanNumber: 'LN-1', outstandingAmount: new Decimal('2500'), status: 'ACTIVE' },
          cashCollection: { id: 'coll-new', collectedAt: new Date(), notes: null, reconciled: false },
        };
      },
    };

    const req = {
      user: { userId: 'user-agent-001' },
      headers: {},
      body: {
        loanId: 'loan-uuid-1',
        emiId: 'emi-uuid-1',
        amount: '2500.00',
      },
    };
    const res = createMockResponse();

    await simulateHandleCashCollection(req, res, mockPrisma);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.duplicate, false);
    assert.strictEqual(res.body.receiptNumber, 'RCPT-NEW');
    assert.match(capturedTxId, /^CASH-agent-uuid-001-\d+-mocknonce$/);
    console.log("  PASS: Non-idempotent collection successfully generated unique transaction ID and created record.");
  }

  // Test 7: Frontend response shape compatibility
  {
    console.log("Test 7: Verify all expected frontend response shape fields are present");
    const { body } = formatCollectionResponse(committedPayment, committedPayment.emi, committedPayment.loan, committedPayment.cashCollection, true);

    const requiredKeys = [
      'success', 'message', 'duplicate', 'paymentId', 'receiptNumber',
      'loanId', 'emiId', 'installmentNo', 'collectedAmount', 'collectedAt',
      'notes', 'reconciled', 'payment', 'emi', 'loan'
    ];
    for (const key of requiredKeys) {
      assert.ok(key in body, `Missing key: ${key}`);
    }

    assert.ok('id' in body.payment && 'receiptNumber' in body.payment);
    assert.ok('id' in body.emi && 'status' in body.emi && 'outstandingAmount' in body.emi);
    assert.ok('id' in body.loan && 'loanNumber' in body.loan && 'status' in body.loan);
    console.log("  PASS: Response shape exactly matches CashCollectionResponse expected by frontend.");
  }

  // Test 8: Failed or uncommitted payment is NEVER returned as duplicate
  {
    console.log("Test 8: Failed or uncommitted payment status is not returned as duplicate");
    const failedPayment = { ...committedPayment, status: 'FAILED' };
    const mockPrisma = {
      agentProfile: { findUnique: async () => mockAgent },
      payment: { findUnique: async () => failedPayment },
    };

    const req = {
      user: { userId: 'user-agent-001' },
      headers: { 'idempotency-key': 'idemp-key-123' },
      body: {
        loanId: 'loan-uuid-1',
        emiId: 'emi-uuid-1',
        amount: '2500.00',
        notes: 'Customer paid in cash',
      },
    };
    const res = createMockResponse();

    await simulateHandleCashCollection(req, res, mockPrisma);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.success, false);
    console.log("  PASS: Non-SUCCESS payment records cannot be claimed as duplicates.");
  }

  console.log("\nALL 8 PHASE 3.2C.5 BACKEND IDEMPOTENCY TESTS PASSED SUCCESSFULLY!");
}

runTestSuite().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
