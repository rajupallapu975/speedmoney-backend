const express = require("express");
const { Prisma } = require("@prisma/client");

const prisma = require("../lib/prisma");
const { authenticateToken } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");
const {
    getBusinessDayRange,
    parseDateRange,
    getTodayIST,
    isValidDateString,
} = require("../lib/date-utils");

const router = express.Router();

// All reporting endpoints require an authenticated administrator
router.use(authenticateToken, authorizeRoles("ADMIN"));

/**
 * Helper to escape and sanitize values for CSV output.
 * Protects against spreadsheet formula injection (=, +, -, @, \t, \r).
 */
function sanitizeCsvValue(val) {
    if (val === null || val === undefined) return '""';
    let str = String(val);

    // Prevent formula injection in spreadsheet applications
    if (/^[=+\-@\t\r]/.test(str)) {
        str = "'" + str;
    }

    // Escape double quotes
    str = str.replace(/"/g, '""');
    return `"${str}"`;
}

// =========================================================================
// PHASE 2 — FINANCIAL PORTFOLIO SUMMARY
// GET /api/admin/financial-reports/overview
// =========================================================================

router.get("/overview", async (req, res) => {
    try {
        const todayIST = getTodayIST();
        const todayRange = getBusinessDayRange(todayIST);

        const [
            // 1. Loan portfolio counts
            totalLoans,
            pendingDisbursementLoans,
            activeLoans,
            completedLoans,
            overdueLoans,
            defaultedLoans,
            closedLoans,

            // 2. Principal & repayment totals
            principalAgg,
            pendingPrincipalAgg,
            scheduledRepaymentsAgg,

            // 3. Outstanding & overdue EMI balances
            outstandingEmiAgg,
            overdueEmiAgg,

            // 4. Online payments
            onlinePaymentsAgg,

            // 5. Cash collections
            cashCollectionsAgg,
            reconciledCashAgg,
            unreconciledCashAgg,

            // 6. Settlements
            discrepancySettlementsCount,
            reconciledSettlementsCount,
        ] = await Promise.all([
            prisma.loan.count(),
            prisma.loan.count({ where: { status: "PENDING_DISBURSEMENT" } }),
            prisma.loan.count({ where: { status: "ACTIVE" } }),
            prisma.loan.count({ where: { status: "COMPLETED" } }),
            prisma.loan.count({ where: { status: "OVERDUE" } }),
            prisma.loan.count({ where: { status: "DEFAULTED" } }),
            prisma.loan.count({ where: { status: "CLOSED" } }),

            // Total principal disbursed on created loans (excludes PENDING_DISBURSEMENT)
            prisma.loan.aggregate({
                where: { status: { in: ["ACTIVE", "COMPLETED", "OVERDUE", "DEFAULTED"] } },
                _sum: { principalAmount: true },
            }),

            // Total principal committed but pending disbursement
            prisma.loan.aggregate({
                where: { status: "PENDING_DISBURSEMENT" },
                _sum: { principalAmount: true },
            }),

            // Total scheduled repayments across active/completed/overdue/defaulted loans
            prisma.loan.aggregate({
                where: { status: { in: ["ACTIVE", "COMPLETED", "OVERDUE", "DEFAULTED"] } },
                _sum: { totalPayable: true },
            }),

            // Total outstanding balance across all unpaid, non-waived EMIs
            prisma.emiSchedule.aggregate({
                where: {
                    status: { in: ["PENDING", "PARTIAL", "OVERDUE"] },
                    outstandingAmount: { gt: 0 },
                },
                _sum: { outstandingAmount: true },
            }),

            // Overdue EMI amount (due before today in IST, non-waived, outstanding > 0)
            prisma.emiSchedule.aggregate({
                where: {
                    dueDate: { lt: todayRange.startOfDay },
                    status: { in: ["PENDING", "PARTIAL", "OVERDUE"] },
                    outstandingAmount: { gt: 0 },
                },
                _sum: { outstandingAmount: true },
            }),

            // Successful ONLINE payments
            prisma.payment.aggregate({
                where: { mode: "ONLINE", status: "SUCCESS" },
                _sum: { amount: true },
                _count: { _all: true },
            }),

            // Successful physical CASH collections
            prisma.cashCollection.aggregate({
                where: { payment: { status: "SUCCESS", mode: "CASH" } },
                _sum: { collectedAmount: true },
                _count: { _all: true },
            }),

            // Reconciled CASH collections
            prisma.cashCollection.aggregate({
                where: { reconciled: true, payment: { status: "SUCCESS", mode: "CASH" } },
                _sum: { collectedAmount: true },
                _count: { _all: true },
            }),

            // Unreconciled CASH collections
            prisma.cashCollection.aggregate({
                where: { reconciled: false, payment: { status: "SUCCESS", mode: "CASH" } },
                _sum: { collectedAmount: true },
                _count: { _all: true },
            }),

            // Settlements with unresolved discrepancies
            prisma.cashSettlement.count({
                where: { status: "DISCREPANCY" },
            }),

            // Reconciled settlements
            prisma.cashSettlement.count({
                where: { status: "RECONCILED" },
            }),
        ]);

        return res.json({
            success: true,
            generatedAt: new Date().toISOString(),
            businessDate: todayIST,
            portfolio: {
                totalLoans,
                statusCounts: {
                    PENDING_DISBURSEMENT: pendingDisbursementLoans,
                    ACTIVE: activeLoans,
                    COMPLETED: completedLoans,
                    OVERDUE: overdueLoans,
                    DEFAULTED: defaultedLoans,
                    CLOSED: closedLoans,
                },
                totalPrincipalDisbursed: (principalAgg._sum.principalAmount || new Prisma.Decimal(0)).toString(),
                totalPrincipalPendingDisbursement: (pendingPrincipalAgg._sum.principalAmount || new Prisma.Decimal(0)).toString(),
                totalScheduledRepayments: (scheduledRepaymentsAgg._sum.totalPayable || new Prisma.Decimal(0)).toString(),
                totalOutstandingEmiAmount: (outstandingEmiAgg._sum.outstandingAmount || new Prisma.Decimal(0)).toString(),
                totalOverdueEmiAmount: (overdueEmiAgg._sum.outstandingAmount || new Prisma.Decimal(0)).toString(),
            },
            collections: {
                online: {
                    totalAmount: (onlinePaymentsAgg._sum.amount || new Prisma.Decimal(0)).toString(),
                    count: onlinePaymentsAgg._count._all || 0,
                },
                cash: {
                    totalAmount: (cashCollectionsAgg._sum.collectedAmount || new Prisma.Decimal(0)).toString(),
                    count: cashCollectionsAgg._count._all || 0,
                    reconciledAmount: (reconciledCashAgg._sum.collectedAmount || new Prisma.Decimal(0)).toString(),
                    reconciledCount: reconciledCashAgg._count._all || 0,
                    unreconciledAmount: (unreconciledCashAgg._sum.collectedAmount || new Prisma.Decimal(0)).toString(),
                    unreconciledCount: unreconciledCashAgg._count._all || 0,
                },
            },
            settlements: {
                unresolvedDiscrepancyCount: discrepancySettlementsCount,
                reconciledCount: reconciledSettlementsCount,
            },
        });
    } catch (error) {
        console.error("Financial overview error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to generate financial portfolio overview",
        });
    }
});

// =========================================================================
// PHASE 3 — LOAN PORTFOLIO PERFORMANCE REPORT
// GET /api/admin/financial-reports/loan-portfolio
// =========================================================================

router.get("/loan-portfolio", async (req, res) => {
    try {
        let page = parseInt(req.query.page, 10);
        if (isNaN(page) || page < 1) page = 1;

        let limit = parseInt(req.query.limit, 10);
        if (isNaN(limit) || limit < 1) limit = 20;
        if (limit > 100) limit = 100;

        const skip = (page - 1) * limit;

        const where = {};

        // Date range filter on loan creation date
        const { startDate, endDate, productId, status } = req.query;

        if (startDate || endDate) {
            try {
                const { start, end } = parseDateRange(startDate, endDate);
                where.createdAt = {};
                if (start) where.createdAt.gte = start;
                if (end) where.createdAt.lt = end;
            } catch (err) {
                return res.status(400).json({
                    success: false,
                    message: err.message,
                });
            }
        }

        if (status) {
            const validStatuses = ["PENDING_DISBURSEMENT", "ACTIVE", "COMPLETED", "OVERDUE", "DEFAULTED", "CLOSED"];
            if (!validStatuses.includes(String(status).toUpperCase())) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid loan status. Allowed: ${validStatuses.join(", ")}`,
                });
            }
            where.status = String(status).toUpperCase();
        }

        if (productId) {
            where.application = {
                productId: String(productId).trim(),
            };
        }

        const todayIST = getTodayIST();
        const todayRange = getBusinessDayRange(todayIST);

        const [totalLoansCount, loansAgg, loansList, productsList] = await Promise.all([
            prisma.loan.count({ where }),
            prisma.loan.aggregate({
                where,
                _sum: {
                    principalAmount: true,
                    totalPayable: true,
                    outstandingAmount: true,
                },
            }),
            prisma.loan.findMany({
                where,
                include: {
                    customer: {
                        include: {
                            user: {
                                select: { name: true, phone: true },
                            },
                        },
                    },
                    application: {
                        include: {
                            product: {
                                select: { id: true, name: true },
                            },
                        },
                    },
                    emis: {
                        select: {
                            id: true,
                            installmentNo: true,
                            dueDate: true,
                            emiAmount: true,
                            paidAmount: true,
                            outstandingAmount: true,
                            status: true,
                        },
                        orderBy: { installmentNo: "asc" },
                    },
                },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                skip,
                take: limit,
            }),
            prisma.loanProduct.findMany({
                select: { id: true, name: true },
            }),
        ]);

        // Calculate product-level breakdowns
        const productStatsMap = {};
        for (const p of productsList) {
            productStatsMap[p.id] = {
                productId: p.id,
                productName: p.name,
                loanCount: 0,
                principalAmount: new Prisma.Decimal(0),
                totalPayable: new Prisma.Decimal(0),
                outstandingAmount: new Prisma.Decimal(0),
                repaidAmount: new Prisma.Decimal(0),
                overdueAmount: new Prisma.Decimal(0),
                overdueEmisCount: 0,
            };
        }

        const formattedLoans = loansList.map((loan) => {
            let totalPaid = new Prisma.Decimal(0);
            let overdueAmt = new Prisma.Decimal(0);
            let overdueCount = 0;
            let paidCount = 0;

            for (const emi of loan.emis) {
                totalPaid = totalPaid.plus(emi.paidAmount);
                if (emi.status === "PAID") {
                    paidCount++;
                } else if (
                    emi.dueDate < todayRange.startOfDay &&
                    ["PENDING", "PARTIAL", "OVERDUE"].includes(emi.status) &&
                    Number(emi.outstandingAmount) > 0
                ) {
                    overdueAmt = overdueAmt.plus(emi.outstandingAmount);
                    overdueCount++;
                }
            }

            // Accumulate to product stats if product matched
            const pId = loan.application?.product?.id;
            if (pId && productStatsMap[pId]) {
                productStatsMap[pId].loanCount++;
                productStatsMap[pId].principalAmount = productStatsMap[pId].principalAmount.plus(loan.principalAmount);
                productStatsMap[pId].totalPayable = productStatsMap[pId].totalPayable.plus(loan.totalPayable);
                productStatsMap[pId].outstandingAmount = productStatsMap[pId].outstandingAmount.plus(loan.outstandingAmount);
                productStatsMap[pId].repaidAmount = productStatsMap[pId].repaidAmount.plus(totalPaid);
                productStatsMap[pId].overdueAmount = productStatsMap[pId].overdueAmount.plus(overdueAmt);
                productStatsMap[pId].overdueEmisCount += overdueCount;
            }

            return {
                id: loan.id,
                loanNumber: loan.loanNumber,
                status: loan.status,
                principalAmount: loan.principalAmount.toString(),
                totalPayable: loan.totalPayable.toString(),
                outstandingAmount: loan.outstandingAmount.toString(),
                totalRepaidAmount: totalPaid.toString(),
                overdueAmount: overdueAmt.toString(),
                startDate: loan.startDate,
                endDate: loan.endDate,
                createdAt: loan.createdAt,
                product: loan.application?.product || null,
                customer: {
                    name: loan.customer?.user?.name || "N/A",
                    phone: loan.customer?.user?.phone || null,
                },
                emisSummary: {
                    totalEmis: loan.emis.length,
                    paidEmis: paidCount,
                    overdueEmis: overdueCount,
                },
            };
        });

        const byProduct = Object.values(productStatsMap)
            .filter((p) => p.loanCount > 0 || !productId)
            .map((p) => ({
                productId: p.productId,
                productName: p.productName,
                loanCount: p.loanCount,
                principalAmount: p.principalAmount.toString(),
                totalPayable: p.totalPayable.toString(),
                outstandingAmount: p.outstandingAmount.toString(),
                repaidAmount: p.repaidAmount.toString(),
                overdueAmount: p.overdueAmount.toString(),
                overdueEmisCount: p.overdueEmisCount,
            }));

        const totalPages = Math.ceil(totalLoansCount / limit) || 1;

        return res.json({
            success: true,
            pagination: {
                page,
                limit,
                totalRecords: totalLoansCount,
                totalPages,
            },
            summary: {
                totalLoans: totalLoansCount,
                totalPrincipalAmount: (loansAgg._sum.principalAmount || new Prisma.Decimal(0)).toString(),
                totalScheduledRepayments: (loansAgg._sum.totalPayable || new Prisma.Decimal(0)).toString(),
                totalOutstandingAmount: (loansAgg._sum.outstandingAmount || new Prisma.Decimal(0)).toString(),
            },
            byProduct,
            loans: formattedLoans,
        });
    } catch (error) {
        console.error("Loan portfolio report error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to generate loan portfolio report",
        });
    }
});

// =========================================================================
// PHASE 4 — DELINQUENCY AGEING REPORT
// GET /api/admin/financial-reports/delinquency
// =========================================================================

router.get("/delinquency", async (req, res) => {
    try {
        const { asOfDate, productId } = req.query;

        let asOfMidnight;
        let businessDateStr;

        if (asOfDate) {
            try {
                const dayRange = getBusinessDayRange(asOfDate);
                asOfMidnight = dayRange.startOfDay;
                businessDateStr = dayRange.businessDate;
            } catch (err) {
                return res.status(400).json({
                    success: false,
                    message: err.message,
                });
            }
        } else {
            businessDateStr = getTodayIST();
            asOfMidnight = getBusinessDayRange(businessDateStr).startOfDay;
        }

        // Fetch unpaid, non-waived EMIs with dueDate < asOfMidnight and outstandingAmount > 0
        const overdueEmis = await prisma.emiSchedule.findMany({
            where: {
                dueDate: { lt: asOfMidnight },
                status: { in: ["PENDING", "PARTIAL", "OVERDUE"] },
                outstandingAmount: { gt: 0 },
                loan: {
                    status: { in: ["ACTIVE", "OVERDUE", "DEFAULTED"] },
                    ...(productId ? { application: { productId: String(productId).trim() } } : {}),
                },
            },
            select: {
                id: true,
                loanId: true,
                installmentNo: true,
                dueDate: true,
                outstandingAmount: true,
                loan: {
                    select: {
                        id: true,
                        loanNumber: true,
                    },
                },
            },
        });

        // 4 mutually exclusive ageing bands
        const band1 = { name: "1-30 days", minDays: 1, maxDays: 30, count: 0, loanIds: new Set(), amount: new Prisma.Decimal(0) };
        const band2 = { name: "31-60 days", minDays: 31, maxDays: 60, count: 0, loanIds: new Set(), amount: new Prisma.Decimal(0) };
        const band3 = { name: "61-90 days", minDays: 61, maxDays: 90, count: 0, loanIds: new Set(), amount: new Prisma.Decimal(0) };
        const band4 = { name: "90+ days", minDays: 91, maxDays: Infinity, count: 0, loanIds: new Set(), amount: new Prisma.Decimal(0) };

        const allOverdueLoanIds = new Set();
        let totalOverdueAmount = new Prisma.Decimal(0);

        for (const emi of overdueEmis) {
            const diffMs = asOfMidnight.getTime() - new Date(emi.dueDate).getTime();
            const daysOverdue = Math.floor(diffMs / (24 * 60 * 60 * 1000));

            // Only count if strictly positive
            if (daysOverdue < 1) continue;

            const amt = new Prisma.Decimal(emi.outstandingAmount);
            allOverdueLoanIds.add(emi.loanId);
            totalOverdueAmount = totalOverdueAmount.plus(amt);

            if (daysOverdue <= 30) {
                band1.count++;
                band1.loanIds.add(emi.loanId);
                band1.amount = band1.amount.plus(amt);
            } else if (daysOverdue <= 60) {
                band2.count++;
                band2.loanIds.add(emi.loanId);
                band2.amount = band2.amount.plus(amt);
            } else if (daysOverdue <= 90) {
                band3.count++;
                band3.loanIds.add(emi.loanId);
                band3.amount = band3.amount.plus(amt);
            } else {
                band4.count++;
                band4.loanIds.add(emi.loanId);
                band4.amount = band4.amount.plus(amt);
            }
        }

        const bands = [band1, band2, band3, band4].map((b) => ({
            band: b.name,
            minDaysOverdue: b.minDays,
            maxDaysOverdue: b.maxDays === Infinity ? null : b.maxDays,
            overdueEmisCount: b.count,
            affectedLoansCount: b.loanIds.size,
            outstandingOverdueAmount: b.amount.toString(),
        }));

        return res.json({
            success: true,
            asOfDate: businessDateStr,
            summary: {
                totalOverdueEmis: overdueEmis.length,
                totalAffectedLoans: allOverdueLoanIds.size,
                totalOverdueAmount: totalOverdueAmount.toString(),
            },
            ageingBands: bands,
        });
    } catch (error) {
        console.error("Delinquency ageing report error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to generate delinquency ageing report",
        });
    }
});

// =========================================================================
// HELPER: Fetch Auditable Financial Ledger Events
// =========================================================================

async function fetchLedgerEvents({ startDate, endDate, type, mode, page, limit }) {
    let dateFilter = {};

    if (startDate || endDate) {
        const { start, end } = parseDateRange(startDate, endDate);
        if (start) dateFilter.gte = start;
        if (end) dateFilter.lt = end;
    }

    const events = [];

    // 1. ONLINE PAYMENTS
    if ((!type || type === "ONLINE_PAYMENT") && (!mode || mode === "ONLINE")) {
        const onlinePayments = await prisma.payment.findMany({
            where: {
                mode: "ONLINE",
                status: "SUCCESS",
                ...(Object.keys(dateFilter).length > 0 ? { paidAt: dateFilter } : {}),
            },
            include: {
                loan: { select: { loanNumber: true } },
                emi: { select: { installmentNo: true } },
            },
            take: limit ? limit * 2 : 500,
        });

        for (const p of onlinePayments) {
            events.push({
                id: p.id,
                reference: p.transactionId || p.receiptNumber || `PAY-${p.id.slice(0, 8)}`,
                type: "ONLINE_PAYMENT",
                mode: "ONLINE",
                amount: p.amount,
                timestamp: p.paidAt || p.createdAt,
                status: p.status,
                loanNumber: p.loan.loanNumber,
                installmentNo: p.emi.installmentNo,
                agentEmployeeCode: null,
                settlementReference: null,
                description: `Online repayment received for Loan ${p.loan.loanNumber}, EMI #${p.emi.installmentNo}`,
            });
        }
    }

    // 2. CASH COLLECTIONS
    if ((!type || type === "CASH_COLLECTION") && (!mode || mode === "CASH")) {
        const cashCollections = await prisma.cashCollection.findMany({
            where: {
                payment: { status: "SUCCESS", mode: "CASH" },
                ...(Object.keys(dateFilter).length > 0 ? { collectedAt: dateFilter } : {}),
            },
            include: {
                agent: { select: { employeeCode: true, user: { select: { name: true } } } },
                payment: {
                    select: {
                        status: true,
                        loan: { select: { loanNumber: true } },
                        emi: { select: { installmentNo: true } },
                    },
                },
                settlementItems: {
                    where: { settlement: { status: { not: "CANCELLED" } } },
                    select: { settlement: { select: { settlementReference: true } } },
                },
            },
            take: limit ? limit * 2 : 500,
        });

        for (const c of cashCollections) {
            const stlRef = c.settlementItems[0]?.settlement?.settlementReference || null;
            events.push({
                id: c.id,
                reference: c.receiptNumber,
                type: "CASH_COLLECTION",
                mode: "CASH",
                amount: c.collectedAmount,
                timestamp: c.collectedAt,
                status: c.payment.status,
                loanNumber: c.payment.loan.loanNumber,
                installmentNo: c.payment.emi.installmentNo,
                agentEmployeeCode: c.agent.employeeCode,
                settlementReference: stlRef,
                description: `Cash collection by ${c.agent.employeeCode} for Loan ${c.payment.loan.loanNumber}, EMI #${c.payment.emi.installmentNo}${c.reconciled ? " [Reconciled]" : ""}`,
            });
        }
    }

    // 3. CASH SETTLEMENTS
    if ((!type || type === "CASH_SETTLEMENT") && (!mode || mode === "CASH")) {
        const settlements = await prisma.cashSettlement.findMany({
            where: {
                ...(Object.keys(dateFilter).length > 0 ? { businessDate: dateFilter } : {}),
            },
            include: {
                agent: { select: { employeeCode: true } },
            },
            take: limit ? limit * 2 : 500,
        });

        for (const s of settlements) {
            events.push({
                id: s.id,
                reference: s.settlementReference,
                type: "CASH_SETTLEMENT",
                mode: "CASH",
                amount: s.actualAmount || s.expectedAmount,
                timestamp: s.reconciledAt || s.countedAt || s.createdAt,
                status: s.status,
                loanNumber: null,
                installmentNo: null,
                agentEmployeeCode: s.agent?.employeeCode || "ALL_AGENTS",
                settlementReference: s.settlementReference,
                description: `Cash settlement ${s.settlementReference} [${s.status}] Expected: ₹${s.expectedAmount}${s.actualAmount ? `, Counted: ₹${s.actualAmount}` : ""}${s.discrepancyAmount && !s.discrepancyAmount.isZero() ? `, Discrepancy: ₹${s.discrepancyAmount}` : ""}`,
            });
        }
    }

    // 4. REFUNDS
    if (!type || type === "REFUND") {
        const refunds = await prisma.payment.findMany({
            where: {
                status: "REFUNDED",
                ...(mode ? { mode } : {}),
                ...(Object.keys(dateFilter).length > 0 ? { updatedAt: dateFilter } : {}),
            },
            include: {
                loan: { select: { loanNumber: true } },
                emi: { select: { installmentNo: true } },
            },
            take: limit ? limit * 2 : 500,
        });

        for (const r of refunds) {
            events.push({
                id: r.id,
                reference: r.receiptNumber || r.transactionId || `REF-${r.id.slice(0, 8)}`,
                type: "REFUND",
                mode: r.mode,
                amount: r.amount,
                timestamp: r.updatedAt,
                status: "REFUNDED",
                loanNumber: r.loan.loanNumber,
                installmentNo: r.emi.installmentNo,
                agentEmployeeCode: null,
                settlementReference: null,
                description: `Refund recorded for Loan ${r.loan.loanNumber}, EMI #${r.emi.installmentNo}`,
            });
        }
    }

    // Deterministic sorting: newest timestamp first, then ID
    events.sort((a, b) => {
        const timeDiff = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        if (timeDiff !== 0) return timeDiff;
        return String(b.id).localeCompare(String(a.id));
    });

    return events;
}

// =========================================================================
// PHASE 6 — CSV EXPORT
// GET /api/admin/financial-reports/ledger/export.csv
// (Must be mounted before /ledger or on distinct route)
// =========================================================================

router.get("/ledger/export.csv", async (req, res) => {
    try {
        const { startDate, endDate, type, mode } = req.query;

        // Fetch up to 1000 matching financial records for the CSV export
        const events = await fetchLedgerEvents({
            startDate,
            endDate,
            type,
            mode,
            page: 1,
            limit: 1000,
        });

        const headers = [
            "Source ID",
            "Timestamp (UTC)",
            "Event Type",
            "Mode",
            "Reference",
            "Amount (INR)",
            "Status",
            "Loan Number",
            "Installment No",
            "Agent",
            "Settlement Reference",
            "Description",
        ];

        const rows = [headers.map(sanitizeCsvValue).join(",")];

        for (const e of events) {
            const row = [
                e.id,
                new Date(e.timestamp).toISOString(),
                e.type,
                e.mode,
                e.reference,
                e.amount.toString(),
                e.status,
                e.loanNumber || "N/A",
                e.installmentNo !== null ? e.installmentNo : "N/A",
                e.agentEmployeeCode || "N/A",
                e.settlementReference || "N/A",
                e.description,
            ];
            rows.push(row.map(sanitizeCsvValue).join(","));
        }

        const csvContent = rows.join("\r\n");
        const filename = `speed_money_ledger_${startDate || "all"}_to_${endDate || "latest"}.csv`;

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        return res.status(200).send(csvContent);
    } catch (error) {
        console.error("Ledger CSV export error:", error);
        return res.status(400).json({
            success: false,
            message: error.message || "Failed to generate CSV export",
        });
    }
});

// =========================================================================
// PHASE 5 — ACCOUNTING LEDGER EXPORT (JSON)
// GET /api/admin/financial-reports/ledger
// =========================================================================

router.get("/ledger", async (req, res) => {
    try {
        let page = parseInt(req.query.page, 10);
        if (isNaN(page) || page < 1) page = 1;

        let limit = parseInt(req.query.limit, 10);
        if (isNaN(limit) || limit < 1) limit = 20;
        if (limit > 100) limit = 100;

        const { startDate, endDate, type, mode } = req.query;

        // Fetch all matching events
        const allEvents = await fetchLedgerEvents({
            startDate,
            endDate,
            type,
            mode,
            limit: null,
        });

        const totalRecords = allEvents.length;
        const totalPages = Math.ceil(totalRecords / limit) || 1;
        const skip = (page - 1) * limit;
        const pagedEvents = allEvents.slice(skip, skip + limit);

        let totalCreditAmount = new Prisma.Decimal(0);
        for (const e of pagedEvents) {
            totalCreditAmount = totalCreditAmount.plus(e.amount);
        }

        return res.json({
            success: true,
            pagination: {
                page,
                limit,
                totalRecords,
                totalPages,
            },
            summary: {
                pageRecordsCount: pagedEvents.length,
                pageTotalAmount: totalCreditAmount.toString(),
            },
            ledger: pagedEvents.map((e) => ({
                id: e.id,
                reference: e.reference,
                type: e.type,
                mode: e.mode,
                amount: e.amount.toString(),
                timestamp: e.timestamp,
                status: e.status,
                loanNumber: e.loanNumber,
                installmentNo: e.installmentNo,
                agentEmployeeCode: e.agentEmployeeCode,
                settlementReference: e.settlementReference,
                description: e.description,
            })),
            accountingNote:
                "Auditable financial transaction event ledger projection. Double-entry general ledger requires separate chart of accounts integration.",
        });
    } catch (error) {
        console.error("Accounting ledger error:", error);
        return res.status(400).json({
            success: false,
            message: error.message || "Failed to fetch accounting ledger",
        });
    }
});

module.exports = router;
