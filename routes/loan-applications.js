const express = require("express");
const { Prisma } = require("@prisma/client");

const prisma = require("../lib/prisma");
const { authenticateToken } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");

const router = express.Router();

// =====================================================
// CREATE LOAN APPLICATION
// =====================================================

router.post(
  "/",
  authenticateToken,
  authorizeRoles("CUSTOMER"),
  async (req, res) => {
    try {
      const {
        productId,
        requestedAmount,
        requestedTenure,
        purpose,
      } = req.body;

      // -------------------------------------------------
      // Basic validation
      // -------------------------------------------------

      if (
        !productId ||
        requestedAmount === undefined ||
        requestedAmount === null ||
        !requestedTenure
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Product, requested amount and requested tenure are required",
        });
      }

      // -------------------------------------------------
      // Validate amount
      // -------------------------------------------------

      let amount;

      try {
        amount = new Prisma.Decimal(String(requestedAmount));
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: "Invalid requested amount",
        });
      }

      if (amount.lte(0)) {
        return res.status(400).json({
          success: false,
          message: "Requested amount must be greater than zero",
        });
      }

      // -------------------------------------------------
      // Validate tenure
      // -------------------------------------------------

      const tenure = Number(requestedTenure);

      if (
        !Number.isInteger(tenure) ||
        tenure <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Requested tenure must be a positive whole number",
        });
      }

      // -------------------------------------------------
      // Find active loan product
      // -------------------------------------------------

      const product = await prisma.loanProduct.findFirst({
        where: {
          id: productId,
          active: true,
        },
      });

      if (!product) {
        return res.status(404).json({
          success: false,
          message: "Loan product not found or inactive",
        });
      }

      // -------------------------------------------------
      // Validate amount against product limits
      // -------------------------------------------------

      if (amount.lt(product.minAmount)) {
        return res.status(400).json({
          success: false,
          message: `Minimum loan amount for this product is ₹${product.minAmount.toString()}`,
        });
      }

      // Some products, such as Loan Against Documents,
      // may not have a fixed maximum amount.
      if (
        product.maxAmount !== null &&
        amount.gt(product.maxAmount)
      ) {
        return res.status(400).json({
          success: false,
          message: `Maximum loan amount for this product is ₹${product.maxAmount.toString()}`,
        });
      }

      // -------------------------------------------------
      // Validate tenure against product limits
      // -------------------------------------------------

      if (tenure < product.minTenureMonths) {
        return res.status(400).json({
          success: false,
          message: `Minimum tenure for this product is ${product.minTenureMonths} months`,
        });
      }

      if (tenure > product.maxTenureMonths) {
        return res.status(400).json({
          success: false,
          message: `Maximum tenure for this product is ${product.maxTenureMonths} months`,
        });
      }

      // -------------------------------------------------
      // Find customer profile
      // -------------------------------------------------

      const customer = await prisma.customerProfile.findUnique({
        where: {
          userId: req.user.userId,
        },
      });

      if (!customer) {
        return res.status(404).json({
          success: false,
          message: "Customer profile not found",
        });
      }

      // -------------------------------------------------
      // Create application
      // -------------------------------------------------

      const application = await prisma.loanApplication.create({
        data: {
          customerId: customer.id,
          productId: product.id,
          requestedAmount: amount,
          requestedTenure: tenure,
          purpose: purpose ? purpose.trim() : null,
          status: "SUBMITTED",
          submittedAt: new Date(),
        },

        include: {
          product: true,
        },
      });

      // -------------------------------------------------
      // Response
      // -------------------------------------------------

      return res.status(201).json({
        success: true,
        message: "Loan application submitted successfully",

        application: {
          id: application.id,
          productId: application.productId,
          productName: application.product.name,

          requestedAmount:
            application.requestedAmount.toString(),

          requestedTenure:
            application.requestedTenure,

          status:
            application.status,

          purpose:
            application.purpose,

          submittedAt:
            application.submittedAt,
        },
      });
    } catch (error) {
      console.error("Create loan application error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to submit loan application",
      });
    }
  }
);

// =====================================================
// GET MY LOAN APPLICATIONS
// =====================================================

router.get(
  "/my",
  authenticateToken,
  authorizeRoles("CUSTOMER"),
  async (req, res) => {
    try {
      const customer = await prisma.customerProfile.findUnique({
        where: {
          userId: req.user.userId,
        },
      });

      if (!customer) {
        return res.status(404).json({
          success: false,
          message: "Customer profile not found",
        });
      }

      const applications =
        await prisma.loanApplication.findMany({
          where: {
            customerId: customer.id,
          },

          include: {
            product: true,
            loan: true,
          },

          orderBy: {
            createdAt: "desc",
          },
        });

      return res.status(200).json({
        success: true,
        count: applications.length,

        applications: applications.map((application) => ({
          id: application.id,

          productId: application.productId,

          productName:
            application.product.name,

          requestedAmount:
            application.requestedAmount.toString(),

          requestedTenure:
            application.requestedTenure,

          interestRate:
            application.interestRate
              ? application.interestRate.toString()
              : null,

          status:
            application.status,

          purpose:
            application.purpose,

          rejectionReason:
            application.rejectionReason,

          reviewNotes:
            application.reviewNotes,

          submittedAt:
            application.submittedAt,

          createdAt:
            application.createdAt,

          loan:
            application.loan
              ? {
                  id: application.loan.id,
                  loanNumber:
                    application.loan.loanNumber,
                  status:
                    application.loan.status,
                }
              : null,
        })),
      });
    } catch (error) {
      console.error(
        "Get customer applications error:",
        error
      );

      return res.status(500).json({
        success: false,
        message: "Failed to fetch loan applications",
      });
    }
  }
);

module.exports = router;