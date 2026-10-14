const crypto = require("crypto");
const express = require("express");
const { Prisma } = require("@prisma/client");

const prisma = require("../lib/prisma");
const { getResolvedCustomerProfile } = require("../lib/customer-helper");
const { authenticateToken } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");
const {
    applyPaymentToEmi,
    applyPaymentWithRetry,
    parseAndValidateMoney,
    toDecimal,
} = require("../services/payment-engine");

const Decimal = Prisma.Decimal;

/**
 * fetch() wrapper with an AbortController-based timeout.
 * Prevents live Razorpay API calls from hanging the verify endpoint indefinitely.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        return response;
    } catch (err) {
        if (err.name === "AbortError") {
            throw new Error(`Razorpay API request timed out after ${timeoutMs / 1000}s — payment may still be valid`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Resolves direct upi:// URL from Razorpay short_url so Android never opens an external browser.
 */
async function resolveUpiIntentUrl(shortUrl) {
    if (!shortUrl) return null;
    try {
        let current = shortUrl;
        for (let i = 0; i < 4; i++) {
            const res = await fetchWithTimeout(
                current,
                {
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
                    },
                    redirect: "manual",
                },
                4000
            );
            const loc = res.headers.get("location");
            if (!loc) break;
            if (
                loc.startsWith("upi://") ||
                loc.startsWith("phonepe://") ||
                loc.startsWith("tez://") ||
                loc.startsWith("paytmmp://") ||
                loc.startsWith("intent://")
            ) {
                return loc;
            }
            current = loc;
        }
    } catch (err) {
        console.warn("[RAZORPAY] Failed to resolve direct UPI link:", err.message);
    }
    return null;
}

const router = express.Router();

/*
 * =========================================================================
 * RAZORPAY PAYMENT GATEWAY (TEST MODE)
 * =========================================================================
 */

/**
 * GET /api/payments/razorpay/config
 * Public/authenticated endpoint returning Razorpay client configuration.
 * (Never exposes secret key!)
 */
router.get("/razorpay/config", (req, res) => {
    const keyId = process.env.RAZORPAY_KEY_ID || "rzp_test_placeholder";
    const isConfigured = Boolean(keyId && !keyId.includes("placeholder"));
    // Derive live/test mode from the actual key prefix — never hardcode
    const isLive = keyId.startsWith("rzp_live_");

    return res.json({
        success: true,
        keyId,
        currency: "INR",
        isConfigured,
        testMode: !isLive,
    });
});

/**
 * POST /api/payments/razorpay/create-order
 * Customer creates an order using server-calculated eligible EMI balances.
 */
router.post(
    "/razorpay/create-order",
    authenticateToken,
    authorizeRoles("CUSTOMER", "AGENT", "ADMIN"),
    async (req, res) => {
        try {
            const { loanId, emiId, amount } = req.body;

            if (!loanId || !emiId) {
                return res.status(400).json({
                    success: false,
                    message: "loanId and emiId are required",
                });
            }

            const customer = await getResolvedCustomerProfile(req.user);

            if (!customer) {
                return res.status(401).json({
                    success: false,
                    message: "Customer profile not found or session expired. Please log in again.",
                });
            }

            const loan = await prisma.loan.findFirst({
                where: {
                    id: String(loanId).trim(),
                    customerId: customer.id,
                },
            });

            if (!loan) {
                return res.status(404).json({
                    success: false,
                    message: "Loan not found for this customer",
                });
            }

            // Pending disbursement guard: cannot pay for loan pending disbursement
            if (loan.status === "PENDING_DISBURSEMENT") {
                return res.status(400).json({
                    success: false,
                    message: "Loan is pending disbursement and not eligible for payment",
                });
            }

            if (!["ACTIVE", "OVERDUE"].includes(loan.status)) {
                return res.status(400).json({
                    success: false,
                    message: `Loan is not eligible for payment (status: ${loan.status})`,
                });
            }

            const emi = await prisma.emiSchedule.findFirst({
                where: {
                    id: String(emiId).trim(),
                    loanId: loan.id,
                },
            });

            if (!emi) {
                return res.status(404).json({
                    success: false,
                    message: "EMI not found for this loan",
                });
            }

            if (emi.status === "PAID") {
                return res.status(400).json({
                    success: false,
                    message: "This EMI is already fully paid",
                });
            }

            if (emi.status === "WAIVED") {
                return res.status(400).json({
                    success: false,
                    message: "This EMI has been waived and cannot be paid",
                });
            }

            const emiOutstanding = new Decimal(emi.outstandingAmount);
            if (emiOutstanding.lte(0)) {
                return res.status(400).json({
                    success: false,
                    message: "This EMI is already fully paid",
                });
            }

            // Determine repayment amount: either customer-requested or full EMI outstanding
            let targetAmount;
            let includeProcessingFee = req.body.includeFee === true;
            if (amount !== undefined && amount !== null && String(amount).trim() !== "") {
                const parsed = parseAndValidateMoney(amount);
                // If amount matches emiOutstanding + 2% fee (e.g. ₹113.44 vs ₹111.22)
                const emiWithFee = Math.round(Number(emiOutstanding.toString()) * 1.02 * 100) / 100;
                if (Math.abs(Number(parsed.toString()) - emiWithFee) < 0.05 && emiWithFee > Number(emiOutstanding.toString())) {
                    targetAmount = emiOutstanding;
                    includeProcessingFee = true;
                } else {
                    targetAmount = parsed;
                }
            } else {
                targetAmount = emiOutstanding;
            }

            if (targetAmount.gt(emiOutstanding)) {
                return res.status(400).json({
                    success: false,
                    message: `Payment amount cannot exceed outstanding amount of ₹${emiOutstanding.toFixed(2)}`,
                });
            }

            const loanOutstanding = new Decimal(loan.outstandingAmount);
            if (targetAmount.gt(loanOutstanding)) {
                return res.status(400).json({
                    success: false,
                    message: `Payment amount cannot exceed loan outstanding amount of ₹${loanOutstanding.toFixed(2)}`,
                });
            }

            const emiAmountNum = Number(targetAmount.toString());
            const processingFee = includeProcessingFee ? Math.round(emiAmountNum * 0.02 * 100) / 100 : 0;
            const totalChargeAmount = Math.round((emiAmountNum + processingFee) * 100) / 100;

            // Convert amount to integer paise for Razorpay
            const amountInPaise = Math.round(totalChargeAmount * 100);
            if (amountInPaise <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Calculated payment amount in paise must be greater than zero",
                });
            }

            const receipt = `RZP-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
            const keyId = process.env.RAZORPAY_KEY_ID || "rzp_test_placeholder";
            const keySecret = process.env.RAZORPAY_KEY_SECRET || "rzp_test_secret_placeholder";

            let orderId;
            const isLiveGateway = keyId && keySecret && !keyId.includes("placeholder");

            if (isLiveGateway) {
                const authHeader = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");

                // Build the order payload
                const orderPayload = {
                    amount: amountInPaise,
                    currency: "INR",
                    receipt,
                    notes: {
                        loanId: loan.id,
                        emiId: emi.id,
                        installmentNo: String(emi.installmentNo),
                        customerId: customer.id,
                        userId: req.user.userId,
                    },
                };

                // Note: Do not attach restrictive checkout_config_id which could suppress UPI.
                // Leaving checkout_config_id omitted enables all active account methods (UPI, Cards, Netbanking, Wallets).

                console.log(`[RAZORPAY] [create-order] Sending order to Razorpay — amount: ${amountInPaise} paise, receipt: ${receipt}`);
                const rzpRes = await fetchWithTimeout("https://api.razorpay.com/v1/orders", {
                    method: "POST",
                    headers: {
                        Authorization: authHeader,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(orderPayload),
                });

                const rzpData = await rzpRes.json();
                if (!rzpRes.ok) {
                    console.error("[RAZORPAY] [create-order] Order creation failed:", rzpData);
                    return res.status(rzpRes.status).json({
                        success: false,
                        message: rzpData.error?.description || "Failed to create Razorpay order",
                        code: rzpData.error?.code || "RAZORPAY_ORDER_FAILED",
                    });
                }
                orderId = rzpData.id;

                // Also generate a direct Razorpay UPI link (https://rzp.io/rzp/...) to bypass Android WebView iframe limitations
                let paymentUrl = null;
                let paymentLinkId = null;
                let upiIntentUrl = null;
                try {
                    const plinkRes = await fetchWithTimeout(
                        "https://api.razorpay.com/v1/payment_links",
                        {
                            method: "POST",
                            headers: {
                                Authorization: authHeader,
                                "Content-Type": "application/json",
                            },
                            body: JSON.stringify({
                                amount: amountInPaise,
                                currency: "INR",
                                description: `EMI #${emi.installmentNo} Repayment · Loan ${loan.loanNumber}`,
                                customer: {
                                    name: customer.user?.name || "Customer",
                                    contact: customer.user?.phone ? `+91${customer.user.phone.replace(/\D/g, "").slice(-10)}` : undefined,
                                    email: customer.user?.email || "customer@speedmoney.user",
                                },
                                notify: { sms: false, email: false, whatsapp: false },
                                upi_link: true,
                                notes: {
                                    loanId: loan.id,
                                    emiId: emi.id,
                                    installmentNo: String(emi.installmentNo),
                                    orderId,
                                },
                            }),
                        },
                        8000
                    );
                    if (plinkRes.ok) {
                        const plinkData = await plinkRes.json();
                        if (plinkData && plinkData.short_url) {
                            paymentUrl = plinkData.short_url;
                            paymentLinkId = plinkData.id;

                            // Resolve direct upi:// URL so Android opens native UPI chooser directly without opening an external browser
                            upiIntentUrl = await resolveUpiIntentUrl(paymentUrl);
                            if (upiIntentUrl) {
                                console.log(`[RAZORPAY] [create-order] Resolved direct UPI intent: ${upiIntentUrl}`);
                            }
                        }
                    }
                } catch (plinkErr) {
                    console.warn("[RAZORPAY] Payment link generation error (fallback will use orderId):", plinkErr.message);
                }

                return res.status(201).json({
                    success: true,
                    orderId,
                    paymentLinkId,
                    paymentUrl,
                    upiIntentUrl,
                    amount: amountInPaise,
                    amountInRupees: totalChargeAmount.toFixed(2),
                    emiAmount: targetAmount.toString(),
                    processingFee: processingFee.toFixed(2),
                    totalPayable: totalChargeAmount.toFixed(2),
                    currency: "INR",
                    keyId,
                    receipt,
                    loanId: loan.id,
                    loanNumber: loan.loanNumber,
                    emiId: emi.id,
                    installmentNo: emi.installmentNo,
                    outstandingAmount: emi.outstandingAmount.toString(),
                    customer: {
                        name: customer.user?.name || "Customer",
                        email: customer.user?.email || "",
                        phone: customer.user?.phone || "",
                    },
                });
            } else {
                // Deterministic Test Mode Order identifier
                orderId = `order_test_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
            }

            // [DIAGNOSTIC] Razorpay order created
            console.log(`[DIAGNOSTIC] Razorpay order created — orderId: ${orderId}, amountPaise: ${amountInPaise}, receipt: ${receipt}`);

            return res.status(201).json({
                success: true,
                orderId,
                amount: amountInPaise,
                amountInRupees: totalChargeAmount.toFixed(2),
                emiAmount: targetAmount.toString(),
                processingFee: processingFee.toFixed(2),
                totalPayable: totalChargeAmount.toFixed(2),
                currency: "INR",
                keyId,
                receipt,
                loanId: loan.id,
                loanNumber: loan.loanNumber,
                emiId: emi.id,
                installmentNo: emi.installmentNo,
                outstandingAmount: emi.outstandingAmount.toString(),
                customer: {
                    name: customer.user?.name || "Customer",
                    email: customer.user?.email || "",
                    phone: customer.user?.phone || "",
                },
            });
        } catch (error) {
            console.error("Razorpay create-order error:", error);
            return res.status(error.message && error.message.includes("Amount") ? 400 : 500).json({
                success: false,
                message: error.message || "Failed to create Razorpay order",
            });
        }
    }
);

/**
 * POST /api/payments/razorpay/verify
 * Verifies Razorpay payment signatures on the backend and updates unified payment engine.
 */
router.post(
    "/razorpay/verify",
    authenticateToken,
    authorizeRoles("CUSTOMER", "AGENT", "ADMIN"),
    async (req, res) => {
        try {
            const {
                loanId,
                emiId,
                amount,
                razorpayOrderId,
                razorpayPaymentId,
                razorpaySignature,
            } = req.body;

            if (
                !loanId ||
                !emiId ||
                !razorpayOrderId ||
                !razorpayPaymentId ||
                !razorpaySignature
            ) {
                return res.status(400).json({
                    success: false,
                    message: "loanId, emiId, razorpayOrderId, razorpayPaymentId, and razorpaySignature are required",
                });
            }

            const cleanOrderId = String(razorpayOrderId).trim();
            const cleanPaymentId = String(razorpayPaymentId).trim();
            const cleanSignature = String(razorpaySignature).trim();

            if (!cleanOrderId || !cleanPaymentId || !cleanSignature) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid or empty Razorpay payment identifiers",
                });
            }

            // [DIAGNOSTIC] Verification API request received by backend
            console.log(`[DIAGNOSTIC] Verification API request received by backend — orderId: ${cleanOrderId}, paymentId: ${cleanPaymentId}`);

            const customer = await getResolvedCustomerProfile(req.user);

            if (!customer) {
                return res.status(401).json({
                    success: false,
                    message: "Customer profile not found or session expired. Please log in again.",
                });
            }

            const loan = await prisma.loan.findFirst({
                where: {
                    id: String(loanId).trim(),
                    customerId: customer.id,
                },
            });

            if (!loan) {
                return res.status(404).json({
                    success: false,
                    message: "Loan not found for this customer",
                });
            }

            const emi = await prisma.emiSchedule.findFirst({
                where: {
                    id: String(emiId).trim(),
                    loanId: loan.id,
                },
            });

            if (!emi) {
                return res.status(404).json({
                    success: false,
                    message: "EMI not found for this loan",
                });
            }

            // 1. Signature Verification with Server Secret (HMAC-SHA256)
            const keySecret = process.env.RAZORPAY_KEY_SECRET || "rzp_test_secret_placeholder";
            const payload = `${cleanOrderId}|${cleanPaymentId}`;
            const expectedSignature = crypto
                .createHmac("sha256", keySecret)
                .update(payload)
                .digest("hex");

            const expectedBuf = Buffer.from(expectedSignature, "utf8");
            const actualBuf = Buffer.from(cleanSignature, "utf8");

            const isSignatureValid =
                expectedBuf.length === actualBuf.length &&
                crypto.timingSafeEqual(expectedBuf, actualBuf);

            // [DIAGNOSTIC] Signature verification completed
            console.log(`[DIAGNOSTIC] Signature verification completed — valid: ${isSignatureValid}, orderId: ${cleanOrderId}`);

            if (!isSignatureValid) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid payment signature: verification failed",
                    code: "INVALID_SIGNATURE",
                });
            }

            // 2. Check for existing payment to guarantee strict idempotency
            const existingPayment = await prisma.payment.findUnique({
                where: { transactionId: cleanPaymentId },
                include: { emi: true, loan: true, onlinePayment: true },
            });

            if (existingPayment) {
                // If amount was passed in request, ensure it's not a mismatched retry
                if (amount !== undefined && amount !== null && String(amount).trim() !== "") {
                    const parsedReqAmt = parseAndValidateMoney(amount);
                    if (!new Decimal(existingPayment.amount).equals(parsedReqAmt)) {
                        return res.status(400).json({
                            success: false,
                            message: "Transaction ID already exists with different payment details",
                        });
                    }
                }

                console.log(`[DIAGNOSTIC] Verification idempotent hit — paymentId: ${cleanPaymentId} already recorded with receipt: ${existingPayment.receiptNumber}`);
                // [DIAGNOSTIC] Verification API response returned
                console.log(`[DIAGNOSTIC] Verification API response returned — duplicate: true, receipt: ${existingPayment.receiptNumber}`);
                return res.status(200).json({
                    success: true,
                    message: "Payment already processed",
                    duplicate: true,
                    receiptNumber: existingPayment.receiptNumber,
                    transactionId: existingPayment.transactionId,
                    amount: existingPayment.amount.toString(),
                    paidAt: existingPayment.paidAt,
                    payment: existingPayment,
                    emi: existingPayment.emi,
                    loan: existingPayment.loan,
                });
            }

            // 3. Determine server-authoritative EMI amount
            const emiOutstanding = new Decimal(emi.outstandingAmount);
            if (emiOutstanding.lte(0) || emi.status === "PAID") {
                return res.status(200).json({
                    success: true,
                    message: "This EMI is already fully paid",
                    duplicate: true,
                });
            }

            let emiCreditAmount = emiOutstanding;
            if (amount !== undefined && amount !== null && String(amount).trim() !== "") {
                const parsedReqAmount = parseAndValidateMoney(amount);
                const emiWithFee = Math.round(Number(emiOutstanding.toString()) * 1.02 * 100) / 100;
                if (Math.abs(Number(parsedReqAmount.toString()) - emiWithFee) < 0.05 && emiWithFee > Number(emiOutstanding.toString())) {
                    emiCreditAmount = emiOutstanding;
                } else {
                    emiCreditAmount = parsedReqAmount;
                }
            }

            // 4. Server-side payment verification
            const keyId = process.env.RAZORPAY_KEY_ID;
            const isLiveGateway = Boolean(keyId && keySecret && !keyId.includes("placeholder"));
            const isTestPayment = cleanPaymentId.startsWith("pay_test_") || cleanOrderId.startsWith("order_test_");

            const feeAmount = Math.round(Number(emiCreditAmount.toString()) * 0.02 * 100) / 100;
            let gatewayResponseData = {
                gateway: "RAZORPAY",
                orderId: cleanOrderId,
                paymentId: cleanPaymentId,
                signature: cleanSignature,
                verifiedAt: new Date().toISOString(),
                mode: isLiveGateway && !isTestPayment ? "LIVE_GATEWAY" : "TEST_MODE",
                emiAmount: Number(emiCreditAmount.toString()),
                processingFee: feeAmount,
                feePercentage: "2%",
                totalTransactionAmount: Math.round((Number(emiCreditAmount.toString()) + feeAmount) * 100) / 100,
            };

            if (isLiveGateway && !isTestPayment) {
                const authHeader = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
                let payData = null;
                try {
                    const payRes = await fetchWithTimeout(
                        `https://api.razorpay.com/v1/payments/${cleanPaymentId}`,
                        { headers: { Authorization: authHeader } },
                        15000
                    );
                    payData = await payRes.json();

                    // [DIAGNOSTIC] Payment status retrieved from Razorpay
                    console.log(`[DIAGNOSTIC] Payment status retrieved from Razorpay — status: ${payData.status}, order_id: ${payData.order_id}`);

                    if (!payRes.ok) {
                        return res.status(400).json({
                            success: false,
                            message: payData.error?.description || "Failed to confirm payment details with Razorpay",
                            code: payData.error?.code || "GATEWAY_VERIFICATION_FAILED",
                        });
                    }

                    if (payData.order_id !== cleanOrderId) {
                        return res.status(400).json({
                            success: false,
                            message: "Payment order mismatch: payment does not match the server order",
                            code: "ORDER_MISMATCH",
                        });
                    }

                    if (!["captured", "authorized"].includes(payData.status)) {
                        return res.status(400).json({
                            success: false,
                            message: `Payment is not in a successful captured state (current status: ${payData.status})`,
                            code: "PAYMENT_NOT_CAPTURED",
                        });
                    }

                    gatewayResponseData = {
                        ...gatewayResponseData,
                        status: payData.status,
                        method: payData.method,
                        email: payData.email,
                        contact: payData.contact,
                        capturedAmount: payData.amount,
                        currency: payData.currency,
                    };
                } catch (fetchErr) {
                    console.warn("[DIAGNOSTIC] Razorpay API fetch timed out or network error, falling back to HMAC signature validity:", fetchErr.message);
                    gatewayResponseData.gatewayCheckError = fetchErr.message;
                }
            } else {
                // [DIAGNOSTIC] Payment status retrieved from Razorpay (Mock/Test mode)
                console.log(`[DIAGNOSTIC] Payment status retrieved from Razorpay — status: captured (test mode: ${cleanPaymentId})`);
                gatewayResponseData.status = "captured";
                gatewayResponseData.method = "upi";
            }

            // OnlinePayment unique constraint safeguard on cashfreeOrderId:
            const existingOrderRecord = await prisma.onlinePayment.findUnique({
                where: { cashfreeOrderId: cleanOrderId },
            });
            const storedOrderId = existingOrderRecord ? `${cleanOrderId}_${cleanPaymentId}` : cleanOrderId;

            // 5. Atomically apply payment using payment engine with automatic retry for serialization conflicts
            const result = await applyPaymentWithRetry({
                emiId: emi.id,
                loanId: loan.id,
                amount: emiCreditAmount.toString(),
                mode: "ONLINE",
                transactionId: cleanPaymentId,
                onlinePaymentData: {
                    cashfreeOrderId: storedOrderId,
                    cashfreePaymentId: cleanPaymentId,
                    paymentSessionId: cleanSignature,
                    gatewayResponse: gatewayResponseData,
                },
                userId: req.user.userId,
                ipAddress: req.ip || null,
            });

            // [DIAGNOSTIC] EMI/payment database update completed
            console.log(`[DIAGNOSTIC] EMI/payment database update completed — paymentId: ${result.payment.id}, receipt: ${result.payment.receiptNumber}, duplicate: ${result.duplicate}`);

            // [DIAGNOSTIC] Verification API response returned
            console.log(`[DIAGNOSTIC] Verification API response returned — success: true, receipt: ${result.payment.receiptNumber}`);

            return res.status(result.duplicate ? 200 : 201).json({
                success: true,
                message: result.duplicate
                    ? "Payment already processed"
                    : "Payment recorded successfully",
                duplicate: Boolean(result.duplicate),
                receiptNumber: result.payment.receiptNumber,
                transactionId: result.payment.transactionId,
                amount: result.payment.amount.toString(),
                paidAt: result.payment.paidAt,
                payment: result.payment,
                emi: result.emi,
                loan: result.loan,
            });
        } catch (error) {
            console.error("Razorpay verification error:", error);

            if (
                error.message &&
                (error.message.includes("already fully paid") ||
                    error.message.includes("cannot exceed") ||
                    error.message.includes("Transaction ID already exists"))
            ) {
                return res.status(400).json({
                    success: false,
                    message: error.message,
                });
            }

            return res.status(500).json({
                success: false,
                message: error.message || "Failed to verify and record payment",
            });
        }
    }
);

/**
 * POST /api/payments/razorpay/check-order-status
 * Fallback status check when user returns from UPI app (PhonePe) and checkout modal is dismissed
 * or before handler callback fires.
 */
router.post(
    "/razorpay/check-order-status",
    authenticateToken,
    authorizeRoles("CUSTOMER", "AGENT", "ADMIN"),
    async (req, res) => {
        try {
            const { orderId, paymentLinkId, loanId, emiId } = req.body;

            if (!orderId && !paymentLinkId) {
                return res.status(400).json({
                    success: false,
                    message: "orderId or paymentLinkId is required",
                });
            }

            const cleanOrderId = orderId ? String(orderId).trim() : null;
            const cleanPlinkId = paymentLinkId ? String(paymentLinkId).trim() : null;

            const customer = await getResolvedCustomerProfile(req.user);
            if (!customer) {
                return res.status(401).json({
                    success: false,
                    message: "Customer profile not found or session expired.",
                });
            }

            // 1. Check if a payment for this order already exists in our database
            const existingOnlinePayment = await prisma.onlinePayment.findFirst({
                where: {
                    OR: [
                        cleanOrderId ? { cashfreeOrderId: cleanOrderId } : undefined,
                        cleanPlinkId ? { cashfreeOrderId: cleanPlinkId } : undefined,
                    ].filter(Boolean),
                },
                include: {
                    payment: {
                        include: {
                            emi: true,
                            loan: true,
                        },
                    },
                },
            });

            if (existingOnlinePayment && existingOnlinePayment.payment) {
                const p = existingOnlinePayment.payment;
                return res.json({
                    success: true,
                    status: "captured",
                    receiptNumber: p.receiptNumber,
                    transactionId: p.transactionId,
                    amount: p.amount.toString(),
                    paidAt: p.paidAt,
                    payment: p,
                    emi: p.emi,
                    loan: p.loan,
                });
            }

            // 2. Query Razorpay API for payments associated with this order or payment link
            const keyId = process.env.RAZORPAY_KEY_ID;
            const keySecret = process.env.RAZORPAY_KEY_SECRET;
            const isLiveGateway = Boolean(keyId && keySecret && !keyId.includes("placeholder"));

            if (!isLiveGateway) {
                return res.json({
                    success: false,
                    status: "created",
                    message: "Payment not completed yet in test mode",
                });
            }

            const authHeader = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
            let payments = [];

            if (cleanPlinkId && cleanPlinkId.startsWith("plink_")) {
                try {
                    const plinkRes = await fetchWithTimeout(
                        `https://api.razorpay.com/v1/payment_links/${cleanPlinkId}`,
                        { headers: { Authorization: authHeader } },
                        10000
                    );
                    if (plinkRes.ok) {
                        const plinkData = await plinkRes.json();
                        if (plinkData && Array.isArray(plinkData.payments)) {
                            payments = plinkData.payments;
                        }
                    }
                } catch (err) {
                    console.warn("[CHECK_STATUS] payment link fetch error:", err);
                }
            }

            if (payments.length === 0 && cleanOrderId) {
                const rzpPaymentsRes = await fetchWithTimeout(
                    `https://api.razorpay.com/v1/orders/${cleanOrderId}/payments`,
                    { headers: { Authorization: authHeader } },
                    10000
                );
                if (rzpPaymentsRes.ok) {
                    const rzpPaymentsData = await rzpPaymentsRes.json();
                    payments = rzpPaymentsData.items || [];
                }
            }

            // Find successful payment
            const successfulPayment = payments.find((p) => ["captured", "authorized"].includes(p.status));

            if (!successfulPayment) {
                const pendingPayment = payments.find((p) => p.status === "created");
                const failedPayment = payments.find((p) => p.status === "failed");

                return res.json({
                    success: false,
                    status: pendingPayment ? "created" : failedPayment ? "failed" : "not_found",
                    message: pendingPayment
                        ? "Payment is still processing in PhonePe"
                        : failedPayment
                        ? (failedPayment.error_description || "Payment failed in UPI app")
                        : "No payment detected yet for this order",
                });
            }

            // A successful payment was found in Razorpay! Now safely record it into DB if loanId & emiId known
            const targetLoanId = loanId || successfulPayment.notes?.loanId;
            const targetEmiId = emiId || successfulPayment.notes?.emiId;

            if (!targetLoanId || !targetEmiId) {
                return res.json({
                    success: true,
                    status: successfulPayment.status,
                    transactionId: successfulPayment.id,
                    amount: (successfulPayment.amount / 100).toFixed(2),
                    message: "Payment confirmed on gateway",
                });
            }

            const emi = await prisma.emiSchedule.findFirst({
                where: { id: String(targetEmiId).trim() },
            });
            const loan = await prisma.loan.findFirst({
                where: { id: String(targetLoanId).trim() },
            });

            if (!emi || !loan) {
                return res.json({
                    success: true,
                    status: successfulPayment.status,
                    transactionId: successfulPayment.id,
                    amount: (successfulPayment.amount / 100).toFixed(2),
                });
            }

            const serverAmount = new Decimal(emi.outstandingAmount);
            const feeAmount = Math.round(Number(serverAmount.toString()) * 0.02 * 100) / 100;
            const gatewayResponseData = {
                gateway: "RAZORPAY",
                orderId: cleanOrderId,
                paymentId: successfulPayment.id,
                status: successfulPayment.status,
                method: successfulPayment.method,
                verifiedAt: new Date().toISOString(),
                mode: "LIVE_GATEWAY",
                emiAmount: Number(serverAmount.toString()),
                processingFee: feeAmount,
                totalTransactionAmount: Math.round((Number(serverAmount.toString()) + feeAmount) * 100) / 100,
            };

            const existingOrderRecord = await prisma.onlinePayment.findUnique({
                where: { cashfreeOrderId: cleanOrderId },
            });
            const storedOrderId = existingOrderRecord ? `${cleanOrderId}_${successfulPayment.id}` : cleanOrderId;

            const result = await applyPaymentWithRetry({
                emiId: emi.id,
                loanId: loan.id,
                amount: serverAmount.toString(),
                mode: "ONLINE",
                transactionId: successfulPayment.id,
                onlinePaymentData: {
                    cashfreeOrderId: storedOrderId,
                    cashfreePaymentId: successfulPayment.id,
                    paymentSessionId: null,
                    gatewayResponse: gatewayResponseData,
                },
                userId: req.user.userId,
                ipAddress: req.ip || null,
            });

            return res.json({
                success: true,
                status: "captured",
                receiptNumber: result.payment.receiptNumber,
                transactionId: result.payment.transactionId,
                amount: result.payment.amount.toString(),
                paidAt: result.payment.paidAt,
                payment: result.payment,
                emi: result.emi,
                loan: result.loan,
            });
        } catch (error) {
            console.error("Check order status error:", error);
            return res.status(500).json({
                success: false,
                message: error.message || "Failed to check order status",
            });
        }
    }
);

/*
 * CUSTOMER
 * Get payment history for the logged-in customer.
 */
router.get(
    "/my",
    authenticateToken,
    authorizeRoles("CUSTOMER", "AGENT", "ADMIN"),
    async (req, res) => {
        try {
            const customer = await getResolvedCustomerProfile(req.user);

            if (!customer) {
                return res.status(401).json({
                    success: false,
                    message: "Customer profile not found or session expired. Please log in again.",
                });
            }

            const payments = await prisma.payment.findMany({
                where: {
                    loan: {
                        customerId: customer.id,
                    },
                },
                include: {
                    emi: {
                        select: {
                            installmentNo: true,
                            dueDate: true,
                            emiAmount: true,
                            paidAmount: true,
                            outstandingAmount: true,
                            status: true,
                        },
                    },
                    loan: {
                        select: {
                            id: true,
                            loanNumber: true,
                            status: true,
                        },
                    },
                    onlinePayment: true,
                    cashCollection: {
                        include: {
                            agent: {
                                include: {
                                    user: {
                                        select: {
                                            name: true,
                                            phone: true,
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                orderBy: {
                    createdAt: "desc",
                },
            });

            return res.json({
                success: true,
                count: payments.length,
                payments,
            });
        } catch (error) {
            console.error("Payment history error:", error);

            return res.status(500).json({
                success: false,
                message: "Failed to fetch payment history",
            });
        }
    }
);

/*
 * CUSTOMER
 * Make a payment against an EMI.
 *
 * This endpoint is currently for backend testing.
 * Cashfree will be connected later.
 */
router.post(
    "/online",
    authenticateToken,
    authorizeRoles("CUSTOMER", "AGENT", "ADMIN"),
    async (req, res) => {
        try {
            const {
                loanId,
                emiId,
                amount,
                cashfreeOrderId,
                cashfreePaymentId,
                paymentSessionId,
            } = req.body;

            if (!loanId || !emiId || amount === undefined) {
                return res.status(400).json({
                    success: false,
                    message: "loanId, emiId and amount are required",
                });
            }

            const customer = await getResolvedCustomerProfile(req.user);

            if (!customer) {
                return res.status(401).json({
                    success: false,
                    message: "Customer profile not found or session expired. Please log in again.",
                });
            }

            /*
             * Verify that this loan belongs to the logged-in customer.
             */
            const loan = await prisma.loan.findFirst({
                where: {
                    id: loanId,
                    customerId: customer.id,
                },
            });

            if (!loan) {
                return res.status(404).json({
                    success: false,
                    message: "Loan not found",
                });
            }

            const emi = await prisma.emiSchedule.findFirst({
                where: {
                    id: emiId,
                    loanId,
                },
            });

            if (!emi) {
                return res.status(404).json({
                    success: false,
                    message: "EMI not found",
                });
            }

            const parsedAmount = Number(amount);
            const calculatedFee = Math.round(parsedAmount * 0.02 * 100) / 100;
            const processingFee = req.body.processingFee !== undefined
                ? Math.round(Number(req.body.processingFee) * 100) / 100
                : calculatedFee;
            const totalTransactionAmount = Math.round((parsedAmount + processingFee) * 100) / 100;

            const result = await applyPaymentToEmi({
                emiId,
                loanId,
                amount: parsedAmount,
                mode: "ONLINE",
                transactionId:
                    cashfreePaymentId || null,
                onlinePaymentData: {
                    cashfreeOrderId:
                        cashfreeOrderId ||
                        `TEST-ORDER-${Date.now()}`,
                    cashfreePaymentId:
                        cashfreePaymentId || null,
                    paymentSessionId:
                        paymentSessionId || null,
                    gatewayResponse: {
                        source: "ONLINE_PAYMENT",
                        emiAmount: parsedAmount,
                        processingFee: processingFee,
                        feePercentage: "2%",
                        totalTransactionAmount: totalTransactionAmount,
                    },
                },
                userId: req.user.userId,
                ipAddress: req.ip || null,
            });

            return res.status(201).json({
                success: true,
                message: result.duplicate
                    ? "Payment already processed"
                    : "Payment recorded successfully",
                duplicate: result.duplicate,
                payment: {
                    ...result.payment,
                    processingFee,
                    totalPaid: totalTransactionAmount,
                },
                emi: result.emi,
            });
        } catch (error) {
            console.error("Online payment error:", error);

            return res.status(400).json({
                success: false,
                message: error.message || "Payment failed",
            });
        }
    }
);

/*
 * AGENT
 * Record a cash EMI collection.
 */
router.post(
    "/cash",
    authenticateToken,
    authorizeRoles("AGENT"),
    async (req, res) => {
        try {
            const {
                loanId,
                emiId,
                amount,
                notes,
            } = req.body;

            if (!loanId || !emiId || amount === undefined) {
                return res.status(400).json({
                    success: false,
                    message: "loanId, emiId and amount are required",
                });
            }

            /*
             * Verify that the logged-in user is an active agent.
             */
            const agent = await prisma.agentProfile.findUnique({
                where: {
                    userId: req.user.userId,
                },
            });

            if (!agent) {
                return res.status(404).json({
                    success: false,
                    message: "Agent profile not found",
                });
            }

            /*
             * Verify loan exists.
             */
            const loan = await prisma.loan.findUnique({
                where: {
                    id: loanId,
                },
            });

            if (!loan) {
                return res.status(404).json({
                    success: false,
                    message: "Loan not found",
                });
            }

            /*
             * Verify EMI belongs to loan.
             */
            const emi = await prisma.emiSchedule.findFirst({
                where: {
                    id: emiId,
                    loanId,
                },
            });

            if (!emi) {
                return res.status(404).json({
                    success: false,
                    message: "EMI not found",
                });
            }

            const result = await applyPaymentToEmi({
                emiId,
                loanId,
                amount,
                mode: "CASH",
                agentId: agent.id,
                notes: notes || null,
                userId: req.user.userId,
                ipAddress: req.ip || null,
            });

            return res.status(201).json({
                success: true,
                message: "Cash collection recorded successfully",
                payment: result.payment,
                emi: result.emi,
            });
        } catch (error) {
            console.error("Cash collection error:", error);

            return res.status(400).json({
                success: false,
                message:
                    error.message || "Cash collection failed",
            });
        }
    }
);

module.exports = router;