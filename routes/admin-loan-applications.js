const express = require("express");

const prisma = require("../lib/prisma");
const { authenticateToken } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");

const router = express.Router();

// GET ALL LOAN APPLICATIONS FOR ADMIN
router.get(
    "/",
    authenticateToken,
    authorizeRoles("ADMIN"),
    async (req, res) => {
        try {
            const applications = await prisma.loanApplication.findMany({
                include: {
                    customer: {
                        include: {
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
                    product: true,
                    loan: true,
                },
                orderBy: {
                    createdAt: "desc",
                },
            });

            return res.status(200).json({
                success: true,
                count: applications.length,
                applications: applications.map((application) => ({
                    id: application.id,

                    customer: {
                        id: application.customer.id,
                        name: application.customer.user.name,
                        email: application.customer.user.email,
                        phone: application.customer.user.phone,
                    },

                    product: {
                        id: application.product.id,
                        name: application.product.name,
                    },

                    requestedAmount:
                        application.requestedAmount.toString(),

                    requestedTenure:
                        application.requestedTenure,

                    interestRate:
                        application.interestRate
                            ? application.interestRate.toString()
                            : null,

                    purpose:
                        application.purpose,

                    status:
                        application.status,

                    rejectionReason:
                        application.rejectionReason,

                    reviewNotes:
                        application.reviewNotes,

                    submittedAt:
                        application.submittedAt,

                    createdAt:
                        application.createdAt,

                    loan:
                        application.loan
                            ? {
                                id: application.loan.id,
                                loanNumber:
                                    application.loan.loanNumber,
                                status:
                                    application.loan.status,
                            }
                            : null,
                })),
            });
        } catch (error) {
            console.error(
                "Get admin loan applications error:",
                error
            );

            return res.status(500).json({
                success: false,
                message: "Failed to fetch loan applications",
            });
        }
    }
);

module.exports = router;