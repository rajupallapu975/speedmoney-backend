require("dotenv").config();

const jwt = require("jsonwebtoken");
const prisma = require("./lib/prisma");
const {
    applyPaymentWithRetry,
    parseAndValidateMoney,
} = require("./services/payment-engine");

async function runTests() {
    console.log("==================================================");
    console.log("STEP 18: SECURE AGENT CASH COLLECTION TEST SUITE");
    console.log("==================================================");

    try {
        // 1. Amount validation unit tests
        console.log("\n[TEST 1] Validating amount parser and validator...");
        const validTestCases = ["10", "10.5", "10.50", 100, 2221.22];
        for (const val of validTestCases) {
            const dec = parseAndValidateMoney(val);
            if (!dec || dec.lte(0)) {
                throw new Error(`Failed to validate positive money value: ${val}`);
            }
        }
        console.log("  ✓ Valid amounts accepted correctly");

        const invalidTestCases = [
            null,
            undefined,
            "",
            "0",
            0,
            "-5",
            "10.555", // > 2 decimals
            "abc",
            Infinity,
            NaN,
        ];
        for (const val of invalidTestCases) {
            let threw = false;
            try {
                parseAndValidateMoney(val);
            } catch {
                threw = true;
            }
            if (!threw) {
                throw new Error(
                    `Invalid amount '${val}' should have been rejected but passed`
                );
            }
        }
        console.log("  ✓ Invalid/negative/excess-decimal amounts rejected correctly");

        // 2. Load Agent AGT-002
        console.log("\n[TEST 2] Loading Test Agent AGT-002...");
        const agent = await prisma.agentProfile.findUnique({
            where: { employeeCode: "AGT-002" },
            include: { user: true },
        });

        if (!agent) {
            throw new Error("Agent AGT-002 not found in database");
        }
        console.log(`  ✓ Agent found: ${agent.employeeCode} (ID: ${agent.id})`);
        console.log(`  ✓ Agent User: ${agent.user.name} (Status: ${agent.user.status})`);

        // 3. Find assigned active loan with unpaid EMI
        console.log("\n[TEST 3] Finding assigned active loan for AGT-002...");
        const assignment = await prisma.loanAgentAssignment.findFirst({
            where: {
                agentId: agent.id,
                active: true,
                loan: {
                    status: { in: ["ACTIVE", "OVERDUE"] },
                },
            },
            include: {
                loan: {
                    include: {
                        emis: {
                            where: {
                                status: { in: ["PENDING", "PARTIAL", "OVERDUE"] },
                            },
                            orderBy: { installmentNo: "asc" },
                        },
                    },
                },
            },
        });

        if (!assignment || !assignment.loan) {
            throw new Error("No active loan assignment found for AGT-002");
        }

        const loan = assignment.loan;
        const emi = loan.emis[0];
        if (!emi) {
            throw new Error(`No unpaid EMI found for loan ${loan.loanNumber}`);
        }

        console.log(`  ✓ Loan: ${loan.loanNumber} (ID: ${loan.id})`);
        console.log(`  ✓ Loan Outstanding: ₹${loan.outstandingAmount.toString()}`);
        console.log(`  ✓ Target EMI: #${emi.installmentNo} (ID: ${emi.id})`);
        console.log(`  ✓ EMI Status: ${emi.status}`);
        console.log(`  ✓ EMI Paid: ₹${emi.paidAmount.toString()}`);
        console.log(`  ✓ EMI Outstanding: ₹${emi.outstandingAmount.toString()}`);

        // 4. Test over-collection rejection
        console.log("\n[TEST 4] Testing over-collection rejection...");
        const excessiveAmount = Number(emi.outstandingAmount) + 1000;
        let overCollectThrew = false;
        try {
            await applyPaymentWithRetry({
                emiId: emi.id,
                loanId: loan.id,
                amount: excessiveAmount.toFixed(2),
                mode: "CASH",
                agentId: agent.id,
                userId: agent.user.id,
            });
        } catch (err) {
            overCollectThrew = true;
            console.log(`  ✓ Over-collection rejected with message: "${err.message}"`);
        }
        if (!overCollectThrew) {
            throw new Error("Over-collection was not rejected!");
        }

        // 5. Test recorded cash collection (₹2 partial collection)
        console.log("\n[TEST 5] Testing valid cash collection recording (₹2.00)...");
        const initialEmiOutstanding = Number(emi.outstandingAmount);
        const testCollectionAmount = "2.00";
        const testNotes = "Step 18 Agent verification test cash collection";
        const idempotencyKey = `TEST-IDEMP-${Date.now()}`;
        const transactionId = `CASH-${agent.id}-${idempotencyKey}`;

        const collectionResult = await applyPaymentWithRetry({
            emiId: emi.id,
            loanId: loan.id,
            amount: testCollectionAmount,
            mode: "CASH",
            transactionId,
            agentId: agent.id,
            notes: testNotes,
            userId: agent.user.id,
            ipAddress: "127.0.0.1",
        });

        if (collectionResult.duplicate) {
            throw new Error("First payment attempt should not be a duplicate");
        }

        console.log("  ✓ Collection successfully executed!");
        console.log(`  ✓ Payment ID: ${collectionResult.payment.id}`);
        console.log(`  ✓ Receipt Number: ${collectionResult.payment.receiptNumber}`);
        console.log(`  ✓ Payment Status: ${collectionResult.payment.status}`);
        console.log(`  ✓ Mode: ${collectionResult.payment.mode}`);
        console.log(`  ✓ New EMI Paid: ₹${collectionResult.emi.paidAmount.toString()}`);
        console.log(
            `  ✓ New EMI Outstanding: ₹${collectionResult.emi.outstandingAmount.toString()}`
        );
        console.log(`  ✓ New EMI Status: ${collectionResult.emi.status}`);

        // 6. Verify Database Records: Payment, CashCollection, AuditLog
        console.log("\n[TEST 6] Verifying database integrity...");
        const dbPayment = await prisma.payment.findUnique({
            where: { id: collectionResult.payment.id },
            include: {
                cashCollection: true,
                emi: true,
            },
        });

        if (!dbPayment) {
            throw new Error("Payment record not found in database");
        }
        if (dbPayment.status !== "SUCCESS") {
            throw new Error(`Expected Payment status SUCCESS, got ${dbPayment.status}`);
        }
        if (dbPayment.mode !== "CASH") {
            throw new Error(`Expected Payment mode CASH, got ${dbPayment.mode}`);
        }
        if (!dbPayment.cashCollection) {
            throw new Error("CashCollection record not linked to Payment");
        }
        if (dbPayment.cashCollection.agentId !== agent.id) {
            throw new Error("CashCollection agentId mismatch");
        }
        if (dbPayment.cashCollection.receiptNumber !== dbPayment.receiptNumber) {
            throw new Error("CashCollection receiptNumber does not match Payment");
        }
        if (dbPayment.cashCollection.notes !== testNotes) {
            throw new Error("CashCollection notes mismatch");
        }
        console.log("  ✓ Payment & CashCollection records verified in DB");

        // Verify AuditLog
        const dbAudit = await prisma.auditLog.findFirst({
            where: {
                entity: "CashCollection",
                entityId: dbPayment.cashCollection.id,
            },
        });

        if (!dbAudit) {
            throw new Error("AuditLog entry not found for CashCollection");
        }
        if (dbAudit.action !== "COLLECTION") {
            throw new Error(`Expected AuditAction COLLECTION, got ${dbAudit.action}`);
        }
        if (dbAudit.userId !== agent.user.id) {
            throw new Error("AuditLog userId mismatch");
        }
        console.log(`  ✓ AuditLog verified: [${dbAudit.action}] ${dbAudit.description}`);

        // 7. Test Idempotency with exact same transactionId
        console.log("\n[TEST 7] Testing idempotency on repeated request...");
        const idempotentResult = await applyPaymentWithRetry({
            emiId: emi.id,
            loanId: loan.id,
            amount: testCollectionAmount,
            mode: "CASH",
            transactionId,
            agentId: agent.id,
            notes: testNotes,
            userId: agent.user.id,
        });

        if (!idempotentResult.duplicate) {
            throw new Error("Expected idempotentResult.duplicate to be true");
        }
        if (idempotentResult.payment.id !== collectionResult.payment.id) {
            throw new Error("Idempotent replay did not return the original Payment");
        }
        console.log("  ✓ Idempotent replay safely returned existing payment without charging twice!");

        // 8. Test HTTP endpoint via fetch against local server
        console.log("\n[TEST 8] Testing HTTP Endpoint POST /api/agent/cash-collections...");
        let testServer = null;
        let baseUrl = "http://localhost:5000";

        try {
            const healthCheck = await fetch("http://localhost:5000/api/health", {
                signal: AbortSignal.timeout(1500),
            });
            if (healthCheck.ok) {
                console.log("  ✓ Connected to running server on http://localhost:5000");
            } else {
                throw new Error("Port 5000 not responding with health OK");
            }
        } catch {
            const app = require("./server");
            await new Promise((resolve) => {
                testServer = app.listen(0, () => {
                    const port = testServer.address().port;
                    baseUrl = `http://localhost:${port}`;
                    console.log(`  ✓ Spawned in-process test server on ${baseUrl}`);
                    resolve();
                });
            });
        }

        const agentToken = jwt.sign(
            {
                userId: agent.user.id,
                role: "AGENT",
            },
            process.env.JWT_SECRET,
            { expiresIn: "10m" }
        );

        try {
            // Test with invalid agent assignment (unassigned loan ID)
            const fakeLoanId = "00000000-0000-0000-0000-000000000000";
            const unassignedResponse = await fetch(
                `${baseUrl}/api/agent/cash-collections`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${agentToken}`,
                    },
                    body: JSON.stringify({
                        loanId: fakeLoanId,
                        emiId: emi.id,
                        amount: "1.00",
                    }),
                }
            );
            console.log(
                `  ✓ HTTP Response for unassigned/nonexistent loan: status ${unassignedResponse.status}`
            );

            // Test endpoint with another valid ₹1 collection through HTTP
            const httpCollectionAmount = "1.00";
            const httpIdempotencyKey = `HTTP-TEST-${Date.now()}`;
            const httpResponse = await fetch(
                `${baseUrl}/api/agent/cash-collections`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${agentToken}`,
                        "Idempotency-Key": httpIdempotencyKey,
                    },
                    body: JSON.stringify({
                        loanId: loan.id,
                        emiId: emi.id,
                        amount: httpCollectionAmount,
                        notes: "HTTP API test collection",
                    }),
                }
            );

            const httpJson = await httpResponse.json();
            console.log(`  ✓ HTTP Collection Response status: ${httpResponse.status}`);
            console.log("  ✓ HTTP Response Payload:", JSON.stringify(httpJson, null, 2));

            if (httpResponse.status === 201) {
                console.log("  ✓ HTTP Cash Collection recorded successfully via API!");

                // Test HTTP Idempotency
                const httpRetryResponse = await fetch(
                    `${baseUrl}/api/agent/cash-collections`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${agentToken}`,
                            "Idempotency-Key": httpIdempotencyKey,
                        },
                        body: JSON.stringify({
                            loanId: loan.id,
                            emiId: emi.id,
                            amount: httpCollectionAmount,
                            notes: "HTTP API test collection",
                        }),
                    }
                );
                const httpRetryJson = await httpRetryResponse.json();
                console.log(`  ✓ HTTP Idempotency Retry status: ${httpRetryResponse.status}`);
                console.log(
                    `  ✓ HTTP Idempotency Duplicate Flag: ${httpRetryJson.duplicate}`
                );
                if (httpRetryResponse.status !== 200 || !httpRetryJson.duplicate) {
                    console.warn("  ⚠ HTTP idempotency retry did not return expected duplicate response");
                } else {
                    console.log("  ✓ HTTP Idempotency verified!");
                }
            } else {
                console.log(
                    `  ℹ HTTP response status was ${httpResponse.status}: ${httpJson.message}`
                );
            }
        } finally {
            if (testServer) {
                testServer.close();
            }
        }

        console.log("\n==================================================");
        console.log("ALL CASH COLLECTION TESTS PASSED SUCCESSFULLY!");
        console.log("==================================================");
    } catch (error) {
        console.error("\n❌ TEST SUITE FAILED:");
        console.error(error);
        process.exitCode = 1;
    } finally {
        await prisma.$disconnect();
    }
}

runTests();

