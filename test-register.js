async function register() {
  const response = await fetch("http://localhost:5000/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Test Customer",
      email: "testcustomer@example.com",
      phone: "9000000001",
      password: "TestPassword123!",
    }),
  });

  const data = await response.json();

  console.log("Status:", response.status);
  console.log(JSON.stringify(data, null, 2));
}

register().catch(console.error);