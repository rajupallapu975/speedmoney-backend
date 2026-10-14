async function testAdminApprove() {
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
            console.log(loginData);
            return;
        }

        console.log("ADMIN LOGIN SUCCESSFUL");

        const token = loginData.token;

        // ==========================================
        // 2. GET APPLICATIONS
        // ==========================================

        const applicationsResponse = await fetch(
            "http://localhost:5000/api/admin/loan-applications",
            {
                method: "GET",
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

        if (applicationsData.count === 0) {
            console.log("NO APPLICATIONS FOUND");
            return;
        }

        // Use the first application
        const application =
            applicationsData.applications[0];

        console.log(
            "APPLICATION ID:",
            application.id
        );

        console.log(
            "CURRENT STATUS:",
            application.status
        );

        console.log(
            "REQUESTED AMOUNT:",
            application.requestedAmount
        );

        console.log(
            "REQUESTED TENURE:",
            application.requestedTenure
        );

        // ==========================================
        // 3. APPROVE APPLICATION
        // ==========================================

        const reviewResponse = await fetch(
            `http://localhost:5000/api/admin/loan-applications/${application.id}/review`,
            {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    decision: "APPROVE",
                    interestRate: "12",
                    reviewNotes:
                        "Application approved during initial platform testing.",
                }),
            }
        );

        const reviewData =
            await reviewResponse.json();

        console.log(
            "REVIEW STATUS:",
            reviewResponse.status
        );

        console.log(
            "REVIEW RESPONSE:",
            reviewData
        );

        if (
            reviewResponse.ok &&
            reviewData.success
        ) {
            console.log(
                "ADMIN APPROVAL SUCCESSFUL"
            );
        }
    } catch (error) {
        console.error(
            "ADMIN APPROVAL TEST FAILED"
        );

        console.error(error);
    }
}

testAdminApprove();