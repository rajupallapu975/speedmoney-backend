const express = require("express");
const { Prisma } = require("@prisma/client");
const { randomUUID } = require("crypto");

const prisma = require("../lib/prisma");
const { authenticateToken } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");
const {
    isProofStorageConfigured,
    verifyAndStoreDisbursementProof,
} = require("../services/disbursement-storage");

const router = express.Router();

function addMonths(date, months) {
    const result = new Date(date);
    const originalDay = result.getDate();

    result.setDate(1);
    result.setMonth(result.getMonth() + months);

    const lastDayOfMonth = new Date(
        result.getFullYear(),
        result.getMonth() + 1,
        0
    ).getDate();

    result.setDate(Math.min(originalDay, lastDayOfMonth));
    return result;
}

/**
 * Helper to calculate EMI schedule and terms for a given principal, rate, tenure, and start date.
 */
function calculateEmiSchedule(principal, annualInterestRate, tenureMonths, startDate, frequency = "MONTHLY") {
    const is15Days = frequency === "15_DAYS" || frequency === "15-Day";
    const totalPeriods = is15Days ? tenureMonths * 2 : tenureMonths;
    const periodRate = is15Days ? annualInterestRate.div(2400) : annualInterestRate.div(1200);
    const onePlusRate = new Prisma.Decimal(1).plus(periodRate);
    const power = onePlusRate.pow(totalPeriods);

    let emiAmount;
    if (periodRate.eq(0)) {
        emiAmount = principal.div(totalPeriods);
    } else {
        emiAmount = principal
            .mul(periodRate)
            .mul(power)
            .div(power.minus(1));
    }
    emiAmount = emiAmount.toDecimalPlaces(2);

    let outstanding = principal;
    let totalInterest = new Prisma.Decimal(0);
    const emiRecords = [];

    for (let installmentNo = 1; installmentNo <= totalPeriods; installmentNo++) {
        let dueDate;
        if (is15Days) {
            dueDate = new Date(startDate.getTime() + installmentNo * 15 * 86400000);
        } else {
            dueDate = addMonths(startDate, installmentNo);
        }

        let interestAmount = outstanding.mul(periodRate).toDecimalPlaces(2);
        let principalAmount;
        let currentEmi = emiAmount;

        // Final EMI adjustment
        if (installmentNo === totalPeriods) {
            principalAmount = outstanding;
            currentEmi = principalAmount.plus(interestAmount).toDecimalPlaces(2);
        } else {
            principalAmount = currentEmi.minus(interestAmount).toDecimalPlaces(2);

            if (principalAmount.gt(outstanding)) {
                principalAmount = outstanding;
                currentEmi = principalAmount.plus(interestAmount).toDecimalPlaces(2);
            }
        }

        outstanding = outstanding.minus(principalAmount).toDecimalPlaces(2);
        totalInterest = totalInterest.plus(interestAmount).toDecimalPlaces(2);

        emiRecords.push({
            installmentNo,
            dueDate,
            principalAmount,
            interestAmount,
            emiAmount: currentEmi,
            paidAmount: new Prisma.Decimal(0),
            outstandingAmount: currentEmi,
            status: "PENDING",
        });
    }

    const totalPayable = principal.plus(totalInterest).toDecimalPlaces(2);

    return {
        emiAmount,
        totalInterest,
        totalPayable,
        emiRecords,
    };
}

// =========================================================================
// 1. CREATE LOAN FROM APPROVED APPLICATION (PENDING_DISBURSEMENT)
// =========================================================================
router.post(
    "/:id/create-loan",
    authenticateToken,
    authorizeRoles("ADMIN"),
    async (req, res) => {
        try {
            const { id } = req.params;

            const application = await prisma.loanApplication.findUnique({
                where: { id },
                include: {
                    product: true,
                    loan: true,
                },
            });

            if (!application) {
                return res.status(404).json({
                    success: false,
                    message: "Loan application not found",
                });
            }

            // 1. Application must be approved first
            if (application.status !== "APPROVED") {
                return res.status(400).json({
                    success: false,
                    message: "Only approved applications can be converted into loans",
                    currentStatus: application.status,
                });
            }

            // 2. Prevent duplicate loan creation
            if (application.loan) {
                return res.status(409).json({
                    success: false,
                    message: "A loan has already been created for this application",
                    loan: {
                        id: application.loan.id,
                        loanNumber: application.loan.loanNumber,
                        status: application.loan.status,
                    },
                });
            }

            // 3. Approved application must have an interest rate
            if (!application.interestRate) {
                return res.status(400).json({
                    success: false,
                    message: "Approved application does not have an interest rate",
                });
            }

            const principal = new Prisma.Decimal(application.requestedAmount);
            const annualInterestRate = new Prisma.Decimal(application.interestRate);
            const tenureMonths = application.requestedTenure;

            if (principal.lte(0)) {
                return res.status(400).json({
                    success: false,
                    message: "Loan principal must be greater than zero",
                });
            }

            if (!Number.isInteger(tenureMonths) || tenureMonths <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Loan tenure must be a positive whole number",
                });
            }

            // 4. Calculate approved repayment terms (without starting repayment clock)
            // Use dummy date purely for loan-level term projections
            const { emiAmount, totalInterest, totalPayable } = calculateEmiSchedule(
                principal,
                annualInterestRate,
                tenureMonths,
                new Date()
            );

            const loanNumber = `LN-${new Date().getFullYear()}-${randomUUID()
                .slice(0, 8)
                .toUpperCase()}`;

            // 5. Create loan in PENDING_DISBURSEMENT status atomically
            // NO EMI records are created; repayment clock has NOT started.
            const loan = await prisma.$transaction(async (tx) => {
                const createdLoan = await tx.loan.create({
                    data: {
                        customerId: application.customerId,
                        applicationId: application.id,
                        loanNumber,
                        principalAmount: principal,
                        interestRate: annualInterestRate,
                        tenureMonths,
                        emiAmount,
                        totalInterest,
                        totalPayable,
                        outstandingAmount: new Prisma.Decimal(0), // ₹0 owed prior to actual disbursement
                        startDate: null, // Repayment clock not started
                        endDate: null,
                        disbursedAt: null,
                        disbursementReference: null,
                        disbursementProofUrl: null,
                        status: "PENDING_DISBURSEMENT",
                    },
                });

                await tx.auditLog.create({
                    data: {
                        userId: req.user.userId,
                        action: "CREATE",
                        entity: "Loan",
                        entityId: createdLoan.id,
                        description:
                            "Loan created in PENDING_DISBURSEMENT status from approved application",
                        metadata: {
                            applicationId: application.id,
                            loanNumber: createdLoan.loanNumber,
                            principalAmount: principal.toString(),
                            interestRate: annualInterestRate.toString(),
                            tenureMonths,
                            emiAmount: emiAmount.toString(),
                            status: "PENDING_DISBURSEMENT",
                        },
                    },
                });

                return createdLoan;
            });

            return res.status(201).json({
                success: true,
                message: "Loan created successfully in PENDING_DISBURSEMENT status",
                loan: {
                    id: loan.id,
                    loanNumber: loan.loanNumber,
                    principalAmount: loan.principalAmount.toString(),
                    interestRate: loan.interestRate.toString(),
                    tenureMonths: loan.tenureMonths,
                    emiAmount: loan.emiAmount.toString(),
                    totalInterest: loan.totalInterest.toString(),
                    totalPayable: loan.totalPayable.toString(),
                    outstandingAmount: loan.outstandingAmount.toString(),
                    startDate: null,
                    endDate: null,
                    disbursedAt: null,
                    disbursementReference: null,
                    disbursementProofUrl: null,
                    status: loan.status,
                    emiCount: 0,
                },
                emiSchedule: [],
            });
        } catch (error) {
            console.error("Create loan error:", error);

            if (error.code === "P2002") {
                return res.status(409).json({
                    success: false,
                    message: "A loan has already been created for this application",
                });
            }

            return res.status(500).json({
                success: false,
                message: "Failed to create loan",
            });
        }
    }
);

// =========================================================================
// 2. DISBURSE LOAN (VERIFIED DISBURSEMENT & ACTIVATION)
// =========================================================================
router.post(
    "/:id/disburse",
    authenticateToken,
    authorizeRoles("ADMIN"),
    async (req, res) => {
        try {
            const { id } = req.params;
            const {
                disbursementReference,
                disbursedAt,
                proof,
            } = req.body;

            // 1. Find loan by loan ID or application ID
            const loan = await prisma.loan.findFirst({
                where: {
                    OR: [{ id }, { applicationId: id }],
                },
                include: {
                    application: true,
                    emis: true,
                },
            });

            if (!loan) {
                return res.status(404).json({
                    success: false,
                    message: "Loan record not found",
                });
            }

            // 2. Idempotency / Duplicate disbursement check
            if (loan.status === "ACTIVE") {
                return res.status(409).json({
                    success: false,
                    message: "Loan has already been disbursed and is currently active",
                    loan: {
                        id: loan.id,
                        loanNumber: loan.loanNumber,
                        status: loan.status,
                        disbursedAt: loan.disbursedAt,
                        disbursementReference: loan.disbursementReference,
                    },
                });
            }

            // 3. Status transition guard: only PENDING_DISBURSEMENT loans can be disbursed
            if (loan.status !== "PENDING_DISBURSEMENT") {
                return res.status(400).json({
                    success: false,
                    message: `Only loans in PENDING_DISBURSEMENT status can be disbursed (current status: ${loan.status})`,
                });
            }

            // 4. Validate transfer reference
            if (!disbursementReference || !String(disbursementReference).trim()) {
                return res.status(400).json({
                    success: false,
                    message: "Transfer reference (e.g. UTR / NEFT / IMPS reference) is required for disbursement",
                });
            }

            const cleanReference = String(disbursementReference).trim();
            if (cleanReference.length < 3) {
                return res.status(400).json({
                    success: false,
                    message: "Transfer reference must be at least 3 characters",
                });
            }

            // 5. Validate disbursement timestamp
            let disbursementDate = new Date();
            if (disbursedAt) {
                const parsedDate = new Date(disbursedAt);
                if (isNaN(parsedDate.getTime())) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid disbursement timestamp format",
                    });
                }
                // Disallow future disbursement dates
                if (parsedDate.getTime() > Date.now() + 60000) {
                    return res.status(400).json({
                        success: false,
                        message: "Disbursement date cannot be in the future",
                    });
                }
                disbursementDate = parsedDate;
            }

            // 6. Verify and store durable proof of transfer
            let storedProof;
            try {
                storedProof = await verifyAndStoreDisbursementProof(proof, loan.id);
            } catch (proofErr) {
                return res.status(proofErr.statusCode || 400).json({
                    success: false,
                    message: proofErr.message,
                    code: proofErr.code || "PROOF_VERIFICATION_FAILED",
                });
            }

            // 7. Calculate real EMI schedule starting from actual disbursement date
            const principal = new Prisma.Decimal(loan.principalAmount);
            const annualInterestRate = new Prisma.Decimal(loan.interestRate);
            const tenureMonths = loan.tenureMonths;

            const { emiAmount, totalInterest, totalPayable, emiRecords } =
                calculateEmiSchedule(
                    principal,
                    annualInterestRate,
                    tenureMonths,
                    disbursementDate
                );

            const endDate = addMonths(disbursementDate, tenureMonths);

            // 8. Atomic database transaction: activate loan, persist EMIs, record audit log
            const result = await prisma.$transaction(async (tx) => {
                // Ensure loan has not changed status concurrently
                const lockedLoan = await tx.loan.findUnique({
                    where: { id: loan.id },
                });

                if (lockedLoan.status !== "PENDING_DISBURSEMENT") {
                    throw new Error(`Concurrent status conflict: loan is already ${lockedLoan.status}`);
                }

                const updatedLoan = await tx.loan.update({
                    where: { id: loan.id },
                    data: {
                        status: "ACTIVE",
                        startDate: disbursementDate,
                        endDate,
                        disbursedAt: disbursementDate,
                        disbursementReference: cleanReference,
                        disbursementProofUrl: storedProof.storageReference,
                        emiAmount,
                        totalInterest,
                        totalPayable,
                        outstandingAmount: totalPayable, // Full debt becomes active upon disbursement
                        emis: {
                            create: emiRecords,
                        },
                    },
                    include: {
                        emis: {
                            orderBy: { installmentNo: "asc" },
                        },
                    },
                });

                await tx.auditLog.create({
                    data: {
                        userId: req.user.userId,
                        action: "APPROVE",
                        entity: "Loan",
                        entityId: updatedLoan.id,
                        description: `Loan ${updatedLoan.loanNumber} disbursed and activated with transfer ref: ${cleanReference}`,
                        metadata: {
                            disbursementReference: cleanReference,
                            disbursedAt: disbursementDate.toISOString(),
                            proofUrl: storedProof.storageReference,
                            principalAmount: principal.toString(),
                            emiAmount: emiAmount.toString(),
                            emiCount: updatedLoan.emis.length,
                        },
                    },
                });

                return updatedLoan;
            });

            return res.status(200).json({
                success: true,
                message: "Loan disbursed and activated successfully",
                loan: {
                    id: result.id,
                    loanNumber: result.loanNumber,
                    principalAmount: result.principalAmount.toString(),
                    interestRate: result.interestRate.toString(),
                    tenureMonths: result.tenureMonths,
                    emiAmount: result.emiAmount.toString(),
                    totalInterest: result.totalInterest.toString(),
                    totalPayable: result.totalPayable.toString(),
                    outstandingAmount: result.outstandingAmount.toString(),
                    startDate: result.startDate,
                    endDate: result.endDate,
                    disbursedAt: result.disbursedAt,
                    disbursementReference: result.disbursementReference,
                    disbursementProofUrl: result.disbursementProofUrl,
                    status: result.status,
                    emiCount: result.emis.length,
                },
                emiSchedule: result.emis.map((emi) => ({
                    id: emi.id,
                    installmentNo: emi.installmentNo,
                    dueDate: emi.dueDate,
                    principalAmount: emi.principalAmount.toString(),
                    interestAmount: emi.interestAmount.toString(),
                    emiAmount: emi.emiAmount.toString(),
                    paidAmount: emi.paidAmount.toString(),
                    outstandingAmount: emi.outstandingAmount.toString(),
                    status: emi.status,
                })),
            });
        } catch (error) {
            console.error("Disburse loan error:", error);

            if (error.message && error.message.includes("Concurrent status conflict")) {
                return res.status(409).json({
                    success: false,
                    message: error.message,
                });
            }

            return res.status(500).json({
                success: false,
                message: "Failed to disburse loan",
            });
        }
    }
);

module.exports = router;