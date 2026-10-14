const express = require("express");
const { Prisma } = require("@prisma/client");

const prisma = require("../lib/prisma");
const { authenticateToken } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");

const router = express.Router();

// ADMIN REVIEW: APPROVE OR REJECT A LOAN APPLICATION
router.patch(
    "/:id/review",
    authenticateToken,
    authorizeRoles("ADMIN"),
    async (req, res) => {
        try {
            const { id } = req.params;
            const { decision, interestRate, reviewNotes, rejectionReason } =
                req.body;

            if (!decision) {
                return res.status(400).json({
                    success: false,
                    message: "Decision is required",
                });
            }

            if (!["APPROVE", "REJECT"].includes(decision)) {
                return res.status(400).json({
                    success: false,
                    message: "Decision must be APPROVE or REJECT",
                });
            }

            const application = await prisma.loanApplication.findUnique({
                where: {
                    id,
                },
                include: {
                    product: true,
                },
            });

            if (!application) {
                return res.status(404).json({
                    success: false,
                    message: "Loan application not found",
                });
            }

            if (application.status !== "SUBMITTED") {
                return res.status(400).json({
                    success: false,
                    message:
                        "Only submitted loan applications can be reviewed",
                });
            }

            // APPROVE
            if (decision === "APPROVE") {
                if (
                    interestRate === undefined ||
                    interestRate === null ||
                    interestRate === ""
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Interest rate is required when approving an application",
                    });
                }

                let rate;

                try {
                    rate = new Prisma.Decimal(String(interestRate));
                } catch (error) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid interest rate",
                    });
                }

                if (rate.lte(0)) {
                    return res.status(400).json({
                        success: false,
                        message: "Interest rate must be greater than zero",
                    });
                }

                if (rate.lt(application.product.minInterestRate)) {
                    return res.status(400).json({
                        success: false,
                        message:
                            `Interest rate cannot be below ${application.product.minInterestRate.toString()}%`,
                    });
                }

                if (rate.gt(application.product.maxInterestRate)) {
                    return res.status(400).json({
                        success: false,
                        message:
                            `Interest rate cannot exceed ${application.product.maxInterestRate.toString()}%`,
                    });
                }

                const updatedApplication =
                    await prisma.loanApplication.update({
                        where: {
                            id,
                        },
                        data: {
                            status: "APPROVED",
                            interestRate: rate,
                            reviewNotes: reviewNotes
                                ? reviewNotes.trim()
                                : null,
                            rejectionReason: null,
                        },
                        include: {
                            product: true,
                        },
                    });

                return res.status(200).json({
                    success: true,
                    message: "Loan application approved successfully",
                    application: {
                        id: updatedApplication.id,
                        status: updatedApplication.status,
                        productName:
                            updatedApplication.product.name,
                        requestedAmount:
                            updatedApplication.requestedAmount.toString(),
                        requestedTenure:
                            updatedApplication.requestedTenure,
                        interestRate:
                            updatedApplication.interestRate.toString(),
                        reviewNotes:
                            updatedApplication.reviewNotes,
                    },
                });
            }

            // REJECT
            if (!rejectionReason || !rejectionReason.trim()) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Rejection reason is required when rejecting an application",
                });
            }

            const updatedApplication =
                await prisma.loanApplication.update({
                    where: {
                        id,
                    },
                    data: {
                        status: "REJECTED",
                        rejectionReason: rejectionReason.trim(),
                        reviewNotes: reviewNotes
                            ? reviewNotes.trim()
                            : null,
                    },
                    include: {
                        product: true,
                    },
                });

            return res.status(200).json({
                success: true,
                message: "Loan application rejected successfully",
                application: {
                    id: updatedApplication.id,
                    status: updatedApplication.status,
                    productName:
                        updatedApplication.product.name,
                    requestedAmount:
                        updatedApplication.requestedAmount.toString(),
                    requestedTenure:
                        updatedApplication.requestedTenure,
                    rejectionReason:
                        updatedApplication.rejectionReason,
                    reviewNotes:
                        updatedApplication.reviewNotes,
                },
            });
        } catch (error) {
            console.error(
                "Admin loan application review error:",
                error
            );

            return res.status(500).json({
                success: false,
                message: "Failed to review loan application",
            });
        }
    }
);

module.exports = router;