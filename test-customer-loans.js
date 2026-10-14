require("dotenv").config();

const jwt = require("jsonwebtoken");
const prisma = require("./lib/prisma");

async function testCustomerLoans() {
    try {
        // Find a customer who already has a loan
        const loan = await prisma.loan.findFirst({
            include: {
                customer: {
                    include: {
                        user: true,
                    },
                },
            },
        });

        if (!loan) {
            console.log("NO CUSTOMER LOAN FOUND");
            return;
        }

        const customerUser = loan.customer.user;

        console.log(
            "TEST CUSTOMER:",
            customerUser.email
        );

        // Generate a temporary customer JWT
        const token = jwt.sign(
            {
                userId: customerUser.id,
                role: "CUSTOMER",
            },
            process.env.JWT_SECRET,
            {
                expiresIn: "10m",
            }
        );

        // Call customer loans API
        const response = await fetch(
            "http://localhost:5000/api/customer/loans",
            {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            }
        );

        const data = await response.json();

        console.log(
            "CUSTOMER LOANS STATUS:",
            response.status
        );

        console.log(
            "LOAN COUNT:",
            data.count
        );

        if (response.ok && data.success) {
            console.log(
                "CUSTOMER LOANS API SUCCESSFUL"
            );

            if (data.count > 0) {
                const customerLoan = data.loans[0];

                console.log(
                    "LOAN NUMBER:",
                    customerLoan.loanNumber
                );

                console.log(
                    "PRINCIPAL:",
                    customerLoan.principalAmount
                );

                console.log(
                    "INTEREST RATE:",
                    customerLoan.interestRate
                );

                console.log(
                    "TENURE:",
                    customerLoan.tenureMonths
                );

                console.log(
                    "EMI:",
                    customerLoan.emiAmount
                );

                console.log(
                    "LOAN STATUS:",
                    customerLoan.status
                );

                console.log(
                    "EMI COUNT:",
                    customerLoan.emiSchedule.length
                );
            }
        } else {
            console.log(
                "CUSTOMER LOANS API FAILED"
            );

            console.log(data);
        }
    } catch (error) {
        console.error(
            "CUSTOMER LOAN TEST FAILED"
        );

        console.error(error);
    } finally {
        await prisma.$disconnect();
    }
}

testCustomerLoans();