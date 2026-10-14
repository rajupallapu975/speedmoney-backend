# SpeedMoney Backend API

Production-ready backend API service for the SpeedMoney loan platform, handling loan origination, EMI repayment scheduling, live Razorpay UPI gateway integration, admin controls, and agent cash collections.

---

## 🛠 Technology Stack

- **Runtime**: Node.js (v20+ LTS)
- **Framework**: Express.js 5
- **Database**: PostgreSQL 16
- **ORM**: Prisma ORM 7
- **Payment Gateway**: Razorpay (Live UPI Intent, hosted links, webhooks, HMAC signature verification)
- **Authentication**: JWT (JSON Web Tokens) with RBAC (`ADMIN`, `AGENT`, `CUSTOMER`)
- **Process Manager**: PM2 / Docker

---

## 📂 Directory Structure

```
├── lib/                     # Database & customer profile helpers
├── middleware/              # Auth, RBAC roles, rate limiting
├── prisma/                  # Prisma schema & database migrations
├── routes/                  # Express API route controllers
│   ├── auth.js              # Authentication (Login, Register, OTP)
│   ├── customer-loans.js    # Customer loan & EMI views
│   ├── payments.js          # Live Razorpay payment order, intent & verification
│   ├── admin-*.js           # Admin management routes
│   └── agent-*.js           # Field agent cash collection routes
├── services/                # Core business logic (Payment engine, EMI calculation)
├── Dockerfile               # Production Docker container image
├── docker-compose.yml       # Production Docker Compose stack
├── ecosystem.config.js      # PM2 cluster configuration for AWS EC2
├── setup-aws-ec2.sh         # 1-click bootstrap script for Ubuntu EC2
├── nginx.conf               # Nginx reverse proxy template
├── AWS_DEPLOYMENT_GUIDE.md  # Detailed AWS deployment guide
└── server.js                # Application entrypoint
```

---

## 🚀 Local Development Setup

### 1. Prerequisites
- Node.js 20+ installed
- PostgreSQL 16 running locally or via Docker

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Update your `.env`:
```ini
PORT=8860
DATABASE_URL="postgresql://speedmoney:password@localhost:5432/loan_platform?schema=public"
JWT_SECRET="your-secure-jwt-secret"
RAZORPAY_KEY_ID="rzp_live_your_key_id"
RAZORPAY_KEY_SECRET="your_razorpay_secret"
RAZORPAY_WEBHOOK_SECRET="your_webhook_secret"
```

### 4. Run Prisma Migrations
```bash
npx prisma generate
npx prisma migrate deploy
```

### 5. Start the Server
```bash
npm start
```
The API will run on `http://localhost:8860/api`.

---

## ☁️ Deploying to AWS EC2

### 1. Automated Setup (Ubuntu 22.04 / 24.04 LTS)
Launch an EC2 instance (`t3.micro` or `t3.small`), connect via SSH, and run:
```bash
git clone https://github.com/rajupallapu975/speedmoney-backend.git
cd speedmoney-backend
chmod +x setup-aws-ec2.sh
./setup-aws-ec2.sh
```

### 2. Configure Environment & Run Migrations
```bash
cp .env.example .env
nano .env   # Fill in your database and Razorpay credentials
npm install
npx prisma migrate deploy
```

### 3. Start with PM2
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### 4. Enable Nginx & SSL
```bash
sudo cp nginx.conf /etc/nginx/sites-available/speedmoney
sudo ln -sf /etc/nginx/sites-available/speedmoney /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.yourdomain.com
```

---

## 🐳 Docker Deployment

```bash
docker compose up -d --build
```
This launches both PostgreSQL and the SpeedMoney Backend API automatically.
