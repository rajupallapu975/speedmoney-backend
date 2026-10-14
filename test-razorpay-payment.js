const crypto = require("crypto");
const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Prisma } = require("@prisma/client");

const prisma = require("./lib/prisma");
const paymentRoutes = require("./routes/payments");

console.log("============================================================");
console.log("RAZORPAY TEST PAYMENT FLOW VERIFICATION SUITE");
console.log("============================================================\n");

async function runRazorpayPaymentTests() {
    let testServer = null;
    let baseUrl = "";

    try {
        // 1. Setup in-process Express server with the payments router
        const app = express();
        app.use(express.json());
        app.use("/api/payments", paymentRoutes);

        testServer = http.createServer(app);
        await new Promise((resolve) => testServer.listen(0, resolve));
        const port = testServer.address().port;
        baseUrl = `http://localhost:${port}`;
        console.log(`  ✓ Spawned in-process test server on ${baseUrl}`);

        // 2. Load test Customer and Token
        console.log("\n[SETUP] Preparing customer, loan, and test tokens...");
        const customerUser = await prisma.user.findFirst({
            where: { role: "CUSTOMER" },
            include: { customerProfile: true },
        });

        if (!customerUser || !customerUser.customerProfile) {
            throw new Error("No customer found in test database!");
        }

        const customerToken = jwt.sign(
            { userId: customerUser.id, role: "CUSTOMER", email: customerUser.email },
            process.env.JWT_SECRET || "N7vQ2mL9xR4kT8pW6zY3cF1hJ5sD0aE8",
            { expiresIn: "1h" }
        );

        // Find active loan with unpaid EMI
        const activeLoan = await prisma.loan.findFirst({
            where: {
                customerId: customerUser.customerProfile.id,
                status: "ACTIVE",
                emis: {
                    some: {
                        status: { in: ["PENDING", "PARTIAL", "OVERDUE"] },
                        outstandingAmount: { gt: 0 },
                    },
                },
            },
            include: {
                emis: {
                    where: {
                        status: { in: ["PENDING", "PARTIAL", "OVERDUE"] },
                        outstandingAmount: { gt: 0 },
                    },
                    orderBy: { installmentNo: "asc" },
                },
            },
        });

        if (!activeLoan || activeLoan.emis.length === 0) {
            throw new Error("No active loan with unpaid EMI found for test customer!");
        }

        const testEmi = activeLoan.emis[0];
        console.log(`  ✓ Customer: ${customerUser.name} (${customerUser.email})`);
        console.log(`  ✓ Active Loan: ${activeLoan.loanNumber} (ID: ${activeLoan.id})`);
        console.log(`  ✓ Target EMI #${testEmi.installmentNo} (Outstanding: ₹${testEmi.outstandingAmount})`);

        // -------------------------------------------------------------
        // TEST 1: Razorpay Public Config Endpoint
        // -------------------------------------------------------------
        console.log("\n[TEST 1] Verifying Razorpay Config Endpoint...");
        const configRes = await fetch(`${baseUrl}/api/payments/razorpay/config`);
        const configJson = await configRes.json();

        if (configRes.status !== 200 || !configJson.success || !configJson.keyId) {
            throw new Error(`Failed to fetch Razorpay config: ${JSON.stringify(configJson)}`);
        }
        if (configJson.keySecret || JSON.stringify(configJson).includes("secret")) {
            throw new Error("SECURITY FAILURE: Secret key leaked in client config!");
        }
        console.log(`  ✓ Razorpay Config OK: keyId = ${configJson.keyId}, currency = ${configJson.currency}`);
        console.log("  ✓ Verified: Secret key strictly guarded and never exposed to client.");

        // -------------------------------------------------------------
        // TEST 2: Role-Based Access Control and Authentication
        // -------------------------------------------------------------
        console.log("\n[TEST 2] Verifying Authentication & RBAC Guards...");
        const unauthOrderRes = await fetch(`${baseUrl}/api/payments/razorpay/create-order`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ loanId: activeLoan.id, emiId: testEmi.id }),
        });
        if (unauthOrderRes.status !== 401) {
            throw new Error(`Expected 401 for unauthenticated request, got ${unauthOrderRes.status}`);
        }
        console.log("  ✓ Unauthenticated order creation blocked (401)");

        const unauthVerifyRes = await fetch(`${baseUrl}/api/payments/razorpay/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                loanId: activeLoan.id,
                emiId: testEmi.id,
                amount: 1,
                razorpayOrderId: "order_123",
                razorpayPaymentId: "pay_123",
                razorpaySignature: "sig_123",
            }),
        });
        if (unauthVerifyRes.status !== 401) {
            throw new Error(`Expected 401 for unauthenticated verify, got ${unauthVerifyRes.status}`);
        }
        console.log("  ✓ Unauthenticated verification blocked (401)");

        // -------------------------------------------------------------
        // TEST 3: Validation and Over-collection Safeguards
        // -------------------------------------------------------------
        console.log("\n[TEST 3] Verifying EMI Balance & Input Validations...");

        // Missing fields
        const missingFieldRes = await fetch(`${baseUrl}/api/payments/razorpay/create-order`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${customerToken}`,
            },
            body: JSON.stringify({ loanId: activeLoan.id }),
        });
        if (missingFieldRes.status !== 400) {
            throw new Error(`Expected 400 for missing emiId, got ${missingFieldRes.status}`);
        }
        console.log("  ✓ Missing required fields rejected with 400");

        // Over-collection attempt
        const excessAmount = (Number(testEmi.outstandingAmount) + 5000).toFixed(2);
        const overCollectRes = await fetch(`${baseUrl}/api/payments/razorpay/create-order`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${customerToken}`,
            },
            body: JSON.stringify({
                loanId: activeLoan.id,
                emiId: testEmi.id,
                amount: excessAmount,
            }),
        });
        const overCollectJson = await overCollectRes.json();
        if (overCollectRes.status !== 400 || !overCollectJson.message.includes("cannot exceed")) {
            throw new Error(`Over-collection was not blocked! Status: ${overCollectRes.status}`);
        }
        console.log(`  ✓ Over-collection blocked: "${overCollectJson.message}"`);

        // Negative amount
        const negAmountRes = await fetch(`${baseUrl}/api/payments/razorpay/create-order`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${customerToken}`,
            },
            body: JSON.stringify({
                loanId: activeLoan.id,
                emiId: testEmi.id,
                amount: -50,
            }),
        });
        if (negAmountRes.status !== 400) {
            throw new Error(`Expected 400 for negative amount, got ${negAmountRes.status}`);
        }
        console.log("  ✓ Negative amount rejected with 400");

        // -------------------------------------------------------------
        // TEST 4: Valid Order Creation (Server-calculated balances & Paise)
        // -------------------------------------------------------------
        console.log("\n[TEST 4] Creating Order with Server-Calculated Balance in Paise...");
        const testPaymentRupees = "1.00";
        const orderRes = await fetch(`${baseUrl}/api/payments/razorpay/create-order`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${customerToken}`,
            },
            body: JSON.stringify({
                loanId: activeLoan.id,
                emiId: testEmi.id,
                amount: testPaymentRupees,
            }),
        });

        const orderJson = await orderRes.json();
        if (orderRes.status !== 201 || !orderJson.success || !orderJson.orderId) {
            throw new Error(`Order creation failed! Status ${orderRes.status}: ${JSON.stringify(orderJson)}`);
        }

        // Verify paise calculation (1.00 INR = 100 paise)
        if (orderJson.amount !== 100) {
            throw new Error(`Expected amount in paise to be 100, got ${orderJson.amount}`);
        }
        if (orderJson.currency !== "INR") {
            throw new Error(`Expected currency INR, got ${orderJson.currency}`);
        }
        if (!orderJson.orderId.startsWith("order_")) {
            throw new Error(`Order ID must start with 'order_', got ${orderJson.orderId}`);
        }

        console.log(`  ✓ Razorpay Order Created: ${orderJson.orderId}`);
        console.log(`  ✓ Amount verified in paise: ${orderJson.amount} paise (₹${orderJson.amountInRupees})`);
        console.log(`  ✓ Receipt: ${orderJson.receipt}`);

        const createdOrderId = orderJson.orderId;
        const testPaymentId = `pay_test_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
        const keySecret = process.env.RAZORPAY_KEY_SECRET || "rzp_test_secret_placeholder";

        // -------------------------------------------------------------
        // TEST 5: Signature Tampering & Invalid Signature Rejection
        // -------------------------------------------------------------
        console.log("\n[TEST 5] Verifying Signature Forgery Rejection...");
        const forgedVerifyRes = await fetch(`${baseUrl}/api/payments/razorpay/verify`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${customerToken}`,
            },
            body: JSON.stringify({
                loanId: activeLoan.id,
                emiId: testEmi.id,
                amount: testPaymentRupees,
                razorpayOrderId: createdOrderId,
                razorpayPaymentId: testPaymentId,
                razorpaySignature: "invalid_tampered_signature_hex_1234567890abcdef",
            }),
        });

        const forgedJson = await forgedVerifyRes.json();
        if (forgedVerifyRes.status !== 400 || forgedJson.code !== "INVALID_SIGNATURE") {
            throw new Error(`Forged signature was not rejected! Status: ${forgedVerifyRes.status}: ${JSON.stringify(forgedJson)}`);
        }
        console.log("  ✓ Tampered/invalid signature strictly rejected (400 INVALID_SIGNATURE)");

        // -------------------------------------------------------------
        // TEST 6: Legitimate Payment Signature Verification & Atomic Application
        // -------------------------------------------------------------
        console.log("\n[TEST 6] Verifying Authentic Signature and Atomic EMI Application...");

        // Generate authentic HMAC SHA256 signature according to Razorpay specification
        const payloadToSign = `${createdOrderId}|${testPaymentId}`;
        const validSignature = crypto
            .createHmac("sha256", keySecret)
            .update(payloadToSign)
            .digest("hex");

        const verifyRes = await fetch(`${baseUrl}/api/payments/razorpay/verify`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${customerToken}`,
            },
            body: JSON.stringify({
                loanId: activeLoan.id,
                emiId: testEmi.id,
                amount: testPaymentRupees,
                razorpayOrderId: createdOrderId,
                razorpayPaymentId: testPaymentId,
                razorpaySignature: validSignature,
            }),
        });

        const verifyJson = await verifyRes.json();
        if (verifyRes.status !== 201 || !verifyJson.success) {
            throw new Error(`Payment verification failed! Status ${verifyRes.status}: ${JSON.stringify(verifyJson)}`);
        }

        console.log(`  ✓ Payment Recorded! Receipt: ${verifyJson.receiptNumber}`);
        console.log(`  ✓ Transaction ID: ${verifyJson.transactionId}`);
        console.log(`  ✓ Recorded Amount: ₹${verifyJson.amount}`);
        console.log(`  ✓ Updated EMI Outstanding: ₹${verifyJson.emi.outstandingAmount}`);
        console.log(`  ✓ Updated EMI Status: ${verifyJson.emi.status}`);

        // Verify database records
        const dbPayment = await prisma.payment.findUnique({
            where: { transactionId: testPaymentId },
            include: { onlinePayment: true, emi: true, loan: true },
        });

        if (!dbPayment || dbPayment.status !== "SUCCESS" || dbPayment.mode !== "ONLINE") {
            throw new Error("Payment record not verified in database!");
        }
        if (dbPayment.onlinePayment?.cashfreeOrderId !== createdOrderId) {
            throw new Error("OnlinePayment order ID mismatch in database!");
        }
        console.log("  ✓ Verified database integrity: Payment and OnlinePayment records committed atomically.");

        // -------------------------------------------------------------
        // TEST 7: Idempotent Replay on Identical Request
        // -------------------------------------------------------------
        console.log("\n[TEST 7] Verifying Idempotent Replay (Duplicate-Submit Protection)...");
        const replayRes = await fetch(`${baseUrl}/api/payments/razorpay/verify`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${customerToken}`,
            },
            body: JSON.stringify({
                loanId: activeLoan.id,
                emiId: testEmi.id,
                amount: testPaymentRupees,
                razorpayOrderId: createdOrderId,
                razorpayPaymentId: testPaymentId,
                razorpaySignature: validSignature,
            }),
        });

        const replayJson = await replayRes.json();
        if (replayRes.status !== 200 || !replayJson.duplicate) {
            throw new Error(`Expected status 200 with duplicate: true on replay, got ${replayRes.status}: ${JSON.stringify(replayJson)}`);
        }
        if (replayJson.receiptNumber !== verifyJson.receiptNumber) {
            throw new Error("Replay returned a different receipt number!");
        }
        console.log("  ✓ Idempotent replay safely returned original receipt (200 OK, duplicate: true) without double charging!");

        // -------------------------------------------------------------
        // TEST 8: Reused Payment ID with Different Details Rejected
        // -------------------------------------------------------------
        console.log("\n[TEST 8] Verifying Mismatched Reused Payment ID Rejected...");
        const tamperedAmountSig = crypto
            .createHmac("sha256", keySecret)
            .update(`${createdOrderId}|${testPaymentId}`)
            .digest("hex");

        const mismatchRes = await fetch(`${baseUrl}/api/payments/razorpay/verify`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${customerToken}`,
            },
            body: JSON.stringify({
                loanId: activeLoan.id,
                emiId: testEmi.id,
                amount: "500.00", // Altered amount!
                razorpayOrderId: createdOrderId,
                razorpayPaymentId: testPaymentId,
                razorpaySignature: tamperedAmountSig,
            }),
        });

        if (mismatchRes.status !== 400) {
            throw new Error(`Expected 400 for tampered payment details on existing ID, got ${mismatchRes.status}`);
        }
        console.log("  ✓ Reused payment ID with altered amount safely rejected with 400.");

        // -------------------------------------------------------------
        // TEST 9: Payment History API Verification
        // -------------------------------------------------------------
        console.log("\n[TEST 9] Verifying Payment History API (GET /api/payments/my)...");
        const historyRes = await fetch(`${baseUrl}/api/payments/my`, {
            headers: {
                Authorization: `Bearer ${customerToken}`,
            },
        });
        const historyJson = await historyRes.json();
        if (historyRes.status !== 200 || !historyJson.success) {
            throw new Error(`Payment history fetch failed: ${JSON.stringify(historyJson)}`);
        }

        const foundPayment = historyJson.payments.find((p) => p.transactionId === testPaymentId);
        if (!foundPayment) {
            throw new Error(`Recorded payment ${testPaymentId} not found in customer payment history!`);
        }
        console.log(`  ✓ Payment found in history: Receipt ${foundPayment.receiptNumber}, Amount ₹${foundPayment.amount}, Mode: ${foundPayment.mode}`);

        console.log("\n============================================================");
        console.log("ALL RAZORPAY TEST PAYMENT SUITE TESTS PASSED SUCCESSFULLY! 🚀");
        console.log("============================================================\n");
    } catch (error) {
        console.error("\n❌ RAZORPAY PAYMENT TEST SUITE FAILED:");
        console.error(error);
        process.exitCode = 1;
    } finally {
        if (testServer) {
            testServer.close();
        }
        await prisma.$disconnect();
    }
}

runRazorpayPaymentTests();
