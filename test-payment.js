require("dotenv").config();

const jwt = require("jsonwebtoken");
const prisma = require("./lib/prisma");

async function testPayment() {
    try {
        // Find an existing active loan with an unpaid EMI
        const loan = await prisma.loan.findFirst({
            where: {
                status: "ACTIVE",
                emis: {
                    some: {
                        status: {
                            in: ["PENDING", "PARTIAL", "OVERDUE"],
                        },
                    },
                },
            },
            include: {
                customer: true,
                emis: {
                    where: {
                        status: {
                            in: ["PENDING", "PARTIAL", "OVERDUE"],
                        },
                    },
                    orderBy: {
                        installmentNo: "asc",
                    },
                    take: 1,
                },
            },
        });

        if (!loan) {
            throw new Error("No active loan with unpaid EMI found");
        }

        const emi = loan.emis[0];

        if (!emi) {
            throw new Error("No unpaid EMI found");
        }

        // Generate temporary JWT for the customer
        const token = jwt.sign(
            {
                userId: loan.customer.userId,
                role: "CUSTOMER",
            },
            process.env.JWT_SECRET,
            {
                expiresIn: "10m",
            }
        );

        const testAmount = 1;

        console.log("=================================");
        console.log("PAYMENT ENGINE TEST");
        console.log("=================================");
        console.log("Loan ID:", loan.id);
        console.log("EMI ID:", emi.id);
        console.log("Installment:", emi.installmentNo);
        console.log("EMI Amount:", emi.emiAmount.toString());
        console.log(
            "Current Outstanding:",
            emi.outstandingAmount.toString()
        );
        console.log("Test Payment:", testAmount);
        console.log("---------------------------------");

        const response = await fetch(
            "http://localhost:5000/api/payments/online",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    loanId: loan.id,
                    emiId: emi.id,
                    amount: testAmount,
                    cashfreeOrderId: `TEST-ORDER-${Date.now()}`,
                    cashfreePaymentId: `TEST-PAYMENT-${Date.now()}`,
                    paymentSessionId: `TEST-SESSION-${Date.now()}`,
                }),
            }
        );

        const result = await response.json();

        console.log("HTTP STATUS:", response.status);
        console.log("---------------------------------");
        console.log(JSON.stringify(result, null, 2));
        console.log("=================================");

    } catch (error) {
        console.error("PAYMENT TEST FAILED");
        console.error(error);
    } finally {
        await prisma.$disconnect();
    }
}

testPayment();