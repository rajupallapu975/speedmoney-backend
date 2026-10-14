async function testApplication() {
  // 1. Login as the test customer
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

  const token = loginData.token;

  // 2. Get available loan products
  const productsResponse = await fetch(
    "http://localhost:5000/api/loan-products"
  );

  const productsData = await productsResponse.json();

  console.log("Products status:", productsResponse.status);

  if (!productsData.success || productsData.products.length === 0) {
    console.log("No loan products available");
    return;
  }

  // Use the first product for this test
  const product = productsData.products[0];

  console.log("Testing product:", product.name);

  // 3. Submit loan application
  const applicationResponse = await fetch(
    "http://localhost:5000/api/loan-applications",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        productId: product.id,
        requestedAmount: 25000,
        requestedTenure: 12,
        purpose: "Agricultural working capital",
      }),
    }
  );

  const applicationData = await applicationResponse.json();

  console.log(
    "Application status:",
    applicationResponse.status
  );

  console.log(
    JSON.stringify(applicationData, null, 2)
  );
}

testApplication().catch(console.error);