async function testAdminLogin() {
    try {
        const response = await fetch("http://localhost:5000/api/auth/login", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                email: "admin@loanplatform.com",
                password: "Admin@12345",
            }),
        });

        const data = await response.json();

        console.log("STATUS:", response.status);
        console.log("RESPONSE:", data);

        if (response.ok && data.success) {
            console.log("ADMIN LOGIN SUCCESSFUL");
            console.log("ROLE:", data.user.role);
        }
    } catch (error) {
        console.error("ADMIN LOGIN TEST FAILED");
        console.error(error);
    }
}

testAdminLogin();