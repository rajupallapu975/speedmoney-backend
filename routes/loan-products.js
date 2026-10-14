const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

// =====================================================
// GET ALL ACTIVE LOAN PRODUCTS
// =====================================================

router.get("/", async (req, res) => {
  try {
    const products = await prisma.loanProduct.findMany({
      where: {
        active: true,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    const formattedProducts = products.map((product) => ({
      id: product.id,
      name: product.name,
      description: product.description,

      minAmount: product.minAmount.toString(),
      maxAmount: product.maxAmount
        ? product.maxAmount.toString()
        : null,

      minInterestRate: product.minInterestRate.toString(),
      maxInterestRate: product.maxInterestRate.toString(),

      minTenureMonths: product.minTenureMonths,
      maxTenureMonths: product.maxTenureMonths,

      active: product.active,
    }));

    return res.status(200).json({
      success: true,
      count: formattedProducts.length,
      products: formattedProducts,
    });
  } catch (error) {
    console.error("Get loan products error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch loan products",
    });
  }
});

module.exports = router;