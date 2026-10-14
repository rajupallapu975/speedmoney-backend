require("dotenv").config();

const prisma = require("./lib/prisma");

const products = [
  {
    name: "Agri & Rural Allied Loan",
    description:
      "Loan for agriculture, allied agricultural activities, and rural livelihood needs.",
    minAmount: "20000",
    maxAmount: "350000",
    minInterestRate: "12",
    maxInterestRate: "28",
    minTenureMonths: 6,
    maxTenureMonths: 30,
    active: true,
  },
  {
    name: "Personal & Emergency Loan",
    description:
      "Personal loan designed for urgent and emergency financial requirements.",
    minAmount: "10000",
    maxAmount: "75000",
    minInterestRate: "15",
    maxInterestRate: "20",
    minTenureMonths: 3,
    maxTenureMonths: 12,
    active: true,
  },
  {
    name: "Loan Against Documents",
    description:
      "Loan where the final approved amount is determined through document-based assessment.",
    minAmount: "1",
    maxAmount: null,
    minInterestRate: "16",
    maxInterestRate: "18",
    minTenureMonths: 6,
    maxTenureMonths: 24,
    active: true,
  },
];

async function seedProducts() {
  try {
    for (const product of products) {
      await prisma.loanProduct.upsert({
        where: {
          name: product.name,
        },
        update: product,
        create: product,
      });

      console.log(`✓ ${product.name}`);
    }

    console.log("");
    console.log("LOAN PRODUCTS SEEDED SUCCESSFULLY");
  } catch (error) {
    console.error("Failed to seed loan products:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

seedProducts();