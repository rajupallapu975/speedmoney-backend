async function testAdminAccess() {
  // Login as the existing customer
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

  // Try accessing ADMIN-only endpoint
  const adminResponse = await fetch(
    "http://localhost:5000/api/admin/test",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${loginData.token}`,
      },
    }
  );

  const adminData = await adminResponse.json();

  console.log("Admin endpoint status:", adminResponse.status);
  console.log(JSON.stringify(adminData, null, 2));
}

testAdminAccess().catch(console.error);