async function testMe() {
  // Step 1: Login
  const loginResponse = await fetch(
    "http://localhost:5000/api/auth/login",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "testcustomer@example.com",
        password: "TestPassword123!",
      }),
    }
  );

  const loginData = await loginResponse.json();

  console.log("Login status:", loginResponse.status);

  if (!loginData.success) {
    console.log(JSON.stringify(loginData, null, 2));
    return;
  }

  // Step 2: Use JWT to access /me
  const meResponse = await fetch(
    "http://localhost:5000/api/auth/me",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${loginData.token}`,
      },
    }
  );

  const meData = await meResponse.json();

  console.log("ME status:", meResponse.status);
  console.log(JSON.stringify(meData, null, 2));
}

testMe().catch(console.error);