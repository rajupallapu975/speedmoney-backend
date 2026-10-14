const express = require("express");
const { Prisma } = require("@prisma/client");

const prisma = require("../lib/prisma");
const { authenticateToken } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");
const { parseDateRange } = require("../lib/date-utils");

const router = express.Router();

// All admin collection routes require an authenticated administrator
router.use(authenticateToken, authorizeRoles("ADMIN"));

/**
 * GET /api/admin/cash-collections
 * 
 * Administrative collection oversight endpoint.
 * Allows filtering by date range, agent, loan, and reconciliation status.
 */
router.get("/", async (req, res) => {
    try {
        const where = {};

        // 1. Pagination parameters
        let page = parseInt(req.query.page, 10);
        if (isNaN(page) || page < 1) page = 1;

        let limit = parseInt(req.query.limit, 10);
        if (isNaN(limit) || limit < 1) limit = 20;
        if (limit > 100) limit = 100;

        const skip = (page - 1) * limit;

        // 2. Date range filtering (in IST business timezone)
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

        // 3. Agent filter
        if (req.query.agentId) {
            where.agentId = String(req.query.agentId).trim();
        }

        // 4. Loan filter
        if (req.query.loanId) {
            where.payment = {
                ...where.payment,
                loanId: String(req.query.loanId).trim(),
            };
        }

        // 5. Reconciliation status filter
        if (req.query.reconciled !== undefined && req.query.reconciled !== "") {
            const recStr = String(req.query.reconciled).toLowerCase();
            if (!["true", "false"].includes(recStr)) {
                return res.status(400).json({
                    success: false,
                    message: "reconciled query parameter must be 'true' or 'false'",
                });
            }
            where.reconciled = recStr === "true";
        }

        // 6. Execute aggregation and records query concurrently
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
                    agent: {
                        select: {
                            id: true,
                            employeeCode: true,
                            user: {
                                select: {
                                    id: true,
                                    name: true,
                                    email: true,
                                    phone: true,
                                    status: true,
                                },
                            },
                        },
                    },
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

        // Separate reconciliation breakdown
        const [recAgg, unrecAgg] = await Promise.all([
            prisma.cashCollection.aggregate({
                where: {
                    ...where,
                    reconciled: true,
                },
                _sum: {
                    collectedAmount: true,
                },
                _count: {
                    _all: true,
                },
            }),
            prisma.cashCollection.aggregate({
                where: {
                    ...where,
                    reconciled: false,
                },
                _sum: {
                    collectedAmount: true,
                },
                _count: {
                    _all: true,
                },
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
                collectionsCount: aggResult._count._all || 0,
                reconciledAmount: recAgg._sum.collectedAmount
                    ? recAgg._sum.collectedAmount.toString()
                    : "0",
                reconciledCount: recAgg._count._all || 0,
                unreconciledAmount: unrecAgg._sum.collectedAmount
                    ? unrecAgg._sum.collectedAmount.toString()
                    : "0",
                unreconciledCount: unrecAgg._count._all || 0,
            },
            collections: collections.map((c) => ({
                id: c.id,
                receiptNumber: c.receiptNumber,
                collectedAmount: c.collectedAmount.toString(),
                collectedAt: c.collectedAt,
                reconciled: c.reconciled,
                reconciledAt: c.reconciledAt,
                notes: c.notes,
                agent: {
                    id: c.agent.id,
                    employeeCode: c.agent.employeeCode,
                    name: c.agent.user?.name || "N/A",
                    phone: c.agent.user?.phone || null,
                    email: c.agent.user?.email || null,
                },
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
        console.error("Admin cash collections oversight error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch cash collections oversight data",
        });
    }
});

module.exports = router;
