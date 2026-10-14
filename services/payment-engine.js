const crypto = require("crypto");
const { Prisma } = require("@prisma/client");
const prisma = require("../lib/prisma");

const Decimal = Prisma.Decimal;

function toDecimal(value) {
    if (value instanceof Decimal) {
        return value;
    }
    return new Decimal(String(value));
}

function generateReceiptNumber() {
    const timestamp = Date.now();
    const random = crypto.randomBytes(3).toString("hex").toUpperCase();

    return `RCPT-${timestamp}-${random}`;
}

/**
 * Validates whether an amount is a finite, positive monetary amount
 * with at most two decimal places.
 */
function parseAndValidateMoney(value) {
    if (value === undefined || value === null || value === "") {
        throw new Error("Amount is required");
    }

    const str = String(value).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(str)) {
        throw new Error(
            "Amount must be a finite positive number with at most 2 decimal places"
        );
    }

    const decimalValue = new Decimal(str);
    if (decimalValue.lte(0)) {
        throw new Error("Amount must be greater than zero");
    }

    return decimalValue;
}

/**
 * Apply a successful payment to an EMI.
 *
 * This is the central payment engine for the platform.
 *
 * It supports:
 * - Full EMI payment
 * - Partial EMI payment
 * - Online payment
 * - Cash payment
 *
 * Database changes are performed atomically at SERIALIZABLE isolation level.
 */
async function applyPaymentToEmi({
    emiId,
    loanId,
    amount,
    mode,
    transactionId = null,
    receiptNumber = null,
    notes = null,
    agentId = null,
    onlinePaymentData = null,
    cashCollectionData = null,
    userId = null,
    ipAddress = null,
}) {
    const paymentAmount = parseAndValidateMoney(amount);

    if (!["ONLINE", "CASH"].includes(mode)) {
        throw new Error("Invalid payment mode");
    }

    return prisma.$transaction(
        async (tx) => {
            /*
             * Lock rows by running the transaction at SERIALIZABLE
             * isolation. This prevents concurrent payment requests
             * from incorrectly updating the same EMI or over-collecting.
             */

            const emi = await tx.emiSchedule.findUnique({
                where: {
                    id: emiId,
                },
            });

            if (!emi) {
                throw new Error("EMI not found");
            }

            if (emi.loanId !== loanId) {
                throw new Error("EMI does not belong to this loan");
            }

            const loan = await tx.loan.findUnique({
                where: {
                    id: loanId,
                },
            });

            if (!loan) {
                throw new Error("Loan not found");
            }

            if (!["ACTIVE", "OVERDUE"].includes(loan.status)) {
                throw new Error(
                    `Loan is not eligible for payment (current status: ${loan.status})`
                );
            }

            if (emi.status === "PAID") {
                throw new Error("This EMI is already fully paid");
            }

            if (emi.status === "WAIVED") {
                throw new Error("This EMI has been waived and cannot be paid");
            }

            if (!["PENDING", "PARTIAL", "OVERDUE"].includes(emi.status)) {
                throw new Error(
                    `This EMI is not eligible for payment (current status: ${emi.status})`
                );
            }

            const emiOutstanding = new Decimal(emi.outstandingAmount);

            if (emiOutstanding.lte(0)) {
                throw new Error("This EMI is already fully paid");
            }

            const loanOutstanding = new Decimal(loan.outstandingAmount);
            if (paymentAmount.gt(loanOutstanding)) {
                throw new Error(
                    `Payment amount cannot exceed loan outstanding amount of ₹${loanOutstanding.toFixed(
                        2
                    )}`
                );
            }

            /*
             * Prevent duplicate transactions via database unique transactionId.
             */
            if (transactionId) {
                const existingPayment = await tx.payment.findUnique({
                    where: {
                        transactionId,
                    },
                    include: {
                        cashCollection: true,
                        onlinePayment: true,
                    },
                });

                if (existingPayment) {
                    // Verify if this is an identical retry
                    const isSamePayment =
                        existingPayment.loanId === loanId &&
                        existingPayment.emiId === emiId &&
                        new Decimal(existingPayment.amount).equals(paymentAmount);

                    if (isSamePayment) {
                        return {
                            duplicate: true,
                            payment: existingPayment,
                            emi,
                            loan,
                            cashCollection: existingPayment.cashCollection || null,
                        };
                    } else {
                        throw new Error(
                            "Transaction ID already exists with different payment details"
                        );
                    }
                }
            }

            /*
             * Calculate the new EMI state using exact Decimal arithmetic.
             * If paymentAmount < emiOutstanding, the unpaid shortfall is rolled forward
             * and added to the next EMI's due amount.
             */
            const currentPaidAmount = new Decimal(emi.paidAmount);
            const emiTotalAmount = new Decimal(emi.emiAmount);
            let shortfall = null;
            let excess = null;
            let updatedNextEmiRecord = null;

            // Find next sequential EMI if available
            const nextEmi = await tx.emiSchedule.findFirst({
                where: {
                    loanId,
                    installmentNo: emi.installmentNo + 1,
                },
            });

            let newPaidAmount = currentPaidAmount.plus(paymentAmount);
            let newOutstandingAmount = emiTotalAmount.minus(newPaidAmount);
            let emiStatus = "PARTIAL";

            if (paymentAmount.lt(emiOutstanding)) {
                shortfall = emiOutstanding.minus(paymentAmount);
                if (nextEmi) {
                    // Roll shortfall forward to next EMI:
                    // Increase next EMI's emiAmount and outstandingAmount by shortfall
                    const nextEmiAmount = new Decimal(nextEmi.emiAmount).plus(shortfall);
                    const nextEmiOutstanding = new Decimal(nextEmi.outstandingAmount).plus(shortfall);

                    updatedNextEmiRecord = await tx.emiSchedule.update({
                        where: { id: nextEmi.id },
                        data: {
                            emiAmount: nextEmiAmount,
                            outstandingAmount: nextEmiOutstanding,
                        },
                    });

                    // Current installment shortfall has been rolled forward,
                    // so current installment's outstanding debt is cleared
                    newOutstandingAmount = new Decimal(0);
                    emiStatus = "PAID";
                } else {
                    // Final installment of loan: shortfall stays outstanding on this EMI
                    if (newOutstandingAmount.lte(0.01)) {
                        newOutstandingAmount = new Decimal(0);
                        emiStatus = "PAID";
                    }
                }
            } else if (paymentAmount.gte(emiOutstanding)) {
                excess = paymentAmount.minus(emiOutstanding);
                newOutstandingAmount = new Decimal(0);
                emiStatus = "PAID";

                if (excess.gt(0) && nextEmi) {
                    // Credit excess to next EMI's outstanding balance
                    let nextOutstanding = new Decimal(nextEmi.outstandingAmount).minus(excess);
                    let nextPaid = new Decimal(nextEmi.paidAmount).plus(excess);
                    let nextStatus = nextEmi.status;

                    if (nextOutstanding.lte(0.01)) {
                        nextOutstanding = new Decimal(0);
                        nextStatus = "PAID";
                    } else {
                        nextStatus = "PARTIAL";
                    }

                    updatedNextEmiRecord = await tx.emiSchedule.update({
                        where: { id: nextEmi.id },
                        data: {
                            outstandingAmount: nextOutstanding,
                            paidAmount: nextPaid,
                            status: nextStatus,
                        },
                    });
                }
            }

            /*
             * Calculate new Loan outstanding balance.
             */
            let newLoanOutstanding = loanOutstanding.minus(paymentAmount);
            if (newLoanOutstanding.lte(0.01)) {
                newLoanOutstanding = new Decimal(0);
            }

            const now = new Date();

            /*
             * Generate a unique receipt number for every successful payment.
             */
            const finalReceiptNumber =
                receiptNumber || generateReceiptNumber();

            /*
             * Create the central payment record.
             */
            const payment = await tx.payment.create({
                data: {
                    loanId,
                    emiId,
                    amount: paymentAmount,
                    mode,
                    status: "SUCCESS",
                    transactionId,
                    receiptNumber: finalReceiptNumber,
                    paidAt: now,
                },
            });

            /*
             * Update EMI schedule.
             */
            const updatedEmi = await tx.emiSchedule.update({
                where: {
                    id: emiId,
                },
                data: {
                    paidAmount: newPaidAmount,
                    outstandingAmount: newOutstandingAmount,
                    status: emiStatus,
                    paidAt: emiStatus === "PAID" ? now : emi.paidAt,
                },
            });

            /*
             * Update Loan balance.
             */
            const updatedLoan = await tx.loan.update({
                where: {
                    id: loanId,
                },
                data: {
                    outstandingAmount: newLoanOutstanding,
                    ...(newLoanOutstanding.isZero() ? { status: "COMPLETED" } : {}),
                },
            });

            /*
             * Create online-payment specific record.
             */
            if (mode === "ONLINE") {
                if (!onlinePaymentData) {
                    throw new Error("Online payment details are required");
                }

                await tx.onlinePayment.create({
                    data: {
                        paymentId: payment.id,
                        cashfreeOrderId: onlinePaymentData.cashfreeOrderId,
                        cashfreePaymentId:
                            onlinePaymentData.cashfreePaymentId || null,
                        paymentSessionId:
                            onlinePaymentData.paymentSessionId || null,
                        gatewayResponse:
                            onlinePaymentData.gatewayResponse || null,
                    },
                });
            }

            /*
             * Create cash-collection specific record.
             */
            let cashCollection = null;
            if (mode === "CASH") {
                if (!agentId) {
                    throw new Error("Agent ID is required for cash collection");
                }

                cashCollection = await tx.cashCollection.create({
                    data: {
                        paymentId: payment.id,
                        agentId,
                        receiptNumber: finalReceiptNumber,
                        collectedAmount: paymentAmount,
                        collectedAt: now,
                        notes,
                        reconciled: false,
                    },
                });
            }

            /*
             * Record AuditLog entry atomically within the same transaction.
             */
            if (userId) {
                await tx.auditLog.create({
                    data: {
                        userId,
                        action: mode === "CASH" ? "COLLECTION" : "PAYMENT",
                        entity: mode === "CASH" ? "CashCollection" : "Payment",
                        entityId: mode === "CASH" && cashCollection ? cashCollection.id : payment.id,
                        description:
                            mode === "CASH"
                                ? `Cash collection of ₹${paymentAmount.toFixed(
                                      2
                                  )} recorded for Loan ${
                                      loan.loanNumber
                                  }, EMI #${emi.installmentNo}`
                                : `Payment of ₹${paymentAmount.toFixed(
                                      2
                                  )} recorded for Loan ${
                                      loan.loanNumber
                                  }, EMI #${emi.installmentNo}`,
                        metadata: {
                            loanId,
                            loanNumber: loan.loanNumber,
                            emiId,
                            installmentNo: emi.installmentNo,
                            paymentId: payment.id,
                            receiptNumber: finalReceiptNumber,
                            amount: paymentAmount.toFixed(2),
                            mode,
                            shortfallRolled: shortfall ? shortfall.toFixed(2) : null,
                            excessCredited: excess ? excess.toFixed(2) : null,
                            ...(agentId ? { agentId } : {}),
                            ...(notes ? { notes } : {}),
                        },
                        ipAddress: ipAddress || null,
                    },
                });
            }

            return {
                duplicate: false,
                payment,
                emi: updatedEmi,
                loan: updatedLoan,
                cashCollection,
                shortfallRolled: shortfall ? shortfall.toString() : null,
                excessCredited: excess ? excess.toString() : null,
                nextEmi: updatedNextEmiRecord,
            };
        },
        {
            isolationLevel: "Serializable",
        }
    );
}

/**
 * Retry helper for PostgreSQL serializable transaction conflicts.
 */
async function applyPaymentWithRetry(params, maxRetries = 3, baseDelayMs = 50) {
    let attempt = 0;
    while (true) {
        try {
            return await applyPaymentToEmi(params);
        } catch (error) {
            attempt++;
            const isSerializationError =
                error.code === "P2034" ||
                (error.message && (
                    error.message.includes("could not serialize access") ||
                    error.message.includes("deadlock detected") ||
                    error.message.includes("Transaction failed due to a write conflict")
                ));

            if (isSerializationError && attempt < maxRetries) {
                const jitter = Math.floor(Math.random() * 30);
                const delay = baseDelayMs * Math.pow(2, attempt - 1) + jitter;
                await new Promise((resolve) => setTimeout(resolve, delay));
                continue;
            }
            throw error;
        }
    }
}

module.exports = {
    applyPaymentToEmi,
    applyPaymentWithRetry,
    generateReceiptNumber,
    parseAndValidateMoney,
    toDecimal,
};