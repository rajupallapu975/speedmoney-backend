# SpeedMoney Backend AWS Deployment Guide

This guide provides end-to-end instructions for deploying the SpeedMoney backend API and PostgreSQL database to **Amazon Web Services (AWS)**.

---

## Architecture Overview

```
[Customer Android App]  \
[Admin Android App]     -->  [AWS Route 53 / Cloudflare / DNS]
[Web Portals]           /               |
                                        v
                           [Nginx Reverse Proxy + SSL (Port 443)]
                                        |
                                        v
                           [Node.js Express API (Port 5000, PM2 / Docker)]
                                        |
                                        v
                           [PostgreSQL 16 Database (Local on EC2 or AWS RDS)]
```

---

## Method 1: AWS EC2 (Recommended - Simple, Fast, Affordable)

Recommended instance type: **`t3.micro`** (Free Tier eligible) or **`t3.small`** / **`t4g.small`** (₹700–₹1,200/month).
OS: **Ubuntu 24.04 LTS** or **Ubuntu 22.04 LTS**.

### Step 1: Launch EC2 Instance
1. Open [AWS EC2 Console](https://console.aws.amazon.com/ec2).
2. Click **Launch Instance**:
   - **Name**: `speedmoney-api`
   - **AMI**: Ubuntu Server 24.04 LTS (64-bit x86 or ARM)
   - **Instance type**: `t3.micro` or `t3.small`
   - **Key pair**: Create or select an existing `.pem` key pair
   - **Network settings (Security Group)**:
     - Check **Allow SSH (Port 22)** from your IP
     - Check **Allow HTTP (Port 80)** from Anywhere (0.0.0.0/0)
     - Check **Allow HTTPS (Port 443)** from Anywhere (0.0.0.0/0)
   - **Storage**: 20 GiB gp3
3. Click **Launch Instance**.
4. Allocate and attach an **Elastic IP** to your instance so the IP address never changes when restarted.

---

### Step 2: Connect to Your EC2 Instance
```bash
ssh -i your-key.pem ubuntu@YOUR_EC2_PUBLIC_IP
```

---

### Step 3: Run the Automated Bootstrap Script
You can clone the repository or upload the `deploy/setup-aws-ec2.sh` script:

```bash
# Clone the repository
git clone <YOUR_GIT_REPO_URL> /home/ubuntu/loan_platform
cd /home/ubuntu/loan_platform

# Make the setup script executable and run it
chmod +x deploy/setup-aws-ec2.sh
./deploy/setup-aws-ec2.sh
```

This automatically installs:
- Node.js 20 LTS
- PM2 process manager
- PostgreSQL 16 (with user `speedmoney` and database `loan_platform`)
- Nginx web server
- Certbot for free SSL

---

### Step 4: Configure Backend Environment Variables
```bash
cd /home/ubuntu/loan_platform/backend
cp .env.example .env
nano .env
```

Configure your production values:
```ini
PORT=5000
NODE_ENV=production

# Database URL pointing to local PostgreSQL
DATABASE_URL="postgresql://speedmoney:SpeedMoney2026Secure!@localhost:5432/loan_platform?schema=public"

# JWT Secret for token authentication
JWT_SECRET="YOUR_SUPER_SECURE_RANDOM_JWT_SECRET_KEY_PROD_2026"

# Live Razorpay Credentials
RAZORPAY_KEY_ID="rzp_live_TnNz7LVZ4wpQxa"
RAZORPAY_KEY_SECRET="YOUR_RAZORPAY_LIVE_SECRET_KEY"
RAZORPAY_WEBHOOK_SECRET="YOUR_RAZORPAY_WEBHOOK_SECRET"
```

Save and exit (`Ctrl + O`, `Enter`, `Ctrl + X`).

---

### Step 5: Install Dependencies & Run Database Migrations
```bash
cd /home/ubuntu/loan_platform/backend
npm install
npx prisma generate
npx prisma migrate deploy
```

---

### Step 6: Start Backend with PM2
```bash
# Start backend using ecosystem config
pm2 start ecosystem.config.js

# Ensure PM2 starts on server reboot
pm2 save
pm2 startup
# (Run the sudo env PATH=... command printed by pm2 startup)
```

Verify the backend is running:
```bash
pm2 status
curl http://localhost:5000/api/payments/razorpay/config
```

---

### Step 7: Configure Nginx & Free SSL (Let's Encrypt)
1. Copy the Nginx configuration:
```bash
sudo cp /home/ubuntu/loan_platform/deploy/nginx.conf /etc/nginx/sites-available/speedmoney
sudo nano /etc/nginx/sites-available/speedmoney
```
Replace `server_name api.yourdomain.com your-ec2-public-ip;` with your actual domain (e.g. `api.speedmoney.in`).

2. Enable the site and restart Nginx:
```bash
sudo ln -sf /etc/nginx/sites-available/speedmoney /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

3. Obtain free auto-renewing SSL certificate:
```bash
sudo certbot --nginx -d api.yourdomain.com
```

Your API is now live at `https://api.yourdomain.com/api`!

---

## Method 2: Docker & Docker Compose (Containerized)

If you prefer Docker:
```bash
# 1. Install Docker & Docker Compose
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin
sudo usermod -aG docker ubuntu

# 2. Start services
cd /home/ubuntu/loan_platform
docker compose up -d --build

# 3. View logs
docker compose logs -f backend
```

---

## Method 3: AWS RDS for PostgreSQL (Optional Managed Database)

If you want AWS to manage backups, failover, and scaling:
1. In the AWS Console, open **RDS** -> **Create database**.
2. Select **PostgreSQL 16**.
3. Choose **Free Tier** (`db.t4g.micro` or `db.t3.micro`).
4. Set Master username (`speedmoney`) and password.
5. In **Connectivity**, select the VPC of your EC2 instance.
6. In `backend/.env`, update:
   ```ini
   DATABASE_URL="postgresql://speedmoney:YOUR_PASSWORD@YOUR_RDS_ENDPOINT:5432/loan_platform?schema=public&sslmode=require"
   ```

---

## Connecting Apps to the AWS API

Once deployed to `https://api.yourdomain.com/api` (or `http://YOUR_EC2_PUBLIC_IP/api`):

1. **Customer App**:
   In `customer-app/.env`:
   ```ini
   VITE_API_URL=https://api.yourdomain.com/api
   ```
   Run: `npm run build && npx cap sync android && .\gradlew.bat assembleDebug`

2. **Admin App**:
   In `admin-app/.env`:
   ```ini
   VITE_API_URL=https://api.yourdomain.com/api
   ```
   Run: `npm run build && npx cap sync android && .\gradlew.bat assembleDebug`

3. **Razorpay Webhook Configuration**:
   In your [Razorpay Dashboard](https://dashboard.razorpay.com/#/app/webhooks):
   - **Webhook URL**: `https://api.yourdomain.com/api/payments/razorpay/webhook`
   - **Secret**: Set the same value as `RAZORPAY_WEBHOOK_SECRET` in `.env`
   - **Active Events**:
     - `payment.captured`
     - `payment.failed`
     - `order.paid`
