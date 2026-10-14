async function testCreateLoan() {
    try {
        // ==========================================
        // 1. LOGIN AS ADMIN
        // ==========================================

        const loginResponse = await fetch(
            "http://localhost:5000/api/auth/login",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    email: "admin@loanplatform.com",
                    password: "Admin@12345",
                }),
            }
        );

        const loginData = await loginResponse.json();

        console.log(
            "ADMIN LOGIN STATUS:",
            loginResponse.status
        );

        if (!loginResponse.ok || !loginData.success) {
            console.log("ADMIN LOGIN FAILED");
            return;
        }

        console.log("ADMIN LOGIN SUCCESSFUL");

        const token = loginData.token;

        // ==========================================
        // 2. GET ADMIN APPLICATIONS
        // ==========================================

        const applicationsResponse = await fetch(
            "http://localhost:5000/api/admin/loan-applications",
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            }
        );

        const applicationsData =
            await applicationsResponse.json();

        console.log(
            "APPLICATIONS STATUS:",
            applicationsResponse.status
        );

        if (
            !applicationsResponse.ok ||
            !applicationsData.success
        ) {
            console.log(
                "FAILED TO FETCH APPLICATIONS"
            );
            console.log(applicationsData);
            return;
        }

        // Find the approved application
        const application =
            applicationsData.applications.find(
                (item) => item.status === "APPROVED"
            );

        if (!application) {
            console.log(
                "NO APPROVED APPLICATION FOUND"
            );
            return;
        }

        console.log(
            "APPROVED APPLICATION FOUND:",
            application.id
        );

        console.log(
            "AMOUNT:",
            application.requestedAmount
        );

        console.log(
            "TENURE:",
            application.requestedTenure
        );

        console.log(
            "INTEREST RATE:",
            application.interestRate
        );

        // ==========================================
        // 3. CREATE LOAN
        // ==========================================

        const createLoanResponse = await fetch(
            `http://localhost:5000/api/admin/loan-applications/${application.id}/create-loan`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
            }
        );

        const createLoanData =
            await createLoanResponse.json();

        console.log(
            "CREATE LOAN STATUS:",
            createLoanResponse.status
        );

        console.log(
            "CREATE LOAN RESPONSE:",
            createLoanData
        );

        if (
            createLoanResponse.ok &&
            createLoanData.success
        ) {
            console.log(
                "LOAN CREATION SUCCESSFUL"
            );

            console.log(
                "LOAN NUMBER:",
                createLoanData.loan.loanNumber
            );

            console.log(
                "EMI:",
                createLoanData.loan.emiAmount
            );

            console.log(
                "EMI COUNT:",
                createLoanData.loan.emiCount
            );
        }
    } catch (error) {
        console.error(
            "CREATE LOAN TEST FAILED"
        );

        console.error(error);
    }
}

testCreateLoan();