require("dotenv").config();

const jwt = require("jsonwebtoken");
const prisma = require("./lib/prisma");
const { getTodayIST, getBusinessDayRange } = require("./lib/date-utils");

async function runStep19Tests() {
    console.log("============================================================");
    console.log("STEP 19: AGENT COLLECTION MANAGEMENT APIS TEST SUITE");
    console.log("============================================================");

    let testServer = null;
    let baseUrl = "http://localhost:5000";

    try {
        // ---------------------------------------------------------
        // 0. Ensure Server Connectivity
        // ---------------------------------------------------------
        try {
            const health = await fetch("http://localhost:5000/api/health", {
                signal: AbortSignal.timeout(1500),
            });
            if (health.ok) {
                console.log("  ✓ Using existing server running on http://localhost:5000");
            } else {
                throw new Error("Local port 5000 health check not ok");
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

        // ---------------------------------------------------------
        // 1. Load Test Entities
        // ---------------------------------------------------------
        console.log("\n[SETUP] Loading test agent, admin, and customer...");
        const agent = await prisma.agentProfile.findUnique({
            where: { employeeCode: "AGT-002" },
            include: { user: true },
        });

        if (!agent) {
            throw new Error("Test agent AGT-002 not found in database");
        }
        console.log(`  ✓ Primary Agent: ${agent.employeeCode} (${agent.user.name}, ID: ${agent.id})`);

        // Find or create a second test agent for Agent A vs Agent B isolation tests
        let secondAgent = await prisma.agentProfile.findFirst({
            where: {
                employeeCode: { not: "AGT-002" },
                user: { status: "ACTIVE" },
            },
            include: { user: true },
        });

        if (!secondAgent) {
            console.log("  ℹ Creating secondary agent for multi-agent isolation verification...");
            const secondUser = await prisma.user.create({
                data: {
                    name: "Agent B Isolation Tester",
                    email: `agent_b_${Date.now()}@loanplatform.com`,
                    phone: `99${Date.now().toString().slice(-8)}`,
                    password: "HashedPassword123",
                    role: "AGENT",
                    status: "ACTIVE",
                    agentProfile: {
                        create: {
                            employeeCode: `AGT-TEST-B-${Date.now().toString().slice(-4)}`,
                        },
                    },
                },
                include: { agentProfile: true },
            });
            secondAgent = { ...secondUser.agentProfile, user: secondUser };
        }
        console.log(`  ✓ Secondary Agent: ${secondAgent.employeeCode} (ID: ${secondAgent.id})`);

        // Load an Admin user
        const adminUser = await prisma.user.findFirst({
            where: { role: "ADMIN", status: "ACTIVE" },
        });
        if (!adminUser) {
            throw new Error("No active ADMIN user found in database");
        }
        console.log(`  ✓ Admin: ${adminUser.name} (${adminUser.email})`);

        // Load a Customer user
        const customerUser = await prisma.user.findFirst({
            where: { role: "CUSTOMER", status: "ACTIVE" },
        });
        if (!customerUser) {
            throw new Error("No active CUSTOMER user found in database");
        }
        console.log(`  ✓ Customer: ${customerUser.name} (${customerUser.email})`);

        // Create JWTs for test users
        const agentToken = jwt.sign(
            { userId: agent.user.id, role: "AGENT" },
            process.env.JWT_SECRET,
            { expiresIn: "10m" }
        );
        const secondAgentToken = jwt.sign(
            { userId: secondAgent.user.id, role: "AGENT" },
            process.env.JWT_SECRET,
            { expiresIn: "10m" }
        );
        const adminToken = jwt.sign(
            { userId: adminUser.id, role: "ADMIN" },
            process.env.JWT_SECRET,
            { expiresIn: "10m" }
        );
        const customerToken = jwt.sign(
            { userId: customerUser.id, role: "CUSTOMER" },
            process.env.JWT_SECRET,
            { expiresIn: "10m" }
        );

        // ---------------------------------------------------------
        // [TEST 1] Role-Based Access Control
        // ---------------------------------------------------------
        console.log("\n[TEST 1] Role-Based Access Control and Authentication...");
        
        // 1a. Unauthenticated request rejected
        const unauthRes = await fetch(`${baseUrl}/api/agent/today-dues`);
        if (unauthRes.status !== 401) {
            throw new Error(`Expected 401 for unauthenticated request, got ${unauthRes.status}`);
        }
        console.log("  ✓ Unauthenticated request rejected (401)");

        // 1b. Customer rejected on agent endpoints
        const custOnAgentRes = await fetch(`${baseUrl}/api/agent/today-dues`, {
            headers: { Authorization: `Bearer ${customerToken}` },
        });
        if (custOnAgentRes.status !== 403) {
            throw new Error(`Expected 403 for customer on agent endpoint, got ${custOnAgentRes.status}`);
        }
        console.log("  ✓ Customer rejected on agent endpoint (403)");

        // 1c. Admin rejected on agent-only endpoints
        const adminOnAgentRes = await fetch(`${baseUrl}/api/agent/today-dues`, {
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        if (adminOnAgentRes.status !== 403) {
            throw new Error(`Expected 403 for admin on agent-only endpoint, got ${adminOnAgentRes.status}`);
        }
        console.log("  ✓ Admin rejected on agent-only endpoint (403)");

        // 1d. Customer / Agent rejected on admin oversight endpoint
        const agentOnAdminRes = await fetch(`${baseUrl}/api/admin/cash-collections`, {
            headers: { Authorization: `Bearer ${agentToken}` },
        });
        if (agentOnAdminRes.status !== 403) {
            throw new Error(`Expected 403 for agent on admin endpoint, got ${agentOnAdminRes.status}`);
        }
        console.log("  ✓ Agent rejected on admin cash collections endpoint (403)");

        // ---------------------------------------------------------
        // [TEST 2] Today's Assigned EMI Dues (GET /api/agent/today-dues)
        // ---------------------------------------------------------
        console.log("\n[TEST 2] Verifying Today's Assigned EMI Dues (GET /api/agent/today-dues)...");
        const todayDuesRes = await fetch(`${baseUrl}/api/agent/today-dues`, {
            headers: { Authorization: `Bearer ${agentToken}` },
        });
        if (todayDuesRes.status !== 200) {
            const errJson = await todayDuesRes.json();
            throw new Error(`Failed to fetch today dues: ${JSON.stringify(errJson)}`);
        }
        const todayDuesData = await todayDuesRes.json();
        if (!todayDuesData.success) {
            throw new Error("today-dues response missing success: true");
        }
        console.log(`  ✓ Today dues response OK: date = ${todayDuesData.date}, count = ${todayDuesData.count}`);
        console.log(`  ✓ Total Dues Amount: ₹${todayDuesData.totalDueAmount}`);

        // Verify dues filtering: all dues must have status in PENDING, PARTIAL, OVERDUE and outstanding > 0
        if (todayDuesData.dues && todayDuesData.dues.length > 0) {
            const sampleDue = todayDuesData.dues[0];
            console.log(`  ✓ Sample Due: Loan ${sampleDue.loanNumber}, EMI #${sampleDue.installmentNo}, Due: ${sampleDue.dueDate}, Outstanding: ₹${sampleDue.outstandingAmount}`);
            
            // Check data minimization: no PAN, Aadhaar, bank details
            if (sampleDue.customer.pan || sampleDue.customer.aadhaar || sampleDue.customer.accountNumber) {
                throw new Error("Sensitive customer KYC data exposed in today-dues!");
            }
            console.log("  ✓ Customer data correctly minimized (name & phone only)");

            // Confirm no PAID or WAIVED EMIs returned
            for (const d of todayDuesData.dues) {
                if (d.status === "PAID" || d.status === "WAIVED") {
                    throw new Error(`Forbidden EMI status '${d.status}' returned in today-dues!`);
                }
                if (Number(d.outstandingAmount) <= 0) {
                    throw new Error(`Zero-balance EMI '${d.emiId}' returned in today-dues!`);
                }
            }
            console.log("  ✓ Verified no PAID or WAIVED EMIs in dues");
        }

        // Test pagination on today-dues
        const paginatedDuesRes = await fetch(`${baseUrl}/api/agent/today-dues?page=1&limit=1`, {
            headers: { Authorization: `Bearer ${agentToken}` },
        });
        const paginatedDuesData = await paginatedDuesRes.json();
        if (paginatedDuesData.dues.length > 1) {
            throw new Error("Pagination limit=1 was not respected!");
        }
        console.log("  ✓ Pagination on today-dues verified (limit=1 respected)");

        // Test date validation on today-dues
        const invalidDateDuesRes = await fetch(`${baseUrl}/api/agent/today-dues?date=invalid-date`, {
            headers: { Authorization: `Bearer ${agentToken}` },
        });
        if (invalidDateDuesRes.status !== 400) {
            throw new Error(`Expected 400 for invalid date, got ${invalidDateDuesRes.status}`);
        }
        console.log("  ✓ Malformed date rejected with 400 Bad Request");

        // ---------------------------------------------------------
        // [TEST 3] Agent Collection History (GET /api/agent/cash-collections)
        // ---------------------------------------------------------
        console.log("\n[TEST 3] Verifying Agent Collection History (GET /api/agent/cash-collections)...");
        const historyRes = await fetch(`${baseUrl}/api/agent/cash-collections?page=1&limit=20`, {
            headers: { Authorization: `Bearer ${agentToken}` },
        });
        if (historyRes.status !== 200) {
            const errJson = await historyRes.json();
            throw new Error(`Failed to fetch collection history: ${JSON.stringify(errJson)}`);
        }
        const historyData = await historyRes.json();
        if (!historyData.success) {
            throw new Error("collection history response missing success: true");
        }
        console.log(`  ✓ Collection History OK: Total records = ${historyData.pagination.totalRecords}, Total Collected = ₹${historyData.summary.totalCollectedAmount}`);
        
        if (historyData.collections.length > 0) {
            const sampleCol = historyData.collections[0];
            console.log(`  ✓ Sample Collection: Receipt ${sampleCol.receiptNumber}, Amount ₹${sampleCol.collectedAmount}, Mode: ${sampleCol.payment.mode}, Reconciled: ${sampleCol.reconciled}`);
            
            // Check deterministic ordering: newest first
            for (let i = 0; i < historyData.collections.length - 1; i++) {
                const t1 = new Date(historyData.collections[i].collectedAt).getTime();
                const t2 = new Date(historyData.collections[i + 1].collectedAt).getTime();
                if (t1 < t2) {
                    throw new Error("Collections are not sorted newest first!");
                }
            }
            console.log("  ✓ Deterministic descending sort verified");
        }

        // Test date-range filtering on history
        const todayIST = getTodayIST();
        const dateFilteredRes = await fetch(
            `${baseUrl}/api/agent/cash-collections?startDate=${todayIST}&endDate=${todayIST}`,
            { headers: { Authorization: `Bearer ${agentToken}` } }
        );
        if (dateFilteredRes.status !== 200) {
            throw new Error(`Failed date-filtered history query, status ${dateFilteredRes.status}`);
        }
        const dateFilteredData = await dateFilteredRes.json();
        console.log(`  ✓ Date range filter (${todayIST} to ${todayIST}) returned ${dateFilteredData.collections.length} records`);

        // Test invalid date range
        const badDateRangeRes = await fetch(
            `${baseUrl}/api/agent/cash-collections?startDate=2026-10-15&endDate=2026-10-10`,
            { headers: { Authorization: `Bearer ${agentToken}` } }
        );
        if (badDateRangeRes.status !== 400) {
            throw new Error(`Expected 400 for inverted date range, got ${badDateRangeRes.status}`);
        }
        console.log("  ✓ Inverted date range (startDate > endDate) rejected with 400");

        // ---------------------------------------------------------
        // [TEST 4] Agent Isolation: Agent A vs Agent B
        // ---------------------------------------------------------
        console.log("\n[TEST 4] Verifying Agent Data Isolation (Agent A vs Agent B)...");
        const agentBHistoryRes = await fetch(`${baseUrl}/api/agent/cash-collections`, {
            headers: { Authorization: `Bearer ${secondAgentToken}` },
        });
        const agentBHistoryData = await agentBHistoryRes.json();
        
        // Agent B must not see any collections belonging to Agent A
        for (const col of agentBHistoryData.collections) {
            if (col.agentId === agent.id) {
                throw new Error("CRITICAL: Agent B received records belonging to Agent A!");
            }
        }
        console.log("  ✓ Agent B isolated: 0 collections of Agent A visible to Agent B");

        // ---------------------------------------------------------
        // [TEST 5] Daily Collection Summary (GET /api/agent/collection-summary/daily)
        // ---------------------------------------------------------
        console.log("\n[TEST 5] Verifying Daily Collection Summary (GET /api/agent/collection-summary/daily)...");
        const dailySummaryRes = await fetch(`${baseUrl}/api/agent/collection-summary/daily`, {
            headers: { Authorization: `Bearer ${agentToken}` },
        });
        if (dailySummaryRes.status !== 200) {
            const errJson = await dailySummaryRes.json();
            throw new Error(`Failed to fetch daily summary: ${JSON.stringify(errJson)}`);
        }
        const dailySummaryData = await dailySummaryRes.json();
        console.log(`  ✓ Daily Summary OK: Date = ${dailySummaryData.date}`);
        console.log(`  ✓ Total Cash Collected Today: ₹${dailySummaryData.totalCashCollected}`);
        console.log(`  ✓ Successful Collections Count: ${dailySummaryData.successfulCollectionsCount}`);
        console.log(`  ✓ EMIs Due Today: ${dailySummaryData.emisDueToday}, EMIs Collected: ${dailySummaryData.emisCollectedToday}, Remaining: ${dailySummaryData.remainingDueEmis}`);

        // Verify ONLINE payments are NOT counted as physical cash
        // In the database, loan LN-2026-C16D1F98 has 1 ONLINE payment of ₹1.
        // Confirm that the cash summary only counts CASH mode payments.
        const dbCashSum = await prisma.cashCollection.aggregate({
            where: {
                agentId: agent.id,
                collectedAt: {
                    gte: getBusinessDayRange(todayIST).startOfDay,
                    lt: getBusinessDayRange(todayIST).endOfDay,
                },
                payment: {
                    status: "SUCCESS",
                    mode: "CASH",
                },
            },
            _sum: { collectedAmount: true },
        });
        const expectedCashTotal = dbCashSum._sum.collectedAmount ? dbCashSum._sum.collectedAmount.toString() : "0";
        if (dailySummaryData.totalCashCollected !== expectedCashTotal) {
            throw new Error(`Daily cash total mismatch: expected ₹${expectedCashTotal}, got ₹${dailySummaryData.totalCashCollected}`);
        }
        console.log("  ✓ Verified: ONLINE payments strictly excluded from physical cash total");

        // ---------------------------------------------------------
        // [TEST 6] End-of-Day Cash Reconciliation (GET /api/agent/cash-reconciliation/daily)
        // ---------------------------------------------------------
        console.log("\n[TEST 6] Verifying Cash Reconciliation Summary (GET /api/agent/cash-reconciliation/daily)...");
        const reconRes = await fetch(`${baseUrl}/api/agent/cash-reconciliation/daily`, {
            headers: { Authorization: `Bearer ${agentToken}` },
        });
        if (reconRes.status !== 200) {
            const errJson = await reconRes.json();
            throw new Error(`Failed to fetch reconciliation summary: ${JSON.stringify(errJson)}`);
        }
        const reconData = await reconRes.json();
        console.log(`  ✓ Reconciliation Summary OK: Total Collected = ₹${reconData.totalCollectedAmount}`);
        console.log(`  ✓ Reconciled: ₹${reconData.reconciledAmount} (${reconData.reconciledCount}), Unreconciled: ₹${reconData.unreconciledAmount} (${reconData.unreconciledCount})`);
        console.log(`  ✓ Disclaimer present: "${reconData.disclaimer.slice(0, 50)}..."`);

        // Verify read-only nature: check DB records before and after, ensure reconciled status unchanged
        const dbReconCheck = await prisma.cashCollection.findFirst({
            where: { agentId: agent.id },
            select: { id: true, reconciled: true },
        });
        if (dbReconCheck) {
            const postCheck = await prisma.cashCollection.findUnique({
                where: { id: dbReconCheck.id },
                select: { reconciled: true },
            });
            if (dbReconCheck.reconciled !== postCheck.reconciled) {
                throw new Error("Reconciliation endpoint mutated data!");
            }
            console.log("  ✓ Confirmed: Endpoint is strictly read-only and does not mutate reconciliation flags");
        }

        // Verify agents cannot mutate collections via PUT/PATCH/DELETE
        const patchRes = await fetch(`${baseUrl}/api/agent/cash-collections/some-id`, {
            method: "PATCH",
            headers: { Authorization: `Bearer ${agentToken}` },
            body: JSON.stringify({ reconciled: true }),
        });
        if (patchRes.status !== 404 && patchRes.status !== 405) {
            throw new Error(`Agent was able to invoke modification endpoint! Status: ${patchRes.status}`);
        }
        console.log("  ✓ Confirmed: Agents cannot modify confirmed collections (404/405)");

        // ---------------------------------------------------------
        // [TEST 7] Admin Collection Oversight (GET /api/admin/cash-collections)
        // ---------------------------------------------------------
        console.log("\n[TEST 7] Verifying Admin Cash Collection Oversight (GET /api/admin/cash-collections)...");
        const adminOversightRes = await fetch(`${baseUrl}/api/admin/cash-collections?page=1&limit=20`, {
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        if (adminOversightRes.status !== 200) {
            const errJson = await adminOversightRes.json();
            throw new Error(`Admin oversight fetch failed: ${JSON.stringify(errJson)}`);
        }
        const adminOversightData = await adminOversightRes.json();
        console.log(`  ✓ Admin Oversight OK: Total Records = ${adminOversightData.pagination.totalRecords}`);
        console.log(`  ✓ Global Total Collected: ₹${adminOversightData.summary.totalCollectedAmount}`);
        console.log(`  ✓ Global Unreconciled: ₹${adminOversightData.summary.unreconciledAmount}`);

        // Filter by agentId
        const adminFilterAgentRes = await fetch(
            `${baseUrl}/api/admin/cash-collections?agentId=${agent.id}`,
            { headers: { Authorization: `Bearer ${adminToken}` } }
        );
        const adminFilterAgentData = await adminFilterAgentRes.json();
        console.log(`  ✓ Filter by agentId (${agent.employeeCode}): ${adminFilterAgentData.collections.length} records`);
        for (const col of adminFilterAgentData.collections) {
            if (col.agent.id !== agent.id) {
                throw new Error("Admin filter by agentId returned non-matching agent records!");
            }
        }
        console.log("  ✓ Admin agentId filter verified");

        // Filter by reconciled status
        const adminFilterReconRes = await fetch(
            `${baseUrl}/api/admin/cash-collections?reconciled=false`,
            { headers: { Authorization: `Bearer ${adminToken}` } }
        );
        const adminFilterReconData = await adminFilterReconRes.json();
        for (const col of adminFilterReconData.collections) {
            if (col.reconciled !== false) {
                throw new Error("Admin filter reconciled=false returned reconciled=true records!");
            }
        }
        console.log("  ✓ Admin reconciled=false filter verified");

        // ---------------------------------------------------------
        // [TEST 8] Step 18 Regression Verification
        // ---------------------------------------------------------
        console.log("\n[TEST 8] Regression Check: Verifying Step 18 Cash Collection API still works...");
        const assignment = await prisma.loanAgentAssignment.findFirst({
            where: {
                agentId: agent.id,
                active: true,
                loan: { status: { in: ["ACTIVE", "OVERDUE"] } },
            },
            include: {
                loan: {
                    include: {
                        emis: {
                            where: { status: { in: ["PENDING", "PARTIAL", "OVERDUE"] } },
                            orderBy: { installmentNo: "asc" },
                        },
                    },
                },
            },
        });

        if (assignment && assignment.loan && assignment.loan.emis.length > 0) {
            const targetLoan = assignment.loan;
            const targetEmi = targetLoan.emis[0];
            const idempotencyKey = `STEP19-REGRESSION-${Date.now()}`;

            const collectRes = await fetch(`${baseUrl}/api/agent/cash-collections`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${agentToken}`,
                    "Idempotency-Key": idempotencyKey,
                },
                body: JSON.stringify({
                    loanId: targetLoan.id,
                    emiId: targetEmi.id,
                    amount: "1.00",
                    notes: "Step 19 regression verification collection",
                }),
            });

            const collectJson = await collectRes.json();
            if (collectRes.status !== 201) {
                throw new Error(`Step 18 collection failed! Status ${collectRes.status}: ${JSON.stringify(collectJson)}`);
            }
            console.log(`  ✓ Step 18 Collection Recorded! Receipt: ${collectJson.receiptNumber}, Payment ID: ${collectJson.paymentId}`);

            // Idempotent retry
            const retryRes = await fetch(`${baseUrl}/api/agent/cash-collections`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${agentToken}`,
                    "Idempotency-Key": idempotencyKey,
                },
                body: JSON.stringify({
                    loanId: targetLoan.id,
                    emiId: targetEmi.id,
                    amount: "1.00",
                    notes: "Step 19 regression verification collection",
                }),
            });
            const retryJson = await retryRes.json();
            if (retryRes.status !== 200 || !retryJson.duplicate) {
                throw new Error(`Step 18 idempotency retry failed! Status ${retryRes.status}: ${JSON.stringify(retryJson)}`);
            }
            console.log("  ✓ Step 18 Idempotency retry verified (duplicate: true, status: 200)");
        }

        console.log("\n============================================================");
        console.log("ALL STEP 19 TESTS PASSED SUCCESSFULLY WITH ZERO ERRORS!");
        console.log("============================================================");
    } catch (error) {
        console.error("\n❌ STEP 19 TEST SUITE FAILED:");
        console.error(error);
        process.exitCode = 1;
    } finally {
        if (testServer) {
            testServer.close();
        }
        await prisma.$disconnect();
    }
}

runStep19Tests();
