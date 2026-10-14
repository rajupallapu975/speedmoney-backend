const express = require("express");

const { Prisma } = require("@prisma/client");
const prisma = require("../lib/prisma");
const { authenticateToken } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");
const { getBusinessDayRange } = require("../lib/date-utils");

/**
 * Reusable helper to verify and load an active agent profile.
 */
async function getActiveAgent(userId) {
    const agent = await prisma.agentProfile.findUnique({
        where: { userId },
        include: {
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
    });

    if (!agent) {
        const error = new Error("Agent profile not found");
        error.statusCode = 404;
        throw error;
    }

    if (agent.user.status !== "ACTIVE") {
        const error = new Error("Your agent account is inactive");
        error.statusCode = 403;
        throw error;
    }

    return agent;
}

const router = express.Router();

// All endpoints require an authenticated agent.
router.use(authenticateToken, authorizeRoles("AGENT"));

/*
 * GET /api/agent/dashboard
 *
 * Return the logged-in agent's profile,
 * assigned areas, and assignment counts.
 */
router.get("/", async (req, res) => {
    try {
        const agent = await prisma.agentProfile.findUnique({
            where: {
                userId: req.user.userId,
            },
            include: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        phone: true,
                        status: true,
                        createdAt: true,
                    },
                },
                areas: {
                    include: {
                        area: true,
                    },
                },
                assignments: {
                    where: {
                        active: true,
                    },
                    select: {
                        id: true,
                        customerId: true,
                        type: true,
                        assignedAt: true,
                    },
                },
                loanAssignments: {
                    where: {
                        active: true,
                    },
                    select: {
                        id: true,
                        loanId: true,
                        type: true,
                        assignedAt: true,
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

        return res.json({
            success: true,
            agent: {
                id: agent.id,
                employeeCode: agent.employeeCode,
                joiningDate: agent.joiningDate,
                address: agent.address,
                city: agent.city,
                state: agent.state,
                user: agent.user,
                assignedAreas: agent.areas.map((assignment) => ({
                    id: assignment.area.id,
                    name: assignment.area.name,
                    city: assignment.area.city,
                    state: assignment.area.state,
                    assignedAt: assignment.assignedAt,
                })),
                activeCustomerAssignments: agent.assignments.length,
                activeLoanAssignments: agent.loanAssignments.length,
            },
        });
    } catch (error) {
        console.error("Agent dashboard error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch agent dashboard",
        });
    }
});

/*
 * GET /api/agent/assigned-loans
 *
 * Return only loans actively assigned to the logged-in agent.
 */
router.get("/assigned-loans", async (req, res) => {
    try {
        const agent = await prisma.agentProfile.findUnique({
            where: {
                userId: req.user.userId,
            },
            include: {
                user: {
                    select: {
                        status: true,
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

        const assignments = await prisma.loanAgentAssignment.findMany({
            where: {
                agentId: agent.id,
                active: true,
                loan: {
                    status: {
                        in: ["ACTIVE", "OVERDUE"],
                    },
                },
            },
            include: {
                loan: {
                    include: {
                        application: {
                            include: {
                                customer: {
                                    include: {
                                        user: {
                                            select: {
                                                id: true,
                                                name: true,
                                                phone: true,
                                                email: true,
                                            },
                                        },
                                    },
                                },
                                product: {
                                    select: {
                                        name: true,
                                    },
                                },
                            },
                        },
                        emis: {
                            where: {
                                status: {
                                    in: ["PENDING", "PARTIAL", "OVERDUE"],
                                },
                            },
                            orderBy: {
                                dueDate: "asc",
                            },
                        },
                    },
                },
            },
            orderBy: {
                assignedAt: "desc",
            },
        });

        return res.json({
            success: true,
            count: assignments.length,
            loans: assignments.map((assignment) => ({
                assignmentId: assignment.id,
                assignmentType: assignment.type,
                assignedAt: assignment.assignedAt,
                loan: assignment.loan,
            })),
        });
    } catch (error) {
        console.error("Agent assigned loans error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch assigned loans",
        });
    }
});

/*
 * GET /api/agent/today-dues
 *
 * Return EMIs due today or overdue for loans actively assigned to this agent.
 * Excludes fully paid and waived EMIs.
 */
router.get("/today-dues", async (req, res) => {
    try {
        const agent = await getActiveAgent(req.user.userId);

        const { date } = req.query;
        let dayRange;
        try {
            dayRange = getBusinessDayRange(date);
        } catch (dateErr) {
            return res.status(400).json({
                success: false,
                message: dateErr.message,
            });
        }

        let page = parseInt(req.query.page, 10);
        if (isNaN(page) || page < 1) page = 1;

        let limit = parseInt(req.query.limit, 10);
        if (isNaN(limit) || limit < 1) limit = 20;
        if (limit > 100) limit = 100;

        const skip = (page - 1) * limit;

        // Dues filter:
        // - EMIs due on or before today's business date (dueDate <= endOfDayInclusive)
        // - Not fully paid or waived (status in PENDING, PARTIAL, OVERDUE)
        // - Outstanding amount > 0
        // - Belonging to active/overdue loans actively assigned to this agent
        const where = {
            status: {
                in: ["PENDING", "PARTIAL", "OVERDUE"],
            },
            outstandingAmount: {
                gt: 0,
            },
            dueDate: {
                lte: dayRange.endOfDayInclusive,
            },
            loan: {
                status: {
                    in: ["ACTIVE", "OVERDUE"],
                },
                agentAssignments: {
                    some: {
                        agentId: agent.id,
                        active: true,
                    },
                },
            },
        };

        const [totalCount, sumAgg, dues] = await Promise.all([
            prisma.emiSchedule.count({ where }),
            prisma.emiSchedule.aggregate({
                where,
                _sum: {
                    outstandingAmount: true,
                },
            }),
            prisma.emiSchedule.findMany({
                where,
                include: {
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
                },
                orderBy: [
                    { dueDate: "asc" },
                    { installmentNo: "asc" },
                    { id: "asc" },
                ],
                skip,
                take: limit,
            }),
        ]);

        const totalPages = Math.ceil(totalCount / limit) || 1;

        return res.json({
            success: true,
            date: dayRange.businessDate,
            count: dues.length,
            totalDuesCount: totalCount,
            totalDueAmount: sumAgg._sum.outstandingAmount
                ? sumAgg._sum.outstandingAmount.toString()
                : "0",
            pagination: {
                page,
                limit,
                totalRecords: totalCount,
                totalPages,
            },
            dues: dues.map((e) => ({
                emiId: e.id,
                loanId: e.loanId,
                loanNumber: e.loan.loanNumber,
                loanStatus: e.loan.status,
                installmentNo: e.installmentNo,
                dueDate: e.dueDate,
                emiAmount: e.emiAmount.toString(),
                paidAmount: e.paidAmount.toString(),
                outstandingAmount: e.outstandingAmount.toString(),
                status: e.status,
                customer: {
                    name: e.loan.customer?.user?.name || "N/A",
                    phone: e.loan.customer?.user?.phone || null,
                },
            })),
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({
                success: false,
                message: error.message,
            });
        }
        console.error("Agent today dues error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch today's assigned dues",
        });
    }
});

/*
 * GET /api/agent/collection-summary/daily
 *
 * Daily collection summary for the authenticated agent.
 * Aggregates successful CASH collections only.
 */
router.get("/collection-summary/daily", async (req, res) => {
    try {
        const agent = await getActiveAgent(req.user.userId);

        const { date } = req.query;
        let dayRange;
        try {
            dayRange = getBusinessDayRange(date);
        } catch (dateErr) {
            return res.status(400).json({
                success: false,
                message: dateErr.message,
            });
        }

        // Cash collections strictly for this agent and business day
        const cashCollectionWhere = {
            agentId: agent.id,
            collectedAt: {
                gte: dayRange.startOfDay,
                lt: dayRange.endOfDay,
            },
            payment: {
                status: "SUCCESS",
                mode: "CASH",
            },
        };

        const [collectionAgg, collectionsList, emisDueCount, remainingDueCount] = await Promise.all([
            prisma.cashCollection.aggregate({
                where: cashCollectionWhere,
                _sum: {
                    collectedAmount: true,
                },
                _count: {
                    _all: true,
                },
            }),
            prisma.cashCollection.findMany({
                where: cashCollectionWhere,
                select: {
                    payment: {
                        select: {
                            emiId: true,
                        },
                    },
                },
            }),
            // EMIs due on this specific date for actively assigned loans
            prisma.emiSchedule.count({
                where: {
                    dueDate: {
                        gte: dayRange.startOfDay,
                        lt: dayRange.endOfDay,
                    },
                    loan: {
                        status: {
                            in: ["ACTIVE", "OVERDUE"],
                        },
                        agentAssignments: {
                            some: {
                                agentId: agent.id,
                                active: true,
                            },
                        },
                    },
                },
            }),
            // Remaining due EMIs for this business date that are not fully paid or waived
            prisma.emiSchedule.count({
                where: {
                    dueDate: {
                        gte: dayRange.startOfDay,
                        lt: dayRange.endOfDay,
                    },
                    status: {
                        in: ["PENDING", "PARTIAL", "OVERDUE"],
                    },
                    outstandingAmount: {
                        gt: 0,
                    },
                    loan: {
                        status: {
                            in: ["ACTIVE", "OVERDUE"],
                        },
                        agentAssignments: {
                            some: {
                                agentId: agent.id,
                                active: true,
                            },
                        },
                    },
                },
            }),
        ]);

        const distinctEmisCollected = new Set(collectionsList.map((c) => c.payment.emiId)).size;
        const totalCash = collectionAgg._sum.collectedAmount
            ? collectionAgg._sum.collectedAmount.toString()
            : "0";
        const totalCount = collectionAgg._count._all || 0;

        return res.json({
            success: true,
            date: dayRange.businessDate,
            totalCashCollected: totalCash,
            successfulCollectionsCount: totalCount,
            emisDueToday: emisDueCount,
            emisCollectedToday: distinctEmisCollected,
            remainingDueEmis: remainingDueCount,
            breakdown: {
                cash: {
                    amount: totalCash,
                    count: totalCount,
                },
            },
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({
                success: false,
                message: error.message,
            });
        }
        console.error("Agent daily collection summary error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch daily collection summary",
        });
    }
});

/*
 * GET /api/agent/cash-reconciliation/daily
 *
 * Read-only end-of-day cash reconciliation summary for the authenticated agent.
 */
router.get("/cash-reconciliation/daily", async (req, res) => {
    try {
        const agent = await getActiveAgent(req.user.userId);

        const { date } = req.query;
        let dayRange;
        try {
            dayRange = getBusinessDayRange(date);
        } catch (dateErr) {
            return res.status(400).json({
                success: false,
                message: dateErr.message,
            });
        }

        const where = {
            agentId: agent.id,
            collectedAt: {
                gte: dayRange.startOfDay,
                lt: dayRange.endOfDay,
            },
            payment: {
                status: "SUCCESS",
                mode: "CASH",
            },
        };

        const collections = await prisma.cashCollection.findMany({
            where,
            include: {
                payment: {
                    select: {
                        id: true,
                        status: true,
                        mode: true,
                        loan: {
                            select: {
                                id: true,
                                loanNumber: true,
                            },
                        },
                        emi: {
                            select: {
                                id: true,
                                installmentNo: true,
                            },
                        },
                    },
                },
            },
            orderBy: [
                { collectedAt: "desc" },
                { id: "desc" },
            ],
        });

        let totalCollectedAmount = new Prisma.Decimal(0);
        let reconciledAmount = new Prisma.Decimal(0);
        let unreconciledAmount = new Prisma.Decimal(0);
        let reconciledCount = 0;
        let unreconciledCount = 0;

        for (const c of collections) {
            totalCollectedAmount = totalCollectedAmount.plus(c.collectedAmount);
            if (c.reconciled) {
                reconciledAmount = reconciledAmount.plus(c.collectedAmount);
                reconciledCount++;
            } else {
                unreconciledAmount = unreconciledAmount.plus(c.collectedAmount);
                unreconciledCount++;
            }
        }

        return res.json({
            success: true,
            date: dayRange.businessDate,
            totalCollectedAmount: totalCollectedAmount.toString(),
            collectionsCount: collections.length,
            reconciledCount,
            unreconciledCount,
            reconciledAmount: reconciledAmount.toString(),
            unreconciledAmount: unreconciledAmount.toString(),
            collections: collections.map((c) => ({
                id: c.id,
                receiptNumber: c.receiptNumber,
                collectedAmount: c.collectedAmount.toString(),
                collectedAt: c.collectedAt,
                loanId: c.payment.loan.id,
                loanNumber: c.payment.loan.loanNumber,
                emiId: c.payment.emi.id,
                installmentNo: c.payment.emi.installmentNo,
                reconciled: c.reconciled,
                reconciledAt: c.reconciledAt,
                notes: c.notes,
            })),
            disclaimer:
                "Recorded cash summary for end-of-day reconciliation. Physical cash verification and reconciliation handover requires administrator confirmation.",
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({
                success: false,
                message: error.message,
            });
        }
        console.error("Agent cash reconciliation error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch cash reconciliation summary",
        });
    }
});

module.exports = router;