const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { Prisma } = require("@prisma/client");

const prisma = require("../lib/prisma");
const { authenticateToken } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");

const router = express.Router();

// All endpoints require ADMIN authentication
router.use(authenticateToken, authorizeRoles("ADMIN"));

function calculateScheduleTerms({
    calculationMode = "STANDARD",
    repaymentFrequency = "MONTHLY",
    principal,
    annualRate,
    tenureMonths,
    emiDueAmount,
    monthlyReturn,
}) {
    const is15Days =
        repaymentFrequency === "15_DAYS" ||
        repaymentFrequency === "15-Day" ||
        repaymentFrequency === "15_DAY";
    const tenureM = Math.max(parseInt(tenureMonths, 10) || 12, 1);
    const totalInstallments = is15Days ? tenureM * 2 : tenureM;

    let emiValue = 0;
    let principalValue = parseFloat(principal) || 0;
    let rateValue = parseFloat(annualRate) || 14;
    let totalPayableValue = 0;
    let totalInterestValue = 0;

    if (
        calculationMode === "TARGET_RETURN" ||
        calculationMode === "RETURN_MODE" ||
        emiDueAmount
    ) {
        // Mode where Admin enters: EMI Due, tenure in months, and monthly return
        const targetEmi = Math.max(parseFloat(emiDueAmount) || 0, 1);
        emiValue = targetEmi;
        totalPayableValue = Math.round(emiValue * totalInstallments * 100) / 100;

        if (monthlyReturn !== undefined && monthlyReturn !== null && monthlyReturn !== "") {
            const mReturn = Math.max(parseFloat(monthlyReturn) || 0, 0);
            totalInterestValue = Math.round(mReturn * tenureM * 100) / 100;
            principalValue = Math.max(Math.round((totalPayableValue - totalInterestValue) * 100) / 100, 1);
            if (principalValue > 0) {
                rateValue = Math.round(((totalInterestValue / principalValue) / (tenureM / 12)) * 10000) / 100;
            }
        } else if (principalValue > 0) {
            totalInterestValue = Math.max(Math.round((totalPayableValue - principalValue) * 100) / 100, 0);
            rateValue = Math.round(((totalInterestValue / principalValue) / (tenureM / 12)) * 10000) / 100;
        } else {
            principalValue = Math.max(Math.round(totalPayableValue * 0.85 * 100) / 100, 1);
            totalInterestValue = Math.round((totalPayableValue - principalValue) * 100) / 100;
        }
    } else {
        // Standard mode: Principal, Rate, Tenure
        principalValue = Math.max(parseFloat(principal) || 50000, 1000);
        rateValue = Math.max(parseFloat(annualRate) || 14, 0.1);

        const periodRate = is15Days
            ? (rateValue / 100) / 24
            : (rateValue / 100) / 12;

        if (periodRate === 0) {
            emiValue = Math.round((principalValue / totalInstallments) * 100) / 100;
        } else {
            const pwr = Math.pow(1 + periodRate, totalInstallments);
            emiValue = Math.round(((principalValue * periodRate * pwr) / (pwr - 1)) * 100) / 100;
        }

        totalPayableValue = Math.round(emiValue * totalInstallments * 100) / 100;
        totalInterestValue = Math.round((totalPayableValue - principalValue) * 100) / 100;
    }

    return {
        is15Days,
        totalInstallments,
        emiValue,
        principalValue,
        rateValue,
        totalPayableValue,
        totalInterestValue,
    };
}

/**
 * POST /api/admin/customers/onboard
 * Admin directly onboards an existing or new customer with active loan,
 * EMIs already paid, repayment scheduling (Monthly / 15-Day), and assigned agent.
 */
router.post("/onboard", async (req, res) => {
    try {
        const {
            name,
            phone,
            email,
            address,
            city,
            state,
            pincode,
            loanType = "Personal & Emergency",
            loanAmount = 50000,
            interestRate = 14,
            tenureMonths = 12,
            emisPaid = 0,
            monthlyDeadlineDay = 5,
            agentId,
            occupation,
            monthlyIncome,
            repaymentFrequency = "MONTHLY",
            calculationMode = "STANDARD",
            emiDueAmount,
            monthlyReturn,
        } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: "Customer name is required" });
        }
        if (!phone || !phone.trim()) {
            return res.status(400).json({ success: false, message: "Customer mobile number is required" });
        }

        const cleanDigits = phone.replace(/\D/g, "").slice(-10);
        if (cleanDigits.length !== 10) {
            return res.status(400).json({ success: false, message: "Valid 10-digit mobile number is required" });
        }

        const deadlineDay = Math.min(Math.max(parseInt(monthlyDeadlineDay, 10) || 5, 1), 31);
        const parsedTenure = Math.max(parseInt(tenureMonths, 10) || 12, 1);

        const terms = calculateScheduleTerms({
            calculationMode,
            repaymentFrequency,
            principal: loanAmount,
            annualRate: interestRate,
            tenureMonths: parsedTenure,
            emiDueAmount,
            monthlyReturn,
        });

        const {
            is15Days,
            totalInstallments,
            emiValue,
            principalValue,
            rateValue,
            totalPayableValue,
            totalInterestValue,
        } = terms;

        const parsedEmisPaid = Math.min(Math.max(parseInt(emisPaid, 10) || 0, 0), totalInstallments);
        const paidSoFar = Math.round(emiValue * parsedEmisPaid * 100) / 100;
        const outstandingBalance = Math.max(Math.round((totalPayableValue - paidSoFar) * 100) / 100, 0);

        // Pre-hash default password outside transaction to conserve transaction time
        const defaultPw = await bcrypt.hash("SpeedMoney@123", 10);

        // Transactional creation with generous timeout and batch queries
        const result = await prisma.$transaction(
            async (tx) => {
                // 1. Find or create User
                let user = await tx.user.findFirst({
                    where: {
                        OR: [
                            { phone: cleanDigits },
                            { phone: `+91${cleanDigits}` },
                        ],
                    },
                    include: { customerProfile: true },
                });

                if (!user) {
                    const userEmail = email && email.trim()
                        ? email.trim().toLowerCase()
                        : `cust_${cleanDigits}@speedmoney.internal`;

                    user = await tx.user.create({
                        data: {
                            name: name.trim(),
                            email: userEmail,
                            phone: cleanDigits,
                            password: defaultPw,
                            role: "CUSTOMER",
                            status: "ACTIVE",
                            customerProfile: {
                                create: {
                                    address: address ? address.trim() : null,
                                    city: city ? city.trim() : "Bengaluru",
                                    state: state ? state.trim() : "Karnataka",
                                    pincode: pincode ? pincode.trim() : null,
                                    occupation: occupation || "Self Employed",
                                    monthlyIncome: monthlyIncome ? new Prisma.Decimal(monthlyIncome) : null,
                                },
                            },
                        },
                        include: { customerProfile: true },
                    });
                } else {
                    // Update profile details
                    user = await tx.user.update({
                        where: { id: user.id },
                        data: {
                            name: name.trim(),
                            customerProfile: {
                                upsert: {
                                    create: {
                                        address: address ? address.trim() : null,
                                        city: city ? city.trim() : "Bengaluru",
                                        state: state ? state.trim() : "Karnataka",
                                        pincode: pincode ? pincode.trim() : null,
                                        occupation: occupation || "Self Employed",
                                        monthlyIncome: monthlyIncome ? new Prisma.Decimal(monthlyIncome) : null,
                                    },
                                    update: {
                                        ...(address ? { address: address.trim() } : {}),
                                        ...(city ? { city: city.trim() } : {}),
                                        ...(state ? { state: state.trim() } : {}),
                                        ...(pincode ? { pincode: pincode.trim() } : {}),
                                        ...(occupation ? { occupation } : {}),
                                        ...(monthlyIncome ? { monthlyIncome: new Prisma.Decimal(monthlyIncome) } : {}),
                                    },
                                },
                            },
                        },
                        include: { customerProfile: true },
                    });
                }

                const customerProfile = user.customerProfile;

                // 2. Find or create LoanProduct
                let product = await tx.loanProduct.findFirst({
                    where: {
                        name: {
                            contains: loanType.trim(),
                            mode: "insensitive",
                        },
                    },
                });

                if (!product) {
                    product = await tx.loanProduct.create({
                        data: {
                            name: loanType.trim(),
                            description: `${loanType.trim()} financing`,
                            minAmount: new Prisma.Decimal(5000),
                            maxAmount: new Prisma.Decimal(500000),
                            minInterestRate: new Prisma.Decimal(10),
                            maxInterestRate: new Prisma.Decimal(24),
                            minTenureMonths: 3,
                            maxTenureMonths: 36,
                            active: true,
                        },
                    });
                }

                // 3. Create LoanApplication (APPROVED)
                const application = await tx.loanApplication.create({
                    data: {
                        customerId: customerProfile.id,
                        productId: product.id,
                        requestedAmount: new Prisma.Decimal(principalValue),
                        requestedTenure: parsedTenure,
                        interestRate: new Prisma.Decimal(rateValue),
                        status: "APPROVED",
                        purpose: is15Days
                            ? "Customer Onboarding (15-Day Repayment Schedule)"
                            : "Customer Onboarding (Monthly Repayment Schedule)",
                        submittedAt: new Date(Date.now() - (parsedEmisPaid * (is15Days ? 15 : 30) * 24 * 60 * 60 * 1000)),
                        reviewedAt: new Date(Date.now() - (parsedEmisPaid * (is15Days ? 15 : 30) * 24 * 60 * 60 * 1000)),
                    },
                });

                // 4. Create Loan
                const randomCode = crypto.randomBytes(2).toString("hex").toUpperCase();
                const loanNumber = `SM-LN-${new Date().getFullYear()}-${randomCode}`;
                let startDate;
                let endDate;

                if (is15Days) {
                    startDate = new Date(Date.now() - parsedEmisPaid * 15 * 24 * 60 * 60 * 1000);
                    endDate = new Date(startDate.getTime() + totalInstallments * 15 * 24 * 60 * 60 * 1000);
                } else {
                    startDate = new Date();
                    startDate.setMonth(startDate.getMonth() - parsedEmisPaid);
                    startDate.setDate(deadlineDay);

                    endDate = new Date(startDate);
                    endDate.setMonth(endDate.getMonth() + parsedTenure);
                }

                const loan = await tx.loan.create({
                    data: {
                        customerId: customerProfile.id,
                        applicationId: application.id,
                        loanNumber,
                        principalAmount: new Prisma.Decimal(principalValue),
                        interestRate: new Prisma.Decimal(rateValue),
                        tenureMonths: parsedTenure,
                        emiAmount: new Prisma.Decimal(emiValue),
                        totalInterest: new Prisma.Decimal(totalInterestValue),
                        totalPayable: new Prisma.Decimal(totalPayableValue),
                        outstandingAmount: new Prisma.Decimal(outstandingBalance),
                        startDate,
                        endDate,
                        disbursedAt: startDate,
                        disbursementReference: `NEFT-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
                        status: outstandingBalance <= 0 ? "COMPLETED" : "ACTIVE",
                    },
                });

                // 5. Generate EMI schedule and historical payments in high-performance batch
                const now = new Date();
                const emiRecords = [];
                const paymentRecords = [];

                for (let i = 1; i <= totalInstallments; i++) {
                    let emiDueDate;
                    if (is15Days) {
                        emiDueDate = new Date(startDate.getTime() + i * 15 * 24 * 60 * 60 * 1000);
                    } else {
                        emiDueDate = new Date(startDate);
                        emiDueDate.setMonth(emiDueDate.getMonth() + i);
                        emiDueDate.setDate(deadlineDay);
                    }

                    const isPaid = i <= parsedEmisPaid;
                    const principalPart = Math.round((principalValue / totalInstallments) * 100) / 100;
                    const interestPart = Math.round((emiValue - principalPart) * 100) / 100;
                    const emiId = crypto.randomUUID();

                    emiRecords.push({
                        id: emiId,
                        loanId: loan.id,
                        installmentNo: i,
                        dueDate: emiDueDate,
                        principalAmount: new Prisma.Decimal(principalPart),
                        interestAmount: new Prisma.Decimal(interestPart),
                        emiAmount: new Prisma.Decimal(emiValue),
                        paidAmount: new Prisma.Decimal(isPaid ? emiValue : 0),
                        outstandingAmount: new Prisma.Decimal(isPaid ? 0 : emiValue),
                        status: isPaid ? "PAID" : (emiDueDate < now ? "OVERDUE" : "PENDING"),
                        paidAt: isPaid ? emiDueDate : null,
                    });

                    if (isPaid) {
                        const rcpt = `RCPT-${loanNumber}-${String(i).padStart(2, "0")}`;
                        paymentRecords.push({
                            id: crypto.randomUUID(),
                            loanId: loan.id,
                            emiId: emiId,
                            amount: new Prisma.Decimal(emiValue),
                            mode: i % 2 === 0 ? "CASH" : "ONLINE",
                            status: "SUCCESS",
                            transactionId: `HIST-${loan.id}-${i}`,
                            receiptNumber: rcpt,
                            paidAt: emiDueDate,
                        });
                    }
                }

                if (emiRecords.length > 0) {
                    await tx.emiSchedule.createMany({ data: emiRecords });
                }

                if (paymentRecords.length > 0) {
                    await tx.payment.createMany({ data: paymentRecords });
                }

                // 6. Assign agent if selected
                let assignedAgentProfile = null;
                if (agentId && agentId.trim()) {
                    assignedAgentProfile = await tx.agentProfile.findFirst({
                        where: {
                            OR: [
                                { id: agentId.trim() },
                                { employeeCode: agentId.trim() },
                                { userId: agentId.trim() },
                            ],
                        },
                        include: { user: true },
                    });

                    if (assignedAgentProfile) {
                        await tx.customerAgentAssignment.create({
                            data: {
                                customerId: customerProfile.id,
                                agentId: assignedAgentProfile.id,
                                type: "PRIMARY",
                                active: true,
                            },
                        });

                        await tx.loanAgentAssignment.create({
                            data: {
                                loanId: loan.id,
                                agentId: assignedAgentProfile.id,
                                type: "PRIMARY",
                                active: true,
                            },
                        });
                    }
                }

                // 7. Audit log
                await tx.auditLog.create({
                    data: {
                        userId: req.user.userId,
                        action: "CREATE",
                        entity: "CustomerProfile",
                        entityId: customerProfile.id,
                        description: `Admin onboarded customer ${name} with loan ${loanNumber} (${parsedEmisPaid}/${parsedTenure} EMIs paid, deadline ${deadlineDay}th)`,
                        metadata: {
                            customerId: customerProfile.id,
                            loanId: loan.id,
                            loanNumber,
                            emisPaid: parsedEmisPaid,
                            deadlineDay,
                            agentId: assignedAgentProfile?.id || null,
                        },
                    },
                });

                return { user, customerProfile, loan, agent: assignedAgentProfile };
            },
            {
                maxWait: 15000,
                timeout: 60000,
            }
        );

        return res.status(201).json({
            success: true,
            message: `Customer ${name} onboarded successfully with loan ${result.loan.loanNumber}`,
            customer: {
                id: result.user.id,
                customerId: result.customerProfile.id,
                name: result.user.name,
                phone: result.user.phone,
                email: result.user.email,
            },
            loan: {
                id: result.loan.id,
                loanNumber: result.loan.loanNumber,
                principalAmount: result.loan.principalAmount.toString(),
                emiAmount: result.loan.emiAmount.toString(),
                outstandingAmount: result.loan.outstandingAmount.toString(),
                tenureMonths: result.loan.tenureMonths,
                emisPaid: parsedEmisPaid,
                monthlyDeadlineDay: deadlineDay,
            },
            agent: result.agent ? {
                id: result.agent.id,
                name: result.agent.user.name,
                employeeCode: result.agent.employeeCode,
            } : null,
        });
    } catch (err) {
        console.error("Onboard customer error:", err);
        return res.status(500).json({
            success: false,
            message: err.message || "Failed to onboard customer",
        });
    }
});

/**
 * GET /api/admin/customers/list
 * Search and filter customers by:
 * - search query (name, phone, loan number)
 * - assigned agent
 * - monthly deadline day
 */
router.get("/list", async (req, res) => {
    try {
        const { search, agentId, deadlineDay } = req.query;

        const customers = await prisma.customerProfile.findMany({
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
                loans: {
                    where: {
                        status: { in: ["ACTIVE", "OVERDUE", "COMPLETED", "PENDING_DISBURSEMENT"] },
                    },
                    include: {
                        application: {
                            include: { product: true },
                        },
                        emis: {
                            orderBy: { installmentNo: "asc" },
                        },
                        agentAssignments: {
                            where: { active: true },
                            include: {
                                agent: {
                                    include: {
                                        user: { select: { id: true, name: true, phone: true } },
                                    },
                                },
                            },
                        },
                    },
                    orderBy: { createdAt: "desc" },
                },
                assignments: {
                    where: { active: true },
                    include: {
                        agent: {
                            include: {
                                user: { select: { id: true, name: true, phone: true } },
                            },
                        },
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });

        // Filter in memory for maximum search responsiveness
        let filtered = customers.map((c) => {
            const activeLoan = c.loans.length > 0 ? c.loans[0] : null;
            const primaryAgent =
                activeLoan?.agentAssignments[0]?.agent ||
                c.assignments[0]?.agent ||
                null;

            // Determine monthly deadline day from first EMI or loan start date
            let customerDeadlineDay = 5;
            if (activeLoan && activeLoan.emis.length > 0) {
                customerDeadlineDay = new Date(activeLoan.emis[0].dueDate).getDate();
            }

            const paidEmis = activeLoan
                ? activeLoan.emis.filter((e) => e.status === "PAID").length
                : 0;

            const nextDueEmi = activeLoan
                ? activeLoan.emis.find((e) => ["PENDING", "PARTIAL", "OVERDUE"].includes(e.status))
                : null;

            return {
                id: c.id,
                userId: c.user.id,
                name: c.user.name,
                mobile: c.user.phone ? (c.user.phone.startsWith("+91") ? c.user.phone : `+91 ${c.user.phone}`) : "—",
                phoneRaw: c.user.phone || "",
                email: c.user.email,
                address: c.address || "—",
                city: c.city || "—",
                state: c.state || "—",
                pincode: c.pincode || "—",
                status: c.user.status,
                activeLoan: activeLoan ? {
                    id: activeLoan.id,
                    loanNumber: activeLoan.loanNumber,
                    product: activeLoan.application?.product?.name || "Personal Loan",
                    principal: parseFloat(activeLoan.principalAmount),
                    outstanding: parseFloat(activeLoan.outstandingAmount),
                    emiAmount: parseFloat(activeLoan.emiAmount),
                    tenure: activeLoan.tenureMonths,
                    emisPaid: paidEmis,
                    totalEmis: activeLoan.emis.length,
                    status: activeLoan.status,
                    nextEmiDue: nextDueEmi ? nextDueEmi.dueDate : null,
                    nextEmiAmount: nextDueEmi ? parseFloat(nextDueEmi.outstandingAmount) : 0,
                    deadlineDay: customerDeadlineDay,
                    repaymentFrequency: (activeLoan.application?.purpose?.includes("15-Day") || activeLoan.emis.length > activeLoan.tenureMonths) ? "15_DAYS" : "MONTHLY",
                } : null,
                assignedAgent: primaryAgent ? {
                    id: primaryAgent.id,
                    name: primaryAgent.user.name,
                    employeeCode: primaryAgent.employeeCode,
                    phone: primaryAgent.user.phone,
                } : null,
            };
        });

        // Apply filters
        if (search && search.trim()) {
            const q = search.trim().toLowerCase();
            filtered = filtered.filter((c) =>
                c.name.toLowerCase().includes(q) ||
                c.phoneRaw.includes(q) ||
                c.mobile.toLowerCase().includes(q) ||
                (c.activeLoan && c.activeLoan.loanNumber.toLowerCase().includes(q))
            );
        }

        if (agentId && agentId.trim() && agentId !== "all") {
            const targetAgent = agentId.trim();
            filtered = filtered.filter((c) =>
                c.assignedAgent && (
                    c.assignedAgent.id === targetAgent ||
                    c.assignedAgent.employeeCode === targetAgent ||
                    c.assignedAgent.name.toLowerCase().includes(targetAgent.toLowerCase())
                )
            );
        }

        if (deadlineDay && deadlineDay !== "all") {
            const targetDay = parseInt(deadlineDay, 10);
            filtered = filtered.filter((c) =>
                c.activeLoan && c.activeLoan.deadlineDay === targetDay
            );
        }

        return res.json({
            success: true,
            count: filtered.length,
            customers: filtered,
        });
    } catch (err) {
        console.error("List customers error:", err);
        return res.status(500).json({ success: false, message: "Failed to list customers" });
    }
});

/**
 * GET /api/admin/customers/agents
 * List available active collection agents with live assignment counts and collection stats.
 */
router.get("/agents", async (req, res) => {
    try {
        const todayIST = new Date();
        todayIST.setHours(0, 0, 0, 0);

        const agents = await prisma.agentProfile.findMany({
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
                loanAssignments: {
                    where: { active: true },
                },
                collections: true,
            },
            orderBy: { createdAt: "desc" },
        });

        const formatted = agents.map((a) => {
            const assignedCount = a.loanAssignments.length;
            let todayCollection = 0;
            let cashHeld = 0;

            for (const col of a.collections) {
                const amt = Number(col.collectedAmount) || 0;
                if (!col.reconciled) {
                    cashHeld += amt;
                }
                if (col.collectedAt >= todayIST) {
                    todayCollection += amt;
                }
            }

            return {
                id: a.id,
                name: a.user?.name || "Agent",
                employeeCode: a.employeeCode,
                phone: a.user?.phone || "—",
                email: a.user?.email || "—",
                status: a.user?.status || "ACTIVE",
                assigned: assignedCount,
                today: todayCollection,
                held: cashHeld,
            };
        });

        return res.json({
            success: true,
            count: formatted.length,
            agents: formatted,
        });
    } catch (err) {
        console.error("List agents error:", err);
        return res.status(500).json({ success: false, message: "Failed to fetch agents" });
    }
});

/**
 * GET /api/admin/customers/emis/list
 * Returns live EMI installments across all loans with customer and loan details.
 */
router.get("/emis/list", async (req, res) => {
    try {
        const { status, search } = req.query;
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

        const where = {};
        if (status && status !== "All") {
            const upper = status.toUpperCase();
            if (upper === "DUE TODAY") {
                where.dueDate = { gte: startOfToday, lte: endOfToday };
                where.status = { not: "PAID" };
            } else if (upper === "UPCOMING") {
                where.dueDate = { gt: endOfToday };
                where.status = { not: "PAID" };
            } else if (upper === "OVERDUE") {
                where.OR = [
                    { status: "OVERDUE" },
                    { dueDate: { lt: startOfToday }, status: { in: ["PENDING", "PARTIAL"] } }
                ];
            } else if (upper === "PAID") {
                where.status = "PAID";
            }
        }

        if (search && search.trim()) {
            const term = search.trim();
            where.OR = [
                { loan: { loanNumber: { contains: term, mode: "insensitive" } } },
                { loan: { customer: { user: { name: { contains: term, mode: "insensitive" } } } } },
                { loan: { customer: { user: { phone: { contains: term } } } } },
            ];
        }

        const emis = await prisma.emiSchedule.findMany({
            where,
            include: {
                loan: {
                    include: {
                        customer: {
                            include: {
                                user: {
                                    select: { id: true, name: true, phone: true }
                                }
                            }
                        }
                    }
                }
            },
            orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }],
            take: 200,
        });

        const formatted = emis.map((e) => {
            const isDueToday = e.dueDate >= startOfToday && e.dueDate <= endOfToday;
            const isOverdue = (e.status === "OVERDUE" || (e.dueDate < startOfToday && e.status !== "PAID"));
            let displayStatus = e.status === "PAID" ? "Paid" : isDueToday ? "Due Today" : isOverdue ? "Overdue" : "Upcoming";

            return {
                id: e.id,
                installmentNo: e.installmentNo,
                loanId: e.loan.id,
                loanNumber: e.loan.loanNumber,
                customerId: e.loan.customer.id,
                customerUserId: e.loan.customer.user.id,
                customerName: e.loan.customer.user.name,
                customerPhone: e.loan.customer.user.phone,
                dueDate: e.dueDate.toISOString().split("T")[0],
                amount: e.emiAmount.toString(),
                paidAmount: e.paidAmount.toString(),
                outstandingAmount: e.outstandingAmount.toString(),
                status: displayStatus,
                rawStatus: e.status,
            };
        });

        return res.json({
            success: true,
            count: formatted.length,
            emis: formatted,
        });
    } catch (err) {
        console.error("List emis error:", err);
        return res.status(500).json({ success: false, message: "Failed to fetch EMIs" });
    }
});

/**
 * GET /api/admin/customers/:id/full-details
 * Returns comprehensive customer profile, loans, full EMI schedules, and payment history.
 */
router.get("/:id/full-details", async (req, res) => {
    try {
        const { id } = req.params;

        const customer = await prisma.customerProfile.findFirst({
            where: {
                OR: [
                    { id: id.trim() },
                    { userId: id.trim() },
                ],
            },
            include: {
                user: true,
                loans: {
                    include: {
                        application: { include: { product: true } },
                        emis: { orderBy: { installmentNo: "asc" } },
                        payments: {
                            include: {
                                cashCollection: {
                                    include: { agent: { include: { user: true } } },
                                },
                                onlinePayment: true,
                                emi: true,
                            },
                            orderBy: { createdAt: "desc" },
                        },
                        agentAssignments: {
                            where: { active: true },
                            include: { agent: { include: { user: true } } },
                        },
                    },
                    orderBy: { createdAt: "desc" },
                },
                assignments: {
                    where: { active: true },
                    include: { agent: { include: { user: true } } },
                },
            },
        });

        if (!customer) {
            return res.status(404).json({ success: false, message: "Customer not found" });
        }

        const activeLoan = customer.loans[0] || null;
        const primaryAgent =
            activeLoan?.agentAssignments[0]?.agent ||
            customer.assignments[0]?.agent ||
            null;

        let deadlineDay = 5;
        if (activeLoan && activeLoan.emis.length > 0) {
            deadlineDay = new Date(activeLoan.emis[0].dueDate).getDate();
        }

        const formattedPayments = (activeLoan?.payments || []).map((p) => {
            let modeLabel = p.mode === "CASH" ? "Cash (Agent)" : "Online Gateway";
            if (p.onlinePayment?.gatewayResponse?.method === "UPI_QR") {
                modeLabel = "UPI QR Code";
            }
            return {
                id: p.id,
                amount: p.amount.toString(),
                mode: modeLabel,
                rawMode: p.mode,
                receiptNumber: p.receiptNumber || "—",
                transactionId: p.transactionId || "—",
                paidAt: p.paidAt || p.createdAt,
                status: p.status,
                installmentNo: p.emi?.installmentNo || "—",
                collector: p.cashCollection?.agent?.user?.name || (p.onlinePayment?.gatewayResponse?.agentName) || null,
            };
        });

        return res.json({
            success: true,
            customer: {
                id: customer.id,
                userId: customer.user.id,
                name: customer.user.name,
                phone: customer.user.phone,
                email: customer.user.email,
                address: customer.address || "—",
                city: customer.city || "—",
                state: customer.state || "—",
                pincode: customer.pincode || "—",
                occupation: customer.occupation || "—",
                monthlyIncome: customer.monthlyIncome ? customer.monthlyIncome.toString() : "—",
                status: customer.user.status,
                createdAt: customer.user.createdAt,
            },
            activeLoan: activeLoan ? {
                id: activeLoan.id,
                loanNumber: activeLoan.loanNumber,
                product: activeLoan.application?.product?.name || "Personal Loan",
                principalAmount: activeLoan.principalAmount.toString(),
                interestRate: activeLoan.interestRate.toString(),
                tenureMonths: activeLoan.tenureMonths,
                emiAmount: activeLoan.emiAmount.toString(),
                totalPayable: activeLoan.totalPayable.toString(),
                outstandingAmount: activeLoan.outstandingAmount.toString(),
                status: activeLoan.status,
                startDate: activeLoan.startDate,
                monthlyDeadlineDay: deadlineDay,
                repaymentFrequency: (activeLoan.application?.purpose?.includes("15-Day") || activeLoan.emis.length > activeLoan.tenureMonths) ? "15_DAYS" : "MONTHLY",
                emis: activeLoan.emis.map((e) => ({
                    id: e.id,
                    installmentNo: e.installmentNo,
                    dueDate: e.dueDate,
                    emiAmount: e.emiAmount.toString(),
                    paidAmount: e.paidAmount.toString(),
                    outstandingAmount: e.outstandingAmount.toString(),
                    status: e.status,
                    paidAt: e.paidAt,
                })),
                payments: formattedPayments,
            } : null,
            assignedAgent: primaryAgent ? {
                id: primaryAgent.id,
                name: primaryAgent.user.name,
                employeeCode: primaryAgent.employeeCode,
                phone: primaryAgent.user.phone,
            } : null,
        });
    } catch (err) {
        console.error("Get customer full details error:", err);
        return res.status(500).json({ success: false, message: "Failed to fetch customer details" });
    }
});

/**
 * GET /api/admin/customers/notifications/transactions
 * Real-time transaction feed for every transaction made on any app.
 */
router.get("/notifications/transactions", async (req, res) => {
    try {
        const payments = await prisma.payment.findMany({
            take: 50,
            orderBy: { createdAt: "desc" },
            include: {
                loan: {
                    include: {
                        customer: {
                            include: { user: true },
                        },
                    },
                },
                emi: true,
                cashCollection: {
                    include: {
                        agent: {
                            include: { user: true },
                        },
                    },
                },
                onlinePayment: true,
            },
        });

        const notifications = payments.map((p) => {
            const isCash = p.mode === "CASH";
            const isQr = p.onlinePayment?.gatewayResponse?.method === "UPI_QR";

            let modeLabel = isCash ? "Cash (Agent)" : (isQr ? "UPI QR Code" : "Online Gateway");
            let collectorName = null;
            if (isCash && p.cashCollection?.agent?.user) {
                collectorName = p.cashCollection.agent.user.name;
            } else if (isQr && p.onlinePayment?.gatewayResponse?.agentName) {
                collectorName = p.onlinePayment.gatewayResponse.agentName;
            }

            const customerName = p.loan?.customer?.user?.name || "Customer";
            const loanNum = p.loan?.loanNumber || "Loan";
            const emiNum = p.emi?.installmentNo ? `#${p.emi.installmentNo}` : "";

            let message = `${customerName} paid ₹${parseFloat(p.amount).toLocaleString("en-IN")} for ${loanNum} (EMI ${emiNum}) via ${modeLabel}`;
            if (collectorName) {
                message += ` [Collected by ${collectorName}]`;
            }

            return {
                id: p.id,
                timestamp: p.paidAt || p.createdAt,
                amount: parseFloat(p.amount),
                amountFormatted: `₹${parseFloat(p.amount).toLocaleString("en-IN")}`,
                mode: modeLabel,
                rawMode: isQr ? "UPI_QR" : p.mode,
                receiptNumber: p.receiptNumber,
                transactionId: p.transactionId,
                status: p.status,
                customer: {
                    name: customerName,
                    phone: p.loan?.customer?.user?.phone || null,
                },
                loan: {
                    loanNumber: loanNum,
                    emiNumber: emiNum,
                },
                collector: collectorName,
                message,
            };
        });

        return res.json({
            success: true,
            count: notifications.length,
            notifications,
        });
    } catch (err) {
        console.error("Transaction notifications error:", err);
        return res.status(500).json({ success: false, message: "Failed to fetch notifications" });
    }
});

/**
 * GET /api/admin/customers/payments/feed
 * Paginated and filtered payments list with Mode of Payment.
 */
router.get("/payments/feed", async (req, res) => {
    try {
        const { mode, search } = req.query;

        const payments = await prisma.payment.findMany({
            take: 100,
            orderBy: { createdAt: "desc" },
            include: {
                loan: {
                    include: {
                        customer: {
                            include: { user: true },
                        },
                    },
                },
                emi: true,
                cashCollection: {
                    include: {
                        agent: {
                            include: { user: true },
                        },
                    },
                },
                onlinePayment: true,
            },
        });

        let mapped = payments.map((p) => {
            const isCash = p.mode === "CASH";
            const isQr = p.onlinePayment?.gatewayResponse?.method === "UPI_QR";

            let modeDisplay = isCash ? "Cash (Agent)" : (isQr ? "UPI QR" : "Online");
            let modeKey = isCash ? "CASH" : (isQr ? "UPI_QR" : "ONLINE");

            const gatewayRes = p.onlinePayment?.gatewayResponse;
            const processingFee = gatewayRes?.processingFee !== undefined
                ? parseFloat(gatewayRes.processingFee)
                : 0;
            const totalPaid = gatewayRes?.totalTransactionAmount !== undefined
                ? parseFloat(gatewayRes.totalTransactionAmount)
                : parseFloat(p.amount);

            return {
                id: p.id,
                paymentCode: `PAY-${p.id.slice(0, 6).toUpperCase()}`,
                receiptNumber: p.receiptNumber || `RCPT-${p.id.slice(0, 8)}`,
                transactionId: p.transactionId || "—",
                amount: parseFloat(p.amount),
                processingFee,
                totalPaid,
                customerName: p.loan?.customer?.user?.name || "Customer",
                customerId: p.loan?.customer?.id,
                loanNumber: p.loan?.loanNumber || "—",
                installmentNo: p.emi?.installmentNo ? `#0${p.emi.installmentNo}` : "—",
                mode: modeDisplay,
                modeKey,
                date: new Date(p.paidAt || p.createdAt).toLocaleDateString("en-IN", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                }),
                collector: isCash ? (p.cashCollection?.agent?.user?.name || "Agent") : (isQr ? (p.onlinePayment?.gatewayResponse?.agentName || "Agent QR") : "Direct Gateway"),
                status: p.status,
            };
        });

        if (mode && mode !== "all") {
            const m = mode.toUpperCase();
            mapped = mapped.filter((p) => p.modeKey === m || p.mode.toUpperCase().includes(m));
        }

        if (search && search.trim()) {
            const q = search.trim().toLowerCase();
            mapped = mapped.filter((p) =>
                p.customerName.toLowerCase().includes(q) ||
                p.loanNumber.toLowerCase().includes(q) ||
                p.receiptNumber.toLowerCase().includes(q) ||
                p.paymentCode.toLowerCase().includes(q)
            );
        }

        return res.json({
            success: true,
            count: mapped.length,
            payments: mapped,
        });
    } catch (err) {
        console.error("Payments feed error:", err);
        return res.status(500).json({ success: false, message: "Failed to fetch payments feed" });
    }
});

/**
 * DELETE /api/admin/customers/all
 * Purges all customer data while preserving Admin and Agent users.
 */
router.delete("/all", async (req, res) => {
    try {
        await prisma.$transaction(
            async (tx) => {
                await tx.cashSettlementItem.deleteMany({});
                await tx.cashSettlement.deleteMany({});
                await tx.onlinePayment.deleteMany({});
                await tx.cashCollection.deleteMany({});
                await tx.payment.deleteMany({});
                await tx.emiSchedule.deleteMany({});
                await tx.loanAgentAssignment.deleteMany({});
                await tx.loan.deleteMany({});
                await tx.applicationDocument.deleteMany({});
                await tx.loanApplication.deleteMany({});
                await tx.kycDocument.deleteMany({});
                await tx.customerAgentAssignment.deleteMany({});
                await tx.customerProfile.deleteMany({});
                await tx.user.deleteMany({
                    where: { role: "CUSTOMER" },
                });
            },
            {
                timeout: 30000,
                maxWait: 10000,
            }
        );

        return res.json({
            success: true,
            message: "All customer data purged successfully",
        });
    } catch (err) {
        console.error("Purge all customers error:", err);
        return res.status(500).json({
            success: false,
            message: err.message || "Failed to purge customer data",
        });
    }
});

/**
 * DELETE /api/admin/customers/:id
 * Deletes a single customer with all associated loans, schedules, and payments.
 */
router.delete("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const customer = await prisma.customerProfile.findFirst({
            where: {
                OR: [{ id }, { userId: id }],
            },
            include: { user: true },
        });

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: "Customer not found",
            });
        }

        await prisma.$transaction(
            async (tx) => {
                const customerLoans = await tx.loan.findMany({
                    where: { customerId: customer.id },
                    select: { id: true },
                });
                const loanIds = customerLoans.map((l) => l.id);

                if (loanIds.length > 0) {
                    const payments = await tx.payment.findMany({
                        where: { loanId: { in: loanIds } },
                        select: { id: true },
                    });
                    const paymentIds = payments.map((p) => p.id);

                    const collections = await tx.cashCollection.findMany({
                        where: { paymentId: { in: paymentIds } },
                        select: { id: true },
                    });
                    const collectionIds = collections.map((c) => c.id);

                    if (collectionIds.length > 0) {
                        await tx.cashSettlementItem.deleteMany({
                            where: { cashCollectionId: { in: collectionIds } },
                        });
                        await tx.cashCollection.deleteMany({
                            where: { id: { in: collectionIds } },
                        });
                    }

                    if (paymentIds.length > 0) {
                        await tx.onlinePayment.deleteMany({
                            where: { paymentId: { in: paymentIds } },
                        });
                        await tx.payment.deleteMany({
                            where: { id: { in: paymentIds } },
                        });
                    }

                    await tx.emiSchedule.deleteMany({
                        where: { loanId: { in: loanIds } },
                    });
                    await tx.loanAgentAssignment.deleteMany({
                        where: { loanId: { in: loanIds } },
                    });
                    await tx.loan.deleteMany({
                        where: { id: { in: loanIds } },
                    });
                }

                await tx.applicationDocument.deleteMany({
                    where: { application: { customerId: customer.id } },
                });
                await tx.loanApplication.deleteMany({
                    where: { customerId: customer.id },
                });
                await tx.kycDocument.deleteMany({
                    where: { customerId: customer.id },
                });
                await tx.customerAgentAssignment.deleteMany({
                    where: { customerId: customer.id },
                });
                await tx.customerProfile.delete({
                    where: { id: customer.id },
                });
                await tx.user.delete({
                    where: { id: customer.userId },
                });
            },
            {
                timeout: 30000,
                maxWait: 10000,
            }
        );

        return res.json({
            success: true,
            message: `Customer ${customer.user?.name || ""} deleted successfully`,
        });
    } catch (err) {
        console.error("Delete customer error:", err);
        return res.status(500).json({
            success: false,
            message: err.message || "Failed to delete customer",
        });
    }
});

module.exports = router;
