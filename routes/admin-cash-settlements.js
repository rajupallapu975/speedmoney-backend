const crypto = require("crypto");
const express = require("express");
const { Prisma } = require("@prisma/client");

const prisma = require("../lib/prisma");
const { authenticateToken } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");
const { getBusinessDayRange, parseDateRange, isValidDateString } = require("../lib/date-utils");

const router = express.Router();

// All settlement endpoints require an authenticated administrator
router.use(authenticateToken, authorizeRoles("ADMIN"));

/**
 * Helper to generate a unique settlement reference: STL-YYYYMMDD-XXXXXX
 */
function generateSettlementReference(dateStr) {
    const cleanDate = dateStr.replace(/[^0-9]/g, "").slice(0, 8);
    const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
    return `STL-${cleanDate}-${rand}`;
}

/**
 * Validates actual counted/deposited money amount.
 * Accepts zero or positive values with at most 2 decimal places.
 */
function parseAndValidateCountAmount(value) {
    if (value === undefined || value === null || value === "") {
        throw new Error("actualAmount is required");
    }
    const str = String(value).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(str)) {
        throw new Error(
            "actualAmount must be a finite non-negative number with at most 2 decimal places"
        );
    }
    const dec = new Prisma.Decimal(str);
    if (dec.lt(0)) {
        throw new Error("actualAmount cannot be negative");
    }
    return dec;
}

// =========================================================================
// ENDPOINT G — Settlement Report (must be registered before /:id)
// =========================================================================

/**
 * GET /api/admin/cash-settlements/report
 * 
 * Aggregated report across cash settlements and collections.
 */
router.get("/report", async (req, res) => {
    try {
        const { startDate, endDate, agentId } = req.query;
        let dateFilter = {};

        if (startDate || endDate) {
            try {
                const { start, end } = parseDateRange(startDate, endDate);
                if (start) dateFilter.gte = start;
                if (end) dateFilter.lt = end;
            } catch (err) {
                return res.status(400).json({
                    success: false,
                    message: err.message,
                });
            }
        }

        // Collection level queries
        const collectionWhere = {
            payment: {
                status: "SUCCESS",
                mode: "CASH",
            },
            ...(Object.keys(dateFilter).length > 0 ? { collectedAt: dateFilter } : {}),
            ...(agentId ? { agentId: String(agentId).trim() } : {}),
        };

        const settlementWhere = {
            ...(Object.keys(dateFilter).length > 0 ? { businessDate: dateFilter } : {}),
            ...(agentId ? { agentId: String(agentId).trim() } : {}),
        };

        const [
            allCashCollections,
            reconciledCashCollections,
            settlementsSummary,
            reconciledSettlementsCount,
            discrepancySettlementsCount,
            settlementsList,
        ] = await Promise.all([
            // Total recorded cash collections
            prisma.cashCollection.aggregate({
                where: collectionWhere,
                _sum: { collectedAmount: true },
                _count: { _all: true },
            }),
            // Reconciled cash collections
            prisma.cashCollection.aggregate({
                where: { ...collectionWhere, reconciled: true },
                _sum: { collectedAmount: true },
                _count: { _all: true },
            }),
            // Settlements totals
            prisma.cashSettlement.aggregate({
                where: settlementWhere,
                _sum: {
                    expectedAmount: true,
                    actualAmount: true,
                    discrepancyAmount: true,
                },
                _count: { _all: true },
            }),
            prisma.cashSettlement.count({
                where: { ...settlementWhere, status: "RECONCILED" },
            }),
            prisma.cashSettlement.count({
                where: { ...settlementWhere, status: "DISCREPANCY" },
            }),
            prisma.cashSettlement.findMany({
                where: settlementWhere,
                include: {
                    agent: {
                        select: {
                            id: true,
                            employeeCode: true,
                            user: { select: { name: true } },
                        },
                    },
                },
                orderBy: [{ businessDate: "desc" }, { createdAt: "desc" }],
                take: 100,
            }),
        ]);

        const totalRecordedCash = allCashCollections._sum.collectedAmount || new Prisma.Decimal(0);
        const reconciledCash = reconciledCashCollections._sum.collectedAmount || new Prisma.Decimal(0);
        const unreconciledCash = totalRecordedCash.minus(reconciledCash);

        // Per-agent breakdown
        const agentMap = {};
        for (const s of settlementsList) {
            const key = s.agentId || "UNASSIGNED";
            if (!agentMap[key]) {
                agentMap[key] = {
                    agentId: s.agentId,
                    employeeCode: s.agent?.employeeCode || "ALL_AGENTS",
                    name: s.agent?.user?.name || "General / Multi-Agent",
                    settlementCount: 0,
                    expectedAmount: new Prisma.Decimal(0),
                    actualAmount: new Prisma.Decimal(0),
                    discrepancyAmount: new Prisma.Decimal(0),
                    reconciledCount: 0,
                    discrepancyCount: 0,
                };
            }
            agentMap[key].settlementCount++;
            agentMap[key].expectedAmount = agentMap[key].expectedAmount.plus(s.expectedAmount);
            if (s.actualAmount) {
                agentMap[key].actualAmount = agentMap[key].actualAmount.plus(s.actualAmount);
            }
            if (s.discrepancyAmount) {
                agentMap[key].discrepancyAmount = agentMap[key].discrepancyAmount.plus(s.discrepancyAmount);
            }
            if (s.status === "RECONCILED") agentMap[key].reconciledCount++;
            if (s.status === "DISCREPANCY") agentMap[key].discrepancyCount++;
        }

        const agentBreakdown = Object.values(agentMap).map((a) => ({
            agentId: a.agentId,
            employeeCode: a.employeeCode,
            name: a.name,
            settlementCount: a.settlementCount,
            expectedAmount: a.expectedAmount.toString(),
            actualAmount: a.actualAmount.toString(),
            discrepancyAmount: a.discrepancyAmount.toString(),
            reconciledCount: a.reconciledCount,
            discrepancyCount: a.discrepancyCount,
        }));

        return res.json({
            success: true,
            report: {
                totalRecordedCashCollections: totalRecordedCash.toString(),
                totalReceiptsCount: allCashCollections._count._all || 0,
                totalReconciledCash: reconciledCash.toString(),
                totalUnreconciledCash: unreconciledCash.toString(),
                settlements: {
                    totalSettlements: settlementsSummary._count._all || 0,
                    reconciledSettlementsCount,
                    discrepancySettlementsCount,
                    totalExpectedAmount: (settlementsSummary._sum.expectedAmount || new Prisma.Decimal(0)).toString(),
                    totalActualCountedAmount: (settlementsSummary._sum.actualAmount || new Prisma.Decimal(0)).toString(),
                    totalDiscrepancyAmount: (settlementsSummary._sum.discrepancyAmount || new Prisma.Decimal(0)).toString(),
                },
                agentBreakdown,
                recentSettlementReferences: settlementsList.map((s) => ({
                    id: s.id,
                    reference: s.settlementReference,
                    businessDate: s.businessDate,
                    status: s.status,
                    expectedAmount: s.expectedAmount.toString(),
                    actualAmount: s.actualAmount ? s.actualAmount.toString() : null,
                    discrepancyAmount: s.discrepancyAmount ? s.discrepancyAmount.toString() : null,
                })),
            },
        });
    } catch (error) {
        console.error("Settlement report error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to generate settlements report",
        });
    }
});

// =========================================================================
// ENDPOINT A — Create a Settlement (POST /api/admin/cash-settlements)
// =========================================================================

/**
 * POST /api/admin/cash-settlements
 * 
 * Create a draft settlement for a business date and optional agent.
 */
router.post("/", async (req, res) => {
    try {
        const { date, agentId, collectionIds, notes } = req.body;

        // 1. Validate date
        if (!date) {
            return res.status(400).json({
                success: false,
                message: "date is required in YYYY-MM-DD format",
            });
        }

        let dayRange;
        try {
            dayRange = getBusinessDayRange(date);
        } catch (dateErr) {
            return res.status(400).json({
                success: false,
                message: dateErr.message,
            });
        }

        // 2. Validate agentId if supplied
        let targetAgent = null;
        if (agentId) {
            targetAgent = await prisma.agentProfile.findUnique({
                where: { id: String(agentId).trim() },
                include: { user: true },
            });
            if (!targetAgent) {
                return res.status(404).json({
                    success: false,
                    message: `Agent with ID '${agentId}' not found`,
                });
            }
        }

        // 3. Find candidate collections
        let candidateCollections = [];

        if (collectionIds && Array.isArray(collectionIds)) {
            if (collectionIds.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "collectionIds array cannot be empty",
                });
            }

            // Check duplicate IDs in input array
            const uniqueSet = new Set(collectionIds);
            if (uniqueSet.size !== collectionIds.length) {
                return res.status(400).json({
                    success: false,
                    message: "Duplicate collection IDs provided in request",
                });
            }

            candidateCollections = await prisma.cashCollection.findMany({
                where: {
                    id: { in: collectionIds },
                },
                include: {
                    payment: true,
                    settlementItems: {
                        include: { settlement: true },
                    },
                },
            });

            if (candidateCollections.length !== collectionIds.length) {
                return res.status(400).json({
                    success: false,
                    message: "One or more specified collection IDs do not exist",
                });
            }

            // Validate eligibility of each specified collection
            for (const col of candidateCollections) {
                if (col.payment.mode !== "CASH" || col.payment.status !== "SUCCESS") {
                    return res.status(400).json({
                        success: false,
                        message: `Collection '${col.receiptNumber}' is not a successful CASH collection`,
                    });
                }
                if (targetAgent && col.agentId !== targetAgent.id) {
                    return res.status(400).json({
                        success: false,
                        message: `Collection '${col.receiptNumber}' belongs to agent '${col.agentId}', not specified agent '${targetAgent.id}'`,
                    });
                }
                if (col.reconciled) {
                    return res.status(400).json({
                        success: false,
                        message: `Collection '${col.receiptNumber}' is already reconciled`,
                    });
                }
                const activeSettlementItem = col.settlementItems.find(
                    (si) => si.settlement && si.settlement.status !== "CANCELLED"
                );
                if (activeSettlementItem) {
                    return res.status(400).json({
                        success: false,
                        message: `Collection '${col.receiptNumber}' is already assigned to active settlement '${activeSettlementItem.settlement.settlementReference}'`,
                    });
                }
            }
        } else {
            // Automatically discover eligible collections for that date/agent
            candidateCollections = await prisma.cashCollection.findMany({
                where: {
                    reconciled: false,
                    collectedAt: {
                        gte: dayRange.startOfDay,
                        lt: dayRange.endOfDay,
                    },
                    payment: {
                        status: "SUCCESS",
                        mode: "CASH",
                    },
                    ...(targetAgent ? { agentId: targetAgent.id } : {}),
                    settlementItems: {
                        none: {
                            settlement: {
                                status: { not: "CANCELLED" },
                            },
                        },
                    },
                },
                include: {
                    payment: true,
                },
            });
        }

        if (candidateCollections.length === 0) {
            return res.status(400).json({
                success: false,
                message: "No eligible unassigned cash collections found for the specified date and agent",
            });
        }

        // 4. Calculate expected amount
        let expectedAmount = new Prisma.Decimal(0);
        for (const col of candidateCollections) {
            expectedAmount = expectedAmount.plus(col.collectedAmount);
        }

        // 5. Generate settlement reference
        const settlementReference = generateSettlementReference(dayRange.businessDate);

        // 6. Execute atomic creation inside a transaction
        const result = await prisma.$transaction(async (tx) => {
            const settlement = await tx.cashSettlement.create({
                data: {
                    settlementReference,
                    businessDate: dayRange.startOfDay,
                    agentId: targetAgent ? targetAgent.id : null,
                    expectedAmount,
                    status: "DRAFT",
                    notes: notes && typeof notes === "string" ? notes.trim() : null,
                    createdById: req.user.userId,
                },
            });

            // Create items
            const itemData = candidateCollections.map((col) => ({
                settlementId: settlement.id,
                cashCollectionId: col.id,
                recordedAmount: col.collectedAmount,
                status: "INCLUDED",
            }));

            await tx.cashSettlementItem.createMany({
                data: itemData,
            });

            // Audit log
            await tx.auditLog.create({
                data: {
                    userId: req.user.userId,
                    action: "CREATE",
                    entity: "CashSettlement",
                    entityId: settlement.id,
                    description: `Cash settlement ${settlementReference} created for date ${dayRange.businessDate} with ${candidateCollections.length} collections totaling ₹${expectedAmount.toFixed(2)}`,
                    metadata: {
                        settlementReference,
                        businessDate: dayRange.businessDate,
                        agentId: targetAgent ? targetAgent.id : null,
                        collectionsCount: candidateCollections.length,
                        expectedAmount: expectedAmount.toFixed(2),
                    },
                },
            });

            return settlement;
        });

        return res.status(201).json({
            success: true,
            message: "Cash settlement draft created successfully",
            settlement: {
                id: result.id,
                settlementReference: result.settlementReference,
                businessDate: dayRange.businessDate,
                agentId: result.agentId,
                expectedAmount: result.expectedAmount.toString(),
                actualAmount: null,
                discrepancyAmount: null,
                status: result.status,
                collectionsCount: candidateCollections.length,
                notes: result.notes,
                createdAt: result.createdAt,
            },
        });
    } catch (error) {
        console.error("Create settlement error:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to create cash settlement",
        });
    }
});

// =========================================================================
// ENDPOINT C — List Settlements (GET /api/admin/cash-settlements)
// =========================================================================

/**
 * GET /api/admin/cash-settlements
 * 
 * List settlements with filtering, pagination, and totals.
 */
router.get("/", async (req, res) => {
    try {
        let page = parseInt(req.query.page, 10);
        if (isNaN(page) || page < 1) page = 1;

        let limit = parseInt(req.query.limit, 10);
        if (isNaN(limit) || limit < 1) limit = 20;
        if (limit > 100) limit = 100;

        const skip = (page - 1) * limit;

        const where = {};

        // Filters
        const { startDate, endDate, agentId, status, settlementReference } = req.query;

        if (startDate || endDate) {
            try {
                const { start, end } = parseDateRange(startDate, endDate);
                where.businessDate = {};
                if (start) where.businessDate.gte = start;
                if (end) where.businessDate.lt = end;
            } catch (err) {
                return res.status(400).json({
                    success: false,
                    message: err.message,
                });
            }
        }

        if (agentId) {
            where.agentId = String(agentId).trim();
        }

        if (status) {
            const validStatuses = ["DRAFT", "RECONCILED", "DISCREPANCY", "CANCELLED"];
            if (!validStatuses.includes(String(status).toUpperCase())) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid status filter. Allowed: ${validStatuses.join(", ")}`,
                });
            }
            where.status = String(status).toUpperCase();
        }

        if (settlementReference) {
            where.settlementReference = {
                contains: String(settlementReference).trim(),
                mode: "insensitive",
            };
        }

        const [totalRecords, aggResult, settlements] = await Promise.all([
            prisma.cashSettlement.count({ where }),
            prisma.cashSettlement.aggregate({
                where,
                _sum: {
                    expectedAmount: true,
                    actualAmount: true,
                    discrepancyAmount: true,
                },
                _count: { _all: true },
            }),
            prisma.cashSettlement.findMany({
                where,
                include: {
                    agent: {
                        select: {
                            id: true,
                            employeeCode: true,
                            user: {
                                select: {
                                    name: true,
                                    email: true,
                                    phone: true,
                                },
                            },
                        },
                    },
                    createdBy: {
                        select: {
                            id: true,
                            name: true,
                            email: true,
                        },
                    },
                    reconciledBy: {
                        select: {
                            id: true,
                            name: true,
                            email: true,
                        },
                    },
                    _count: {
                        select: { items: true },
                    },
                },
                orderBy: [
                    { businessDate: "desc" },
                    { createdAt: "desc" },
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
                totalExpectedAmount: (aggResult._sum.expectedAmount || new Prisma.Decimal(0)).toString(),
                totalActualAmount: (aggResult._sum.actualAmount || new Prisma.Decimal(0)).toString(),
                totalDiscrepancyAmount: (aggResult._sum.discrepancyAmount || new Prisma.Decimal(0)).toString(),
                settlementsCount: aggResult._count._all || 0,
            },
            settlements: settlements.map((s) => ({
                id: s.id,
                settlementReference: s.settlementReference,
                businessDate: s.businessDate,
                status: s.status,
                expectedAmount: s.expectedAmount.toString(),
                actualAmount: s.actualAmount ? s.actualAmount.toString() : null,
                discrepancyAmount: s.discrepancyAmount ? s.discrepancyAmount.toString() : null,
                itemsCount: s._count.items,
                notes: s.notes,
                discrepancyReason: s.discrepancyReason,
                createdAt: s.createdAt,
                countedAt: s.countedAt,
                reconciledAt: s.reconciledAt,
                agent: s.agent
                    ? {
                          id: s.agent.id,
                          employeeCode: s.agent.employeeCode,
                          name: s.agent.user?.name || "N/A",
                      }
                    : null,
                createdBy: s.createdBy,
                reconciledBy: s.reconciledBy,
            })),
        });
    } catch (error) {
        console.error("List settlements error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch settlements",
        });
    }
});

// =========================================================================
// ENDPOINT B — View Settlement Details (GET /api/admin/cash-settlements/:id)
// =========================================================================

/**
 * GET /api/admin/cash-settlements/:id
 * 
 * Retrieve full settlement details, linked items, and audit logs.
 */
router.get("/:id", async (req, res) => {
    try {
        const { id } = req.params;

        const settlement = await prisma.cashSettlement.findUnique({
            where: { id },
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
                            },
                        },
                    },
                },
                createdBy: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                    },
                },
                reconciledBy: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                    },
                },
                items: {
                    include: {
                        cashCollection: {
                            include: {
                                payment: {
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
                        },
                    },
                    orderBy: [{ recordedAmount: "desc" }, { id: "asc" }],
                },
            },
        });

        if (!settlement) {
            return res.status(404).json({
                success: false,
                message: "Cash settlement not found",
            });
        }

        // Fetch audit trail
        const auditLogs = await prisma.auditLog.findMany({
            where: {
                entity: "CashSettlement",
                entityId: settlement.id,
            },
            include: {
                user: { select: { id: true, name: true, email: true } },
            },
            orderBy: { createdAt: "desc" },
        });

        return res.json({
            success: true,
            settlement: {
                id: settlement.id,
                settlementReference: settlement.settlementReference,
                businessDate: settlement.businessDate,
                status: settlement.status,
                expectedAmount: settlement.expectedAmount.toString(),
                actualAmount: settlement.actualAmount ? settlement.actualAmount.toString() : null,
                discrepancyAmount: settlement.discrepancyAmount
                    ? settlement.discrepancyAmount.toString()
                    : null,
                notes: settlement.notes,
                discrepancyReason: settlement.discrepancyReason,
                createdAt: settlement.createdAt,
                updatedAt: settlement.updatedAt,
                countedAt: settlement.countedAt,
                reconciledAt: settlement.reconciledAt,
                agent: settlement.agent
                    ? {
                          id: settlement.agent.id,
                          employeeCode: settlement.agent.employeeCode,
                          name: settlement.agent.user?.name || "N/A",
                          phone: settlement.agent.user?.phone || null,
                          email: settlement.agent.user?.email || null,
                      }
                    : null,
                createdBy: settlement.createdBy,
                reconciledBy: settlement.reconciledBy,
                itemsCount: settlement.items.length,
                items: settlement.items.map((it) => ({
                    id: it.id,
                    recordedAmount: it.recordedAmount.toString(),
                    status: it.status,
                    discrepancyReason: it.discrepancyReason,
                    collection: {
                        id: it.cashCollection.id,
                        receiptNumber: it.cashCollection.receiptNumber,
                        collectedAmount: it.cashCollection.collectedAmount.toString(),
                        collectedAt: it.cashCollection.collectedAt,
                        reconciled: it.cashCollection.reconciled,
                        reconciledAt: it.cashCollection.reconciledAt,
                        notes: it.cashCollection.notes,
                        loan: {
                            id: it.cashCollection.payment.loan.id,
                            loanNumber: it.cashCollection.payment.loan.loanNumber,
                            status: it.cashCollection.payment.loan.status,
                        },
                        emi: {
                            id: it.cashCollection.payment.emi.id,
                            installmentNo: it.cashCollection.payment.emi.installmentNo,
                            dueDate: it.cashCollection.payment.emi.dueDate,
                            status: it.cashCollection.payment.emi.status,
                        },
                        customer: {
                            name: it.cashCollection.payment.loan.customer?.user?.name || "N/A",
                            phone: it.cashCollection.payment.loan.customer?.user?.phone || null,
                        },
                    },
                })),
                auditLogs: auditLogs.map((log) => ({
                    id: log.id,
                    action: log.action,
                    description: log.description,
                    createdAt: log.createdAt,
                    performedBy: log.user ? { name: log.user.name, email: log.user.email } : null,
                })),
            },
        });
    } catch (error) {
        console.error("View settlement error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch settlement details",
        });
    }
});

// =========================================================================
// ENDPOINT D — Record Cash Count (PATCH /api/admin/cash-settlements/:id/count)
// =========================================================================

/**
 * PATCH /api/admin/cash-settlements/:id/count
 * 
 * Record the actual physical cash amount counted/deposited.
 * Calculates discrepancy server-side.
 */
router.patch("/:id/count", async (req, res) => {
    try {
        const { id } = req.params;
        const { actualAmount, notes } = req.body;

        const parsedActual = parseAndValidateCountAmount(actualAmount);

        const settlement = await prisma.cashSettlement.findUnique({
            where: { id },
        });

        if (!settlement) {
            return res.status(404).json({
                success: false,
                message: "Cash settlement not found",
            });
        }

        if (settlement.status !== "DRAFT" && settlement.status !== "DISCREPANCY") {
            return res.status(400).json({
                success: false,
                message: `Cannot record cash count on settlement with status '${settlement.status}'. Only DRAFT or DISCREPANCY settlements are eligible.`,
            });
        }

        // Server-side calculation of discrepancy: actualAmount - expectedAmount
        const discrepancy = parsedActual.minus(settlement.expectedAmount);
        const newStatus = discrepancy.isZero() ? "DRAFT" : "DISCREPANCY";

        const updatedSettlement = await prisma.$transaction(async (tx) => {
            const updated = await tx.cashSettlement.update({
                where: { id },
                data: {
                    actualAmount: parsedActual,
                    discrepancyAmount: discrepancy,
                    status: newStatus,
                    countedAt: new Date(),
                    ...(notes && typeof notes === "string" ? { notes: notes.trim() } : {}),
                },
            });

            await tx.auditLog.create({
                data: {
                    userId: req.user.userId,
                    action: "UPDATE",
                    entity: "CashSettlement",
                    entityId: settlement.id,
                    description: `Cash count recorded for settlement ${settlement.settlementReference}: Expected ₹${settlement.expectedAmount.toFixed(2)}, Actual ₹${parsedActual.toFixed(2)}, Discrepancy ₹${discrepancy.toFixed(2)}`,
                    metadata: {
                        settlementReference: settlement.settlementReference,
                        expectedAmount: settlement.expectedAmount.toFixed(2),
                        actualAmount: parsedActual.toFixed(2),
                        discrepancyAmount: discrepancy.toFixed(2),
                        status: newStatus,
                    },
                },
            });

            return updated;
        });

        return res.json({
            success: true,
            message: "Actual cash count recorded successfully",
            settlement: {
                id: updatedSettlement.id,
                settlementReference: updatedSettlement.settlementReference,
                expectedAmount: updatedSettlement.expectedAmount.toString(),
                actualAmount: updatedSettlement.actualAmount.toString(),
                discrepancyAmount: updatedSettlement.discrepancyAmount.toString(),
                status: updatedSettlement.status,
                countedAt: updatedSettlement.countedAt,
            },
        });
    } catch (error) {
        console.error("Record cash count error:", error);
        return res.status(400).json({
            success: false,
            message: error.message || "Failed to record cash count",
        });
    }
});

// =========================================================================
// ENDPOINT F — Flag Discrepancy (POST /api/admin/cash-settlements/:id/discrepancy)
// =========================================================================

/**
 * POST /api/admin/cash-settlements/:id/discrepancy
 * 
 * Flag a discrepancy with an explicit reason and optional item flags.
 */
router.post("/:id/discrepancy", async (req, res) => {
    try {
        const { id } = req.params;
        const { reason, notes, itemDiscrepancies } = req.body;

        if (!reason || typeof reason !== "string" || !reason.trim()) {
            return res.status(400).json({
                success: false,
                message: "Discrepancy reason is required",
            });
        }

        const settlement = await prisma.cashSettlement.findUnique({
            where: { id },
        });

        if (!settlement) {
            return res.status(404).json({
                success: false,
                message: "Cash settlement not found",
            });
        }

        if (settlement.status === "RECONCILED" || settlement.status === "CANCELLED") {
            return res.status(400).json({
                success: false,
                message: `Cannot flag discrepancy on a settlement with status '${settlement.status}'`,
            });
        }

        const updatedSettlement = await prisma.$transaction(async (tx) => {
            const updated = await tx.cashSettlement.update({
                where: { id },
                data: {
                    status: "DISCREPANCY",
                    discrepancyReason: reason.trim(),
                    ...(notes && typeof notes === "string" ? { notes: notes.trim() } : {}),
                },
            });

            // If item-level discrepancies are provided
            if (itemDiscrepancies && Array.isArray(itemDiscrepancies)) {
                for (const item of itemDiscrepancies) {
                    if (item.cashCollectionId && item.reason) {
                        await tx.cashSettlementItem.updateMany({
                            where: {
                                settlementId: settlement.id,
                                cashCollectionId: String(item.cashCollectionId).trim(),
                            },
                            data: {
                                status: "DISCREPANCY",
                                discrepancyReason: String(item.reason).trim(),
                            },
                        });
                    }
                }
            }

            await tx.auditLog.create({
                data: {
                    userId: req.user.userId,
                    action: "UPDATE",
                    entity: "CashSettlement",
                    entityId: settlement.id,
                    description: `Discrepancy flagged on settlement ${settlement.settlementReference}: ${reason.trim()}`,
                    metadata: {
                        settlementReference: settlement.settlementReference,
                        reason: reason.trim(),
                    },
                },
            });

            return updated;
        });

        return res.json({
            success: true,
            message: "Settlement discrepancy flagged successfully",
            settlement: {
                id: updatedSettlement.id,
                settlementReference: updatedSettlement.settlementReference,
                status: updatedSettlement.status,
                discrepancyReason: updatedSettlement.discrepancyReason,
            },
        });
    } catch (error) {
        console.error("Flag discrepancy error:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to flag discrepancy",
        });
    }
});

// =========================================================================
// ENDPOINT E — Reconcile Settlement (POST /api/admin/cash-settlements/:id/reconcile)
// =========================================================================

/**
 * POST /api/admin/cash-settlements/:id/reconcile
 * 
 * Reconcile a settlement and all linked cash collections atomically.
 * Requires actual count recorded, zero discrepancy, and un-reconciled items.
 */
router.post("/:id/reconcile", async (req, res) => {
    try {
        const { id } = req.params;

        const settlement = await prisma.cashSettlement.findUnique({
            where: { id },
            include: {
                items: true,
            },
        });

        if (!settlement) {
            return res.status(404).json({
                success: false,
                message: "Cash settlement not found",
            });
        }

        // Check status
        if (settlement.status === "RECONCILED") {
            return res.status(400).json({
                success: false,
                message: "This settlement has already been reconciled",
            });
        }

        if (settlement.status !== "DRAFT") {
            return res.status(400).json({
                success: false,
                message: `Settlement status is '${settlement.status}'. Only balanced DRAFT settlements can be reconciled.`,
            });
        }

        // Must have recorded actual amount
        if (settlement.actualAmount === null || settlement.actualAmount === undefined) {
            return res.status(400).json({
                success: false,
                message: "Actual cash count has not been recorded for this settlement. Record cash count before reconciling.",
            });
        }

        // Must have zero discrepancy
        if (!settlement.discrepancyAmount || !settlement.discrepancyAmount.isZero()) {
            return res.status(400).json({
                success: false,
                message: `Cannot reconcile settlement with an unresolved discrepancy of ₹${settlement.discrepancyAmount ? settlement.discrepancyAmount.toString() : "unknown"}. Resolve the discrepancy before reconciling.`,
            });
        }

        // Reject empty settlements
        if (settlement.items.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Cannot reconcile an empty settlement with no collections",
            });
        }

        const collectionIds = settlement.items.map((it) => it.cashCollectionId);

        // Verify none of the linked collections are already reconciled
        const alreadyReconciled = await prisma.cashCollection.findMany({
            where: {
                id: { in: collectionIds },
                reconciled: true,
            },
            select: { receiptNumber: true },
        });

        if (alreadyReconciled.length > 0) {
            const receipts = alreadyReconciled.map((r) => r.receiptNumber).join(", ");
            return res.status(400).json({
                success: false,
                message: `Collections already reconciled elsewhere: ${receipts}`,
            });
        }

        const now = new Date();

        // Perform atomic reconciliation inside a database transaction
        const result = await prisma.$transaction(
            async (tx) => {
                // Double check settlement status within lock/transaction
                const current = await tx.cashSettlement.findUnique({
                    where: { id },
                });
                if (current.status === "RECONCILED") {
                    throw new Error("Settlement has already been reconciled by another request");
                }

                // 1. Update settlement
                const updatedSettlement = await tx.cashSettlement.update({
                    where: { id },
                    data: {
                        status: "RECONCILED",
                        reconciledById: req.user.userId,
                        reconciledAt: now,
                    },
                });

                // 2. Update settlement items
                await tx.cashSettlementItem.updateMany({
                    where: { settlementId: id },
                    data: {
                        status: "RECONCILED",
                    },
                });

                // 3. Update all linked collections
                await tx.cashCollection.updateMany({
                    where: { id: { in: collectionIds } },
                    data: {
                        reconciled: true,
                        reconciledAt: now,
                    },
                });

                // 4. Create Audit Log
                await tx.auditLog.create({
                    data: {
                        userId: req.user.userId,
                        action: "VERIFY",
                        entity: "CashSettlement",
                        entityId: settlement.id,
                        description: `Settlement ${settlement.settlementReference} reconciled successfully: ${settlement.items.length} cash collections totaling ₹${settlement.actualAmount.toFixed(2)} marked reconciled`,
                        metadata: {
                            settlementReference: settlement.settlementReference,
                            reconciledCollectionsCount: settlement.items.length,
                            actualAmount: settlement.actualAmount.toFixed(2),
                            reconciledAt: now,
                        },
                    },
                });

                return updatedSettlement;
            },
            { isolationLevel: "Serializable" }
        );

        return res.json({
            success: true,
            message: "Cash settlement reconciled successfully",
            settlementReference: result.settlementReference,
            expectedAmount: result.expectedAmount.toString(),
            actualAmount: result.actualAmount.toString(),
            discrepancyAmount: "0",
            reconciledCollectionsCount: settlement.items.length,
            status: result.status,
            reconciledAt: result.reconciledAt,
        });
    } catch (error) {
        console.error("Reconcile settlement error:", error);
        return res.status(400).json({
            success: false,
            message: error.message || "Failed to reconcile cash settlement",
        });
    }
});

module.exports = router;
