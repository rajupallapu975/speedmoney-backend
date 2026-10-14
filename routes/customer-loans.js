const express = require("express");

const prisma = require("../lib/prisma");
const { getResolvedCustomerProfile } = require("../lib/customer-helper");
const { authenticateToken } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");

const router = express.Router();

function formatEmi(emi) {
    return {
        id: emi.id,
        installmentNo: emi.installmentNo,
        dueDate: emi.dueDate,
        principalAmount: emi.principalAmount ? emi.principalAmount.toString() : "0",
        interestAmount: emi.interestAmount ? emi.interestAmount.toString() : "0",
        emiAmount: emi.emiAmount ? emi.emiAmount.toString() : "0",
        paidAmount: emi.paidAmount ? emi.paidAmount.toString() : "0",
        outstandingAmount: emi.outstandingAmount ? emi.outstandingAmount.toString() : "0",
        status: emi.status,
        paidAt: emi.paidAt,
    };
}

// ==========================================
// GET ALL CUSTOMER LOANS
// ==========================================

router.get(
    "/",
    authenticateToken,
    authorizeRoles("CUSTOMER"),
    async (req, res) => {
        try {
            const customer = await getResolvedCustomerProfile(req.user);

            if (!customer) {
                return res.status(401).json({
                    success: false,
                    message: "Customer profile not found or session expired. Please log in again.",
                });
            }

            const loans =
                await prisma.loan.findMany({
                    where: {
                        customerId: customer.id,
                    },
                    include: {
                        application: {
                            include: {
                                product: true,
                            },
                        },
                        emis: {
                            orderBy: {
                                installmentNo: "asc",
                            },
                        },
                    },
                    orderBy: {
                        createdAt: "desc",
                    },
                });

            return res.status(200).json({
                success: true,
                count: loans.length,

                loans: loans.map((loan) => {
                    const formattedEmis = loan.emis.map(formatEmi);
                    return {
                        id: loan.id,
                        loanNumber: loan.loanNumber,
                        principalAmount: loan.principalAmount.toString(),
                        interestRate: loan.interestRate.toString(),
                        tenureMonths: loan.tenureMonths,
                        emiAmount: loan.emiAmount.toString(),
                        totalInterest: loan.totalInterest.toString(),
                        totalPayable: loan.totalPayable.toString(),
                        outstandingAmount: loan.outstandingAmount.toString(),
                        startDate: loan.startDate,
                        endDate: loan.endDate,
                        status: loan.status,
                        product: loan.application?.product
                            ? {
                                id: loan.application.product.id,
                                name: loan.application.product.name,
                            }
                            : null,
                        emiSchedule: formattedEmis,
                        emis: formattedEmis,
                    };
                }),
            });
        } catch (error) {
            console.error(
                "Get customer loans error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to fetch customer loans",
            });
        }
    }
);

// ==========================================
// GET SINGLE CUSTOMER LOAN
// ==========================================

router.get(
    "/:loanId",
    authenticateToken,
    authorizeRoles("CUSTOMER"),
    async (req, res) => {
        try {
            const customer = await getResolvedCustomerProfile(req.user);

            if (!customer) {
                return res.status(401).json({
                    success: false,
                    message: "Customer profile not found or session expired. Please log in again.",
                });
            }

            const loan =
                await prisma.loan.findFirst({
                    where: {
                        id: req.params.loanId,
                        customerId: customer.id,
                    },
                    include: {
                        application: {
                            include: {
                                product: true,
                            },
                        },
                        emis: {
                            orderBy: {
                                installmentNo: "asc",
                            },
                        },
                    },
                });

            if (!loan) {
                return res.status(404).json({
                    success: false,
                    message: "Loan not found",
                });
            }

                    const formattedEmis = loan.emis.map(formatEmi);
                    return res.status(200).json({
                        success: true,
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
                            startDate: loan.startDate,
                            endDate: loan.endDate,
                            status: loan.status,
                            product: loan.application?.product
                                ? {
                                    id: loan.application.product.id,
                                    name: loan.application.product.name,
                                }
                                : null,
                            emiSchedule: formattedEmis,
                            emis: formattedEmis,
                        },
                    });
        } catch (error) {
            console.error(
                "Get customer loan error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to fetch customer loan",
            });
        }
    }
);

module.exports = router;