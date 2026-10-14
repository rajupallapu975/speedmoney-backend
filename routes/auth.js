const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

// =====================================================
// REGISTRATION PRE-CHECK
// Pre-verifies phone number for the customer mobile app
// =====================================================

router.post("/check-registered", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required",
      });
    }

    const cleanPhone = phone.replace(/\D/g, "").slice(-10);
    if (cleanPhone.length !== 10) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid 10-digit mobile number",
      });
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { phone: cleanPhone },
          { phone: `+91${cleanPhone}` },
          { phone: `91${cleanPhone}` },
          { phone: phone.trim() },
        ],
      },
      select: {
        id: true,
        name: true,
        role: true,
        status: true,
      },
    });

    if (user) {
      return res.status(200).json({
        success: true,
        registered: true,
        allowed: true,
        name: user.name,
        role: user.role,
      });
    }

    // New user is allowed to proceed and register
    return res.status(200).json({
      success: true,
      registered: false,
      allowed: true,
      message: "New user eligible for registration",
    });
  } catch (error) {
    console.error("Check registered error:", error);
    return res.status(200).json({
      success: true,
      allowed: true,
      message: "Proceed to authentication",
    });
  }
});

// =====================================================
// CUSTOMER REGISTRATION (REFERENCE IMPLEMENTATION)
// =====================================================

router.post("/register", async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      password,
    } = req.body;

    // Validation
    if (!name || !email || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email, phone and password are required",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = phone.trim();

    // Check existing user
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          {
            email: normalizedEmail,
          },
          {
            phone: normalizedPhone,
          },
        ],
      },
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "Email or phone number is already registered",
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user + customer profile
    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        phone: normalizedPhone,
        password: hashedPassword,
        role: "CUSTOMER",

        customerProfile: {
          create: {},
        },
      },

      include: {
        customerProfile: true,
      },
    });

    // Create JWT
    const token = jwt.sign(
      {
        userId: user.id,
        role: user.role,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d",
      }
    );

    return res.status(201).json({
      success: true,
      message: "Customer registered successfully",

      token,

      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status,
      },
    });
  } catch (error) {
    console.error("Registration error:", error);

    return res.status(500).json({
      success: false,
      message: "Registration failed",
    });
  }
});

// =====================================================
// CUSTOMER LOGIN (REFERENCE IMPLEMENTATION)
// =====================================================

router.post("/login", async (req, res) => {
  try {
    const {
      email,
      password,
    } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Find user
    const user = await prisma.user.findUnique({
      where: {
        email: normalizedEmail,
      },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Check account status
    if (user.status !== "ACTIVE") {
      return res.status(403).json({
        success: false,
        message: "Your account is not active",
      });
    }

    // Verify password
    const passwordMatches = await bcrypt.compare(
      password,
      user.password
    );

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Create JWT
    const token = jwt.sign(
      {
        userId: user.id,
        role: user.role,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d",
      }
    );

    return res.status(200).json({
      success: true,
      message: "Login successful",

      token,

      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status,
      },
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      success: false,
      message: "Login failed",
    });
  }
});

// =====================================================
// GET CURRENT LOGGED-IN USER (REFERENCE IMPLEMENTATION)
// =====================================================

router.get("/me", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: {
        id: req.user.userId,
      },

      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      user,
    });
  } catch (error) {
    console.error("Get current user error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch user",
    });
  }
});

// =====================================================
// CUSTOMER PHONE / FIREBASE AUTH SYNC
// Logs in existing customer or auto-registers new customer by phone
// =====================================================

router.post("/phone-login", async (req, res) => {
  try {
    const { phone, name } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, message: "Phone is required" });
    }
    const cleanPhone = phone.replace(/\D/g, "").slice(-10);

    // Find existing user
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { phone: cleanPhone },
          { phone: `+91${cleanPhone}` },
          { phone: `91${cleanPhone}` },
          { phone: phone.trim() },
        ],
      },
      include: { customerProfile: true },
    });

    // Auto-create customer if not existing
    if (!user) {
      const defaultPw = await bcrypt.hash("SpeedMoney@123", 12);
      user = await prisma.user.create({
        data: {
          name: name ? name.trim() : `Customer ${cleanPhone.slice(-4)}`,
          email: `${cleanPhone}@speedmoney.user`,
          phone: `+91${cleanPhone}`,
          password: defaultPw,
          role: "CUSTOMER",
          status: "ACTIVE",
          customerProfile: {
            create: {},
          },
        },
        include: { customerProfile: true },
      });
    } else if (!user.customerProfile) {
      // Ensure customer profile is attached if missing
      const profile = await prisma.customerProfile.create({
        data: { userId: user.id },
      });
      user.customerProfile = profile;
    }

    if (user.status !== "ACTIVE") {
      return res.status(403).json({
        success: false,
        message: "Your account is not active. Please contact support.",
      });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role, phone: user.phone, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "15d" }
    );

    return res.status(200).json({
      success: true,
      message: "Phone login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status,
      },
    });
  } catch (error) {
    console.error("Phone login error:", error);
    return res.status(500).json({ success: false, message: "Phone login failed" });
  }
});

// =====================================================
// EXPORT ROUTER
// =====================================================

module.exports = router;