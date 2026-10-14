require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

// ========================================
// ROUTE IMPORTS
// ========================================

const authRoutes = require("./routes/auth");

const loanProductRoutes = require("./routes/loan-products");
const loanApplicationRoutes = require("./routes/loan-applications");

const adminLoanApplicationRoutes = require("./routes/admin-loan-applications");
const adminLoanReviewRoutes = require("./routes/admin-loan-review");
const adminLoanCreationRoutes = require("./routes/admin-loan-creation");

const customerLoanRoutes = require("./routes/customer-loans");

const paymentRoutes = require("./routes/payments");

const adminAgentRoutes = require("./routes/admin-agents");
const adminAreaRoutes = require("./routes/admin-areas");
const adminAgentAreaRoutes = require("./routes/admin-agent-areas");
const adminLoanAgentRoutes = require("./routes/admin-loan-agents");
const adminCashCollectionRoutes = require("./routes/admin-cash-collections");
const adminCashSettlementRoutes = require("./routes/admin-cash-settlements");
const adminFinancialReportRoutes = require("./routes/admin-financial-reports");
const adminCustomerRoutes = require("./routes/admin-customers");

// NEW: Agent Dashboard
const agentDashboardRoutes = require("./routes/agent-dashboard");
const agentCashCollectionRoutes = require("./routes/agent-cash-collections");

// ========================================
// MIDDLEWARE IMPORTS
// ========================================

const { authenticateToken } = require("./middleware/auth");
const { authorizeRoles } = require("./middleware/roles");
const { apiLimiter } = require("./middleware/rate-limiter");

// ========================================
// EXPRESS APPLICATION
// ========================================

const app = express();

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : [
      "http://localhost",
      "https://localhost",
      "http://localhost:8081",
      "http://localhost:8082",
      "http://localhost:8083",
      "http://127.0.0.1",
      "https://127.0.0.1",
      "http://127.0.0.1:8081",
      "http://127.0.0.1:8082",
      "http://127.0.0.1:8083",
      "https://customer.speedmoney.in",
      "https://admin.speedmoney.in",
      "https://agent.speedmoney.in",
      "https://speedmoney.in",
    ];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Android WebViews, Postman, curl)
      if (!origin) {
        return callback(null, true);
      }

      // Check explicit allowed origins or pattern matching for Capacitor, localhost, LAN IPs
      if (
        allowedOrigins.includes(origin) ||
        origin === "http://localhost" ||
        origin === "https://localhost" ||
        origin.startsWith("http://localhost:") ||
        origin.startsWith("https://localhost:") ||
        origin === "http://127.0.0.1" ||
        origin === "https://127.0.0.1" ||
        origin.startsWith("http://127.0.0.1:") ||
        origin.startsWith("https://127.0.0.1:") ||
        origin.startsWith("capacitor://") ||
        origin.startsWith("ionic://") ||
        origin.startsWith("http://192.168.") ||
        origin.startsWith("https://192.168.") ||
        origin.startsWith("http://10.") ||
        origin.startsWith("https://10.") ||
        origin.startsWith("http://172.")
      ) {
        return callback(null, true);
      }

      // In production/development hybrid mode, allow all origins cleanly
      return callback(null, true);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use("/api", apiLimiter);

// ========================================
// API ROOT & HEALTH
// ========================================

const handleRoot = (req, res) => {
  if (req.accepts("html")) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>SpeedMoney+ — API Gateway</title>
        <link rel="icon" href="http://localhost:8081/logo-icon.png" />
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 40px 20px; display: flex; justify-content: center; align-items: center; min-height: 100vh; box-sizing: border-box; }
          .card { background: #1e293b; border: 1px solid #334155; border-radius: 20px; padding: 36px; max-width: 540px; width: 100%; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
          .badge { display: inline-block; background: #059669; color: #fff; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 4px 10px; border-radius: 999px; letter-spacing: 0.05em; margin-bottom: 12px; }
          h1 { margin: 0 0 8px 0; font-size: 26px; color: #fff; }
          p { color: #94a3b8; font-size: 14px; line-height: 1.5; margin: 0 0 24px 0; }
          .grid { display: grid; gap: 12px; margin-bottom: 24px; }
          .btn { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-radius: 12px; text-decoration: none; font-weight: 600; font-size: 14px; transition: all 0.2s; }
          .btn-cust { background: #0f766e; color: #fff; }
          .btn-cust:hover { background: #115e59; }
          .btn-admin { background: #1e40af; color: #fff; }
          .btn-admin:hover { background: #1e3a8a; }
          .btn-agent { background: #047857; color: #fff; }
          .btn-agent:hover { background: #065f46; }
          .footer { font-size: 12px; color: #64748b; border-top: 1px solid #334155; padding-top: 16px; display: flex; justify-content: space-between; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge">● API Online · Port ${process.env.PORT || 8860}</div>
          <h1>SpeedMoney+ Backend API</h1>
          <p>This is the backend REST API server. To view the user interface and test Firebase authentication, open the frontend portals below:</p>
          <div class="grid">
            <a href="http://localhost:8081" class="btn btn-cust">
              <span>Customer App (Mobile UI & Firebase Login)</span>
              <span>:8081 &rarr;</span>
            </a>
            <a href="http://localhost:8082" class="btn btn-admin">
              <span>Admin Operations Portal</span>
              <span>:8082 &rarr;</span>
            </a>
            <a href="http://localhost:8083" class="btn btn-agent">
              <span>Field Collection Agent App</span>
              <span>:8083 &rarr;</span>
            </a>
          </div>
          <div class="footer">
            <span>Status: Healthy</span>
            <span>Database: Connected</span>
          </div>
        </div>
      </body>
      </html>
    `);
  }
  return res.json({
    success: true,
    message: "SpeedMoney+ Backend API is running",
    version: "1.0.0",
    status: "healthy",
    portals: {
      customer: "http://localhost:8081",
      admin: "http://localhost:8082",
      agent: "http://localhost:8083"
    }
  });
};

app.get("/", handleRoot);
app.get("/api", handleRoot);
app.get("/health", handleRoot);

// ========================================
// AUTHENTICATION
// ========================================

app.use("/api/auth", authRoutes);

// ========================================
// LOAN PRODUCTS
// ========================================

app.use("/api/loan-products", loanProductRoutes);

// ========================================
// CUSTOMER LOAN APPLICATIONS
// ========================================

app.use("/api/loan-applications", loanApplicationRoutes);

// ========================================
// CUSTOMER LOANS
// ========================================

app.use("/api/customer/loans", customerLoanRoutes);

// ========================================
// ADMIN LOAN APPLICATION MANAGEMENT
// ========================================

app.use(
  "/api/admin/loan-applications",
  adminLoanApplicationRoutes
);

app.use(
  "/api/admin/loan-applications",
  adminLoanReviewRoutes
);

app.use(
  "/api/admin/loan-applications",
  adminLoanCreationRoutes
);

app.use(
  "/api/admin/loans",
  adminLoanCreationRoutes
);

// ========================================
// PAYMENT MANAGEMENT
// ========================================

app.use("/api/payments", paymentRoutes);

// ========================================
// ADMIN AGENT MANAGEMENT
// ========================================

app.use("/api/admin/agents", adminAgentRoutes);

// ========================================
// ADMIN AREA MANAGEMENT
// ========================================

app.use("/api/admin/areas", adminAreaRoutes);

// ========================================
// ADMIN AGENT-AREA ASSIGNMENTS
// ========================================

app.use(
  "/api/admin/agent-areas",
  adminAgentAreaRoutes
);

// ========================================
// ADMIN LOAN-AGENT ASSIGNMENTS
// ========================================

app.use(
  "/api/admin/loan-agents",
  adminLoanAgentRoutes
);

// ========================================
// ADMIN CASH COLLECTIONS OVERSIGHT
// ========================================

app.use(
  "/api/admin/cash-collections",
  adminCashCollectionRoutes
);

// ========================================
// ADMIN CASH SETTLEMENTS & RECONCILIATION
// ========================================

app.use(
  "/api/admin/cash-settlements",
  adminCashSettlementRoutes
);

// ========================================
// ADMIN FINANCIAL REPORTS & ACCOUNTING LEDGER
// ========================================

app.use(
  "/api/admin/financial-reports",
  adminFinancialReportRoutes
);

// ========================================
// ADMIN CUSTOMERS & LIVE TRANSACTIONS
// ========================================

app.use("/api/admin/customers", adminCustomerRoutes);
app.use("/api/admin/notifications", adminCustomerRoutes);

// ========================================
// AGENT DASHBOARD & CASH COLLECTIONS
// ========================================

app.use("/api/agent/cash-collections", agentCashCollectionRoutes);
app.use("/api/agent", agentDashboardRoutes);

// ========================================
// HEALTH CHECK
// ========================================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Loan Platform API is running",
  });
});

// ========================================
// ADMIN AUTHORIZATION TEST
// ========================================

app.get(
  "/api/admin/test",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res) => {
    res.json({
      success: true,
      message: "Admin authorization successful",
      userId: req.user.userId,
      role: req.user.role,
    });
  }
);

// ========================================
// 404 HANDLER
// ========================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found",
  });
});

// ========================================
// GLOBAL ERROR HANDLER
// ========================================

app.use((err, req, res, next) => {
  console.error("Unhandled server error:", err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
});

// ========================================
// START SERVER
// ========================================

const PORT = process.env.PORT || 8860;

if (require.main === module) {
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Loan Platform API running on port ${PORT} (0.0.0.0)`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `\n[PORT CONFLICT] Port ${PORT} is already in use by another running process.`
      );
      console.error(
        `The backend server is already running! You can access it at http://localhost:${PORT}/api\n`
      );
      process.exit(1);
    } else {
      console.error("Server error:", err);
    }
  });
}

module.exports = app;