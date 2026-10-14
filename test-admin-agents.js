require("dotenv").config();

const jwt = require("jsonwebtoken");

async function testAdminAgents() {
    try {
        // Generate a temporary admin token for local testing.
        // This does not create or modify an admin account.
        const token = jwt.sign(
            {
                userId: "admin-route-test",
                role: "ADMIN",
            },
            process.env.JWT_SECRET,
            {
                expiresIn: "5m",
            }
        );

        const response = await fetch(
            "http://localhost:5000/api/admin/agents",
            {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            }
        );

        const result = await response.json();

        console.log("HTTP STATUS:", response.status);
        console.log(JSON.stringify(result, null, 2));
    } catch (error) {
        console.error("ADMIN AGENT TEST FAILED:", error.message);
    }
}

testAdminAgents();