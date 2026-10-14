async function testAdminApplications() {
    try {
        // 1. Login as admin
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

        console.log("LOGIN STATUS:", loginResponse.status);

        if (!loginResponse.ok || !loginData.success) {
            console.log("ADMIN LOGIN FAILED");
            console.log(loginData);
            return;
        }

        console.log("ADMIN LOGIN SUCCESSFUL");

        const token = loginData.token;

        // 2. Fetch loan applications
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

        console.log(
            "APPLICATIONS RESPONSE:",
            applicationsData
        );
    } catch (error) {
        console.error("ADMIN APPLICATION TEST FAILED");
        console.error(error);
    }
}

testAdminApplications();