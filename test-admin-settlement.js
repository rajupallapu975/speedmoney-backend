require("dotenv").config();

const jwt = require("jsonwebtoken");
const prisma = require("./lib/prisma");
const { getTodayIST } = require("./lib/date-utils");

async function runStep20Tests() {
    console.log("============================================================");
    console.log("STEP 20: ADMIN RECONCILIATION & SETTLEMENT APIS TEST SUITE");
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
        // 1. Load Test Entities & Tokens
        // ---------------------------------------------------------
        console.log("\n[SETUP] Loading test agent, admin, and customer...");
        const adminUser = await prisma.user.findFirst({
            where: { role: "ADMIN", status: "ACTIVE" },
        });
        if (!adminUser) throw new Error("No active ADMIN user found");

        const agent = await prisma.agentProfile.findUnique({
            where: { employeeCode: "AGT-002" },
            include: { user: true },
        });
        if (!agent) throw new Error("Agent AGT-002 not found");

        const customerUser = await prisma.user.findFirst({
            where: { role: "CUSTOMER", status: "ACTIVE" },
        });
        if (!customerUser) throw new Error("No active CUSTOMER user found");

        const adminToken = jwt.sign(
            { userId: adminUser.id, role: "ADMIN" },
            process.env.JWT_SECRET,
            { expiresIn: "10m" }
        );
        const agentToken = jwt.sign(
            { userId: agent.user.id, role: "AGENT" },
            process.env.JWT_SECRET,
            { expiresIn: "10m" }
        );
        const customerToken = jwt.sign(
            { userId: customerUser.id, role: "CUSTOMER" },
            process.env.JWT_SECRET,
            { expiresIn: "10m" }
        );

        console.log(`  ✓ Admin: ${adminUser.name} (${adminUser.email})`);
        console.log(`  ✓ Agent: ${agent.employeeCode} (${agent.user.name})`);
        console.log(`  ✓ Customer: ${customerUser.name}`);

        // ---------------------------------------------------------
        // [TEST 1] Role-Based Access Control
        // ---------------------------------------------------------
        console.log("\n[TEST 1] Role-Based Access Control and Authentication...");
        
        // 1a. Unauthenticated request rejected
        const unauthRes = await fetch(`${baseUrl}/api/admin/cash-settlements`);
        if (unauthRes.status !== 401) {
            throw new Error(`Expected 401 for unauthenticated request, got ${unauthRes.status}`);
        }
        console.log("  ✓ Unauthenticated request rejected (401)");

        // 1b. Customer rejected
        const custRes = await fetch(`${baseUrl}/api/admin/cash-settlements`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${customerToken}`,
            },
            body: JSON.stringify({ date: "2026-10-11" }),
        });
        if (custRes.status !== 403) {
            throw new Error(`Expected 403 for Customer on settlement endpoint, got ${custRes.status}`);
        }
        console.log("  ✓ Customer rejected on settlement creation (403)");

        // 1c. Agent rejected
        const agentRes = await fetch(`${baseUrl}/api/admin/cash-settlements`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${agentToken}`,
            },
            body: JSON.stringify({ date: "2026-10-11" }),
        });
        if (agentRes.status !== 403) {
            throw new Error(`Expected 403 for Agent on settlement endpoint, got ${agentRes.status}`);
        }
        console.log("  ✓ Agent rejected on settlement creation (403)");

        // ---------------------------------------------------------
        // [TEST 2] Validation: Dates, Amounts, & Exclusions
        // ---------------------------------------------------------
        console.log("\n[TEST 2] Input Validation & Boundary Checks...");

        // 2a. Invalid date rejected
        const badDateRes = await fetch(`${baseUrl}/api/admin/cash-settlements`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({ date: "invalid-date" }),
        });
        if (badDateRes.status !== 400) {
            throw new Error(`Expected 400 for invalid date, got ${badDateRes.status}`);
        }
        console.log("  ✓ Malformed date rejected with 400");

        // 2b. Duplicate collection IDs rejected
        const dupRes = await fetch(`${baseUrl}/api/admin/cash-settlements`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                date: "2026-10-11",
                collectionIds: ["col-1", "col-1"],
            }),
        });
        if (dupRes.status !== 400) {
            throw new Error(`Expected 400 for duplicate collection IDs, got ${dupRes.status}`);
        }
        console.log("  ✓ Duplicate collection IDs rejected with 400");

        // ---------------------------------------------------------
        // [TEST 3] Create a Draft Settlement (Endpoint A)
        // ---------------------------------------------------------
        console.log("\n[TEST 3] Creating a Draft Settlement (Endpoint A)...");
        const todayIST = getTodayIST();

        // Find unreconciled cash collections for today
        const unreconciledCollections = await prisma.cashCollection.findMany({
            where: {
                agentId: agent.id,
                reconciled: false,
                payment: { status: "SUCCESS", mode: "CASH" },
                settlementItems: {
                    none: {
                        settlement: { status: { not: "CANCELLED" } },
                    },
                },
            },
            take: 2,
        });

        if (unreconciledCollections.length === 0) {
            throw new Error("No unreconciled cash collections found for AGT-002 to test settlement!");
        }

        const selectedIds = unreconciledCollections.map((c) => c.id);
        const sumExpected = unreconciledCollections.reduce(
            (acc, c) => acc + Number(c.collectedAmount),
            0
        );
        console.log(`  ✓ Selected ${selectedIds.length} unreconciled collections totaling ₹${sumExpected}`);

        const createRes = await fetch(`${baseUrl}/api/admin/cash-settlements`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                date: todayIST,
                agentId: agent.id,
                collectionIds: selectedIds,
                notes: "Step 20 verification settlement",
            }),
        });

        if (createRes.status !== 201) {
            const errJson = await createRes.json();
            throw new Error(`Failed to create settlement: ${JSON.stringify(errJson)}`);
        }

        const createJson = await createRes.json();
        const settlementId = createJson.settlement.id;
        const settlementRef = createJson.settlement.settlementReference;
        console.log(`  ✓ Settlement Created! Reference: ${settlementRef} (ID: ${settlementId})`);
        console.log(`  ✓ Expected Amount: ₹${createJson.settlement.expectedAmount}`);
        console.log(`  ✓ Initial Status: ${createJson.settlement.status}`);

        if (createJson.settlement.status !== "DRAFT") {
            throw new Error(`Expected DRAFT status, got ${createJson.settlement.status}`);
        }

        // Verify that collections are NOT yet marked reconciled
        const checkColls = await prisma.cashCollection.findMany({
            where: { id: { in: selectedIds } },
            select: { id: true, reconciled: true },
        });
        for (const col of checkColls) {
            if (col.reconciled) {
                throw new Error("Collections prematurely marked reconciled upon settlement creation!");
            }
        }
        console.log("  ✓ Confirmed: Creating settlement did not mark collections reconciled");

        // ---------------------------------------------------------
        // [TEST 4] Double-Assignment Protection
        // ---------------------------------------------------------
        console.log("\n[TEST 4] Verifying Double-Assignment Prevention...");
        const duplicateAssignRes = await fetch(`${baseUrl}/api/admin/cash-settlements`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                date: todayIST,
                agentId: agent.id,
                collectionIds: selectedIds,
            }),
        });
        if (duplicateAssignRes.status !== 400) {
            throw new Error(`Expected 400 for double-assignment, got ${duplicateAssignRes.status}`);
        }
        console.log("  ✓ Collection cannot belong to two active settlements (400 rejected)");

        // ---------------------------------------------------------
        // [TEST 5] View Settlement Details (Endpoint B)
        // ---------------------------------------------------------
        console.log("\n[TEST 5] Viewing Settlement Details (Endpoint B)...");
        const viewRes = await fetch(`${baseUrl}/api/admin/cash-settlements/${settlementId}`, {
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        if (viewRes.status !== 200) {
            throw new Error(`Failed to view settlement, status ${viewRes.status}`);
        }
        const viewJson = await viewRes.json();
        console.log(`  ✓ Settlement View OK: Reference ${viewJson.settlement.settlementReference}`);
        console.log(`  ✓ Linked Items Count: ${viewJson.settlement.itemsCount}`);
        console.log(`  ✓ Audit Logs Count: ${viewJson.settlement.auditLogs.length}`);

        if (viewJson.settlement.itemsCount !== selectedIds.length) {
            throw new Error("Items count mismatch in settlement view!");
        }

        // ---------------------------------------------------------
        // [TEST 6] List Settlements (Endpoint C)
        // ---------------------------------------------------------
        console.log("\n[TEST 6] Listing Settlements with Filters (Endpoint C)...");
        const listRes = await fetch(
            `${baseUrl}/api/admin/cash-settlements?status=DRAFT&agentId=${agent.id}`,
            { headers: { Authorization: `Bearer ${adminToken}` } }
        );
        if (listRes.status !== 200) {
            throw new Error(`Failed to list settlements, status ${listRes.status}`);
        }
        const listJson = await listRes.json();
        console.log(`  ✓ List OK: Found ${listJson.settlements.length} DRAFT settlements for AGT-002`);
        console.log(`  ✓ Total Expected in list: ₹${listJson.summary.totalExpectedAmount}`);

        // ---------------------------------------------------------
        // [TEST 7] Record Actual Cash Count & Discrepancy Calculation (Endpoint D)
        // ---------------------------------------------------------
        console.log("\n[TEST 7] Recording Actual Cash Count & Discrepancy Calculation (Endpoint D)...");

        // 7a. Record count with a discrepancy first (e.g. ₹1 less)
        const discrepantAmount = (sumExpected - 1.0).toFixed(2);
        const countDiscrepancyRes = await fetch(
            `${baseUrl}/api/admin/cash-settlements/${settlementId}/count`,
            {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${adminToken}`,
                },
                body: JSON.stringify({
                    actualAmount: discrepantAmount,
                    notes: "Counted ₹1 short",
                }),
            }
        );
        if (countDiscrepancyRes.status !== 200) {
            throw new Error(`Failed to record count, status ${countDiscrepancyRes.status}`);
        }
        const countDiscrepancyJson = await countDiscrepancyRes.json();
        console.log(`  ✓ Recorded actual amount ₹${countDiscrepancyJson.settlement.actualAmount}`);
        console.log(`  ✓ Calculated discrepancy: ₹${countDiscrepancyJson.settlement.discrepancyAmount}`);
        console.log(`  ✓ Updated status: ${countDiscrepancyJson.settlement.status}`);

        if (Number(countDiscrepancyJson.settlement.discrepancyAmount) !== -1.0) {
            throw new Error(`Discrepancy expected -1.00, got ${countDiscrepancyJson.settlement.discrepancyAmount}`);
        }
        if (countDiscrepancyJson.settlement.status !== "DISCREPANCY") {
            throw new Error(`Status should be DISCREPANCY, got ${countDiscrepancyJson.settlement.status}`);
        }
        console.log("  ✓ Discrepancy calculated server-side correctly");

        // ---------------------------------------------------------
        // [TEST 8] Prevent Reconciliation on Discrepancy
        // ---------------------------------------------------------
        console.log("\n[TEST 8] Verifying Non-Zero Discrepancy Blocks Reconciliation...");
        const blockedReconRes = await fetch(
            `${baseUrl}/api/admin/cash-settlements/${settlementId}/reconcile`,
            {
                method: "POST",
                headers: { Authorization: `Bearer ${adminToken}` },
            }
        );
        if (blockedReconRes.status !== 400) {
            throw new Error(`Expected 400 when reconciling discrepant settlement, got ${blockedReconRes.status}`);
        }
        console.log("  ✓ Reconciliation blocked for settlement with discrepancy (400 Bad Request)");

        // ---------------------------------------------------------
        // [TEST 9] Flag Discrepancy Explicitly (Endpoint F)
        // ---------------------------------------------------------
        console.log("\n[TEST 9] Flagging Discrepancy Explicitly (Endpoint F)...");
        const flagRes = await fetch(
            `${baseUrl}/api/admin/cash-settlements/${settlementId}/discrepancy`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${adminToken}`,
                },
                body: JSON.stringify({
                    reason: "₹1 physical note missing from agent pouch",
                }),
            }
        );
        if (flagRes.status !== 200) {
            throw new Error(`Failed to flag discrepancy, status ${flagRes.status}`);
        }
        const flagJson = await flagRes.json();
        console.log(`  ✓ Flagged Discrepancy Reason: "${flagJson.settlement.discrepancyReason}"`);

        // ---------------------------------------------------------
        // [TEST 10] Correct Actual Cash Count to Balanced (Endpoint D)
        // ---------------------------------------------------------
        console.log("\n[TEST 10] Correcting Cash Count to Balanced Amount...");
        const balancedCountRes = await fetch(
            `${baseUrl}/api/admin/cash-settlements/${settlementId}/count`,
            {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${adminToken}`,
                },
                body: JSON.stringify({
                    actualAmount: sumExpected.toFixed(2),
                    notes: "Missing ₹1 note found in agent bag; count balanced",
                }),
            }
        );
        const balancedCountJson = await balancedCountRes.json();
        console.log(`  ✓ Balanced Count: Actual = ₹${balancedCountJson.settlement.actualAmount}, Discrepancy = ₹${balancedCountJson.settlement.discrepancyAmount}`);
        console.log(`  ✓ Status returned to: ${balancedCountJson.settlement.status}`);

        if (Number(balancedCountJson.settlement.discrepancyAmount) !== 0) {
            throw new Error("Discrepancy should be 0 after balanced count!");
        }

        // ---------------------------------------------------------
        // [TEST 11] Reconcile Settlement Atomically (Endpoint E)
        // ---------------------------------------------------------
        console.log("\n[TEST 11] Reconciling Settlement (Endpoint E)...");
        const reconcileRes = await fetch(
            `${baseUrl}/api/admin/cash-settlements/${settlementId}/reconcile`,
            {
                method: "POST",
                headers: { Authorization: `Bearer ${adminToken}` },
            }
        );
        if (reconcileRes.status !== 200) {
            const errJson = await reconcileRes.json();
            throw new Error(`Reconciliation failed: ${JSON.stringify(errJson)}`);
        }
        const reconcileJson = await reconcileRes.json();
        console.log(`  ✓ Settlement Reconciled! Status: ${reconcileJson.status}`);
        console.log(`  ✓ Reconciled Collections Count: ${reconcileJson.reconciledCollectionsCount}`);

        // Verify underlying CashCollection rows in DB are now reconciled: true
        const postReconColls = await prisma.cashCollection.findMany({
            where: { id: { in: selectedIds } },
            select: { id: true, reconciled: true, reconciledAt: true },
        });
        for (const col of postReconColls) {
            if (!col.reconciled || !col.reconciledAt) {
                throw new Error(`Collection ${col.id} was not updated to reconciled: true in database!`);
            }
        }
        console.log("  ✓ Database integrity verified: all linked CashCollection records marked reconciled: true");

        // Verify audit log created
        const reconAudit = await prisma.auditLog.findFirst({
            where: {
                entity: "CashSettlement",
                entityId: settlementId,
                action: "VERIFY",
            },
        });
        if (!reconAudit) {
            throw new Error("Reconciliation audit log entry not found!");
        }
        console.log(`  ✓ AuditLog verified: [${reconAudit.action}] ${reconAudit.description}`);

        // ---------------------------------------------------------
        // [TEST 12] Duplicate Reconciliation Prevention
        // ---------------------------------------------------------
        console.log("\n[TEST 12] Verifying Repeated Reconciliation Prevention...");
        const repeatReconRes = await fetch(
            `${baseUrl}/api/admin/cash-settlements/${settlementId}/reconcile`,
            {
                method: "POST",
                headers: { Authorization: `Bearer ${adminToken}` },
            }
        );
        if (repeatReconRes.status !== 400) {
            throw new Error(`Expected 400 for repeated reconciliation, got ${repeatReconRes.status}`);
        }
        console.log("  ✓ Repeated reconciliation safely rejected (400 Bad Request)");

        // ---------------------------------------------------------
        // [TEST 13] Settlement Report (Endpoint G)
        // ---------------------------------------------------------
        console.log("\n[TEST 13] Verifying Settlement Report (Endpoint G)...");
        const reportRes = await fetch(`${baseUrl}/api/admin/cash-settlements/report`, {
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        if (reportRes.status !== 200) {
            throw new Error(`Failed to fetch report, status ${reportRes.status}`);
        }
        const reportJson = await reportRes.json();
        console.log(`  ✓ Report OK: Total Recorded Cash = ₹${reportJson.report.totalRecordedCashCollections}`);
        console.log(`  ✓ Total Reconciled Cash = ₹${reportJson.report.totalReconciledCash}`);
        console.log(`  ✓ Total Unreconciled Cash = ₹${reportJson.report.totalUnreconciledCash}`);
        console.log(`  ✓ Reconciled Settlements Count = ${reportJson.report.settlements.reconciledSettlementsCount}`);
        console.log(`  ✓ Agent Breakdown Count = ${reportJson.report.agentBreakdown.length}`);

        console.log("\n============================================================");
        console.log("ALL STEP 20 TESTS PASSED SUCCESSFULLY WITH ZERO ERRORS!");
        console.log("============================================================");
    } catch (error) {
        console.error("\n❌ STEP 20 TEST SUITE FAILED:");
        console.error(error);
        process.exitCode = 1;
    } finally {
        if (testServer) {
            testServer.close();
        }
        await prisma.$disconnect();
    }
}

runStep20Tests();
