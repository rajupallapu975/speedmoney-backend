const crypto = require("crypto");
const express = require("express");

const prisma = require("../lib/prisma");
const { authenticateToken } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");
const {
    applyPaymentWithRetry,
    parseAndValidateMoney,
    toDecimal,
} = require("../services/payment-engine");
const { parseDateRange } = require("../lib/date-utils");

const router = express.Router();

// Middleware: all collection endpoints require an authenticated AGENT
router.use(authenticateToken, authorizeRoles("AGENT"));

/**
 * Verifies whether an existing committed payment matches the request details.
 */
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

    const existingNotes = existingPayment.cashCollection.notes || null;
    const requestedNotes = normalizedNotes || null;
    if (existingNotes !== requestedNotes) return false;

    return true;
}

/**
 * Formats a payment, emi, loan, and cashCollection into the standard API response shape.
 */
function formatCollectionResponse(
    payment,
    emi,
    loan,
    cashCollection,
    duplicate = false,
    shortfallRolled = null,
    nextEmi = null
) {
    const statusCode = duplicate ? 200 : 201;
    const message = duplicate
        ? "Collection request already processed"
        : (payment.mode === "ONLINE"
            ? "Dynamic UPI QR payment recorded successfully"
            : (shortfallRolled
                ? `Cash collection recorded. Shortfall of ₹${shortfallRolled} rolled forward to next EMI.`
                : "Cash collection recorded successfully"));

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
            shortfallRolled: shortfallRolled ? shortfallRolled.toString() : null,
            nextEmi: nextEmi ? {
                id: nextEmi.id,
                installmentNo: nextEmi.installmentNo,
                emiAmount: nextEmi.emiAmount.toString(),
                outstandingAmount: nextEmi.outstandingAmount.toString(),
            } : null,
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

/**
 * Core handler for recording a cash collection.
 */
async function handleCashCollection(req, res) {
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

        // 1. Validate mandatory input fields
        if (!loanId || typeof loanId !== "string" || !loanId.trim()) {
            return res.status(400).json({
                success: false,
                message: "loanId is required",
            });
        }

        if (!emiId || typeof emiId !== "string" || !emiId.trim()) {
            return res.status(400).json({
                success: false,
                message: "emiId is required",
            });
        }

        if (amount === undefined || amount === null || amount === "") {
            return res.status(400).json({
                success: false,
                message: "amount is required",
            });
        }

        // 2. Validate amount representation and decimals
        try {
            parsedAmount = parseAndValidateMoney(amount);
        } catch (validationError) {
            return res.status(400).json({
                success: false,
                message: validationError.message,
            });
        }

        normalizedNotes = notes && typeof notes === "string" ? notes.trim() : null;

        // 3. Confirm authenticated user is an active AGENT and load profile
        agent = await prisma.agentProfile.findUnique({
            where: {
                userId: req.user.userId,
            },
            include: {
                user: {
                    select: {
                        id: true,
                        status: true,
                        name: true,
                        email: true,
                    },
                },
            },
        });

        if (!agent) {
            return res.status(404).json({
                success: false,
                message: "Agent profile not found",
            });
        }

        if (agent.user.status !== "ACTIVE") {
            return res.status(403).json({
                success: false,
                message: "Your agent account is inactive",
            });
        }

        // 4. Idempotency & Early Replay Detection
        // Support client-provided idempotency key from header or body
        const rawIdempotencyKey =
            req.headers["idempotency-key"] ||
            body.idempotencyKey ||
            null;

        if (rawIdempotencyKey) {
            const sanitizedKey = String(rawIdempotencyKey)
                .trim()
                .slice(0, 64)
                .replace(/[^a-zA-Z0-9_-]/g, "");

            if (!sanitizedKey) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid Idempotency-Key provided",
                });
            }

            // Namespace transactionId to the agent to prevent collisions or spoofing
            transactionId = `CASH-${agent.id}-${sanitizedKey}`;

            // EARLY REPLAY DETECTION BEFORE MUTABLE LOAN/EMI ELIGIBILITY CHECKS
            const existingPayment = await prisma.payment.findUnique({
                where: { transactionId },
                include: {
                    cashCollection: true,
                    emi: true,
                    loan: true,
                },
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
            // Generate unique, non-replayable transaction identifier
            const uniqueNonce = crypto.randomBytes(6).toString("hex");
            transactionId = `CASH-${agent.id}-${Date.now()}-${uniqueNonce}`;
        }

        // 5. Verify loan exists and is eligible for collection
        const loan = await prisma.loan.findUnique({
            where: {
                id: loanId.trim(),
            },
        });

        if (!loan) {
            return res.status(404).json({
                success: false,
                message: "Loan not found",
            });
        }

        if (!["ACTIVE", "OVERDUE"].includes(loan.status)) {
            return res.status(400).json({
                success: false,
                message: `Loan is not eligible for collection (current status: ${loan.status})`,
            });
        }

        // 6. Verify agent has an active assignment for this exact loan
        const activeAssignment = await prisma.loanAgentAssignment.findFirst({
            where: {
                loanId: loan.id,
                agentId: agent.id,
                active: true,
            },
        });

        if (!activeAssignment) {
            return res.status(403).json({
                success: false,
                message:
                    "You do not have an active assignment to collect for this loan",
            });
        }

        // 7. Verify EMI exists, belongs to this loan, and is unpaid/eligible
        const emi = await prisma.emiSchedule.findUnique({
            where: {
                id: emiId.trim(),
            },
        });

        if (!emi) {
            return res.status(404).json({
                success: false,
                message: "EMI not found",
            });
        }

        if (emi.loanId !== loan.id) {
            return res.status(400).json({
                success: false,
                message: "EMI does not belong to the specified loan",
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
                message: "This EMI has been waived and cannot be collected",
            });
        }

        if (!["PENDING", "PARTIAL", "OVERDUE"].includes(emi.status)) {
            return res.status(400).json({
                success: false,
                message: `This EMI is not eligible for collection (status: ${emi.status})`,
            });
        }

        // 8. Balance checks
        const emiOutstanding = Number(emi.outstandingAmount);
        if (emiOutstanding <= 0) {
            return res.status(400).json({
                success: false,
                message: "This EMI has no remaining outstanding balance",
            });
        }

        if (parsedAmount.gt(loan.outstandingAmount)) {
            return res.status(400).json({
                success: false,
                message: `Collection amount cannot exceed loan outstanding amount of ₹${loan.outstandingAmount.toString()}`,
            });
        }

        // 9. Execute atomic payment recording with bounded retry for serialization conflicts
        const ipAddress =
            req.ip ||
            req.headers["x-forwarded-for"] ||
            req.socket?.remoteAddress ||
            null;

        const result = await applyPaymentWithRetry({
            emiId: emi.id,
            loanId: loan.id,
            amount: parsedAmount.toString(),
            mode: "CASH",
            transactionId,
            agentId: agent.id,
            notes: normalizedNotes,
            userId: req.user.userId,
            ipAddress,
        });

        const { statusCode, body: resBody } = formatCollectionResponse(
            result.payment,
            result.emi,
            result.loan,
            result.cashCollection,
            result.duplicate,
            result.shortfallRolled,
            result.nextEmi
        );

        return res.status(statusCode).json(resBody);
    } catch (error) {
        console.error("Cash collection error:", error);

        // Concurrent request safety:
        // If an idempotency key was supplied and this request failed due to a unique constraint
        // conflict or race condition (e.g., another concurrent worker committed the same transactionId),
        // re-read the committed payment and return it if matching.
        if (transactionId && agent) {
            try {
                const committedPayment = await prisma.payment.findUnique({
                    where: { transactionId },
                    include: {
                        cashCollection: true,
                        emi: true,
                        loan: true,
                    },
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
                console.error("Error re-checking committed transaction after conflict:", recheckErr);
            }
        }

        if (
            error.message &&
            (error.message.includes("cannot exceed outstanding amount") ||
                error.message.includes("already fully paid") ||
                error.message.includes("not eligible") ||
                error.message.includes("Transaction ID already exists"))
        ) {
            return res.status(400).json({
                success: false,
                message: error.message,
            });
        }

        return res.status(500).json({
            success: false,
            message: error.message || "Failed to record cash collection",
        });
    }
}

/**
 * Handler for fetching agent's cash collection history.
 */
async function handleGetAgentCashCollections(req, res) {
    try {
        // 1. Confirm authenticated agent profile
        const agent = await prisma.agentProfile.findUnique({
            where: {
                userId: req.user.userId,
            },
            include: {
                user: {
                    select: {
                        id: true,
                        status: true,
                        name: true,
                        email: true,
                    },
                },
            },
        });

        if (!agent) {
            return res.status(404).json({
                success: false,
                message: "Agent profile not found",
            });
        }

        if (agent.user.status !== "ACTIVE") {
            return res.status(403).json({
                success: false,
                message: "Your agent account is inactive",
            });
        }

        // 2. Pagination
        let page = parseInt(req.query.page, 10);
        if (isNaN(page) || page < 1) page = 1;

        let limit = parseInt(req.query.limit || req.query.pageSize, 10);
        if (isNaN(limit) || limit < 1) limit = 20;
        if (limit > 100) limit = 100;

        const skip = (page - 1) * limit;

        // 3. Where clause strictly isolated to this agent
        const where = {
            agentId: agent.id,
        };

        // 4. Date range filter
        const { startDate, endDate } = req.query;
        if (startDate || endDate) {
            try {
                const { start, end } = parseDateRange(startDate, endDate);
                where.collectedAt = {};
                if (start) where.collectedAt.gte = start;
                if (end) where.collectedAt.lt = end;
            } catch (dateErr) {
                return res.status(400).json({
                    success: false,
                    message: dateErr.message,
                });
            }
        }

        // Optional loan filter
        if (req.query.loanId) {
            where.payment = {
                loanId: String(req.query.loanId).trim(),
            };
        }

        // 5. Query count, aggregations, and records
        const [totalRecords, aggResult, collections] = await Promise.all([
            prisma.cashCollection.count({ where }),
            prisma.cashCollection.aggregate({
                where,
                _sum: {
                    collectedAmount: true,
                },
                _count: {
                    _all: true,
                },
            }),
            prisma.cashCollection.findMany({
                where,
                include: {
                    payment: {
                        select: {
                            id: true,
                            amount: true,
                            mode: true,
                            status: true,
                            transactionId: true,
                            receiptNumber: true,
                            paidAt: true,
                            createdAt: true,
                            loan: {
                                select: {
                                    id: true,
                                    loanNumber: true,
                                    status: true,
                                    customer: {
                                        select: {
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
                            emi: {
                                select: {
                                    id: true,
                                    installmentNo: true,
                                    dueDate: true,
                                    emiAmount: true,
                                    status: true,
                                },
                            },
                        },
                    },
                },
                orderBy: [
                    { collectedAt: "desc" },
                    { id: "desc" },
                ],
                skip,
                take: limit,
            }),
        ]);

        const totalPages = Math.ceil(totalRecords / limit) || 1;

        return res.json({
            success: true,
            pagination: {
                page,
                limit,
                totalRecords,
                totalPages,
            },
            summary: {
                totalCollectedAmount: aggResult._sum.collectedAmount
                    ? aggResult._sum.collectedAmount.toString()
                    : "0",
                count: aggResult._count._all || 0,
            },
            collections: collections.map((c) => ({
                id: c.id,
                receiptNumber: c.receiptNumber,
                collectedAmount: c.collectedAmount.toString(),
                collectedAt: c.collectedAt,
                reconciled: c.reconciled,
                reconciledAt: c.reconciledAt,
                notes: c.notes,
                payment: {
                    id: c.payment.id,
                    amount: c.payment.amount.toString(),
                    mode: c.payment.mode,
                    status: c.payment.status,
                    transactionId: c.payment.transactionId,
                    paidAt: c.payment.paidAt,
                },
                loan: {
                    id: c.payment.loan.id,
                    loanNumber: c.payment.loan.loanNumber,
                    status: c.payment.loan.status,
                },
                emi: {
                    id: c.payment.emi.id,
                    installmentNo: c.payment.emi.installmentNo,
                    dueDate: c.payment.emi.dueDate,
                    status: c.payment.emi.status,
                },
                customer: {
                    name: c.payment.loan.customer?.user?.name || "N/A",
                    phone: c.payment.loan.customer?.user?.phone || null,
                },
            })),
        });
    } catch (error) {
        console.error("Agent cash collections history error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch cash collections history",
        });
    }
}

/**
 * Core handler for recording dynamic QR Code collection by Agent.
 */
async function handleQrCollection(req, res) {
    let transactionId = null;
    let agent = null;
    let loanId = null;
    let emiId = null;
    let parsedAmount = null;

    try {
        const body = req.body || {};
        loanId = body.loanId;
        emiId = body.emiId;
        const amount = body.amount;
        const notes = body.notes;

        if (!loanId || !emiId || amount === undefined) {
            return res.status(400).json({
                success: false,
                message: "loanId, emiId and amount are required",
            });
        }

        try {
            parsedAmount = parseAndValidateMoney(amount);
        } catch (validationError) {
            return res.status(400).json({
                success: false,
                message: validationError.message,
            });
        }

        agent = await prisma.agentProfile.findUnique({
            where: { userId: req.user.userId },
            include: { user: true },
        });

        if (!agent || agent.user.status !== "ACTIVE") {
            return res.status(403).json({
                success: false,
                message: "Your agent account is inactive or not found",
            });
        }

        const loan = await prisma.loan.findUnique({
            where: { id: loanId.trim() },
        });

        if (!loan || !["ACTIVE", "OVERDUE"].includes(loan.status)) {
            return res.status(400).json({
                success: false,
                message: "Loan not eligible for collection",
            });
        }

        const emi = await prisma.emiSchedule.findUnique({
            where: { id: emiId.trim() },
        });

        if (!emi || emi.loanId !== loan.id || emi.status === "PAID") {
            return res.status(400).json({
                success: false,
                message: "Invalid or already paid EMI",
            });
        }

        if (parsedAmount.gt(loan.outstandingAmount)) {
            return res.status(400).json({
                success: false,
                message: `Collection amount cannot exceed loan outstanding amount of ₹${loan.outstandingAmount.toString()}`,
            });
        }

        const uniqueNonce = crypto.randomBytes(4).toString("hex").toUpperCase();
        transactionId = `UPI-QR-${Date.now()}-${uniqueNonce}`;

        const result = await applyPaymentWithRetry({
            emiId: emi.id,
            loanId: loan.id,
            amount: parsedAmount.toString(),
            mode: "ONLINE",
            transactionId,
            agentId: agent.id,
            notes: notes ? `Dynamic QR: ${notes}` : `Dynamic UPI QR Collection by Agent ${agent.user.name}`,
            onlinePaymentData: {
                cashfreeOrderId: `QR_ORDER_${Date.now()}`,
                gatewayResponse: {
                    method: "UPI_QR",
                    agentId: agent.id,
                    agentName: agent.user.name,
                },
            },
            userId: req.user.userId,
            ipAddress: req.ip || null,
        });

        const { statusCode, body: resBody } = formatCollectionResponse(
            result.payment,
            result.emi,
            result.loan,
            null,
            result.duplicate,
            result.shortfallRolled,
            result.nextEmi
        );

        return res.status(statusCode).json(resBody);
    } catch (error) {
        console.error("QR collection error:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to process QR collection",
        });
    }
}

// Support both POST / and POST /cash-collections
router.post("/", handleCashCollection);
router.post("/cash-collections", handleCashCollection);

// Support dynamic QR collection by Agent
router.post("/qr", handleQrCollection);
router.post("/qr-collection", handleQrCollection);

// Support GET / and GET /cash-collections for collection history
router.get("/", handleGetAgentCashCollections);
router.get("/cash-collections", handleGetAgentCashCollections);

module.exports = router;

