async function login() {
  const response = await fetch("http://localhost:5000/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: "testcustomer@example.com",
      password: "TestPassword123!",
    }),
  });

  const data = await response.json();

  console.log("Status:", response.status);
  console.log(JSON.stringify(data, null, 2));
}

login().catch(console.error);
