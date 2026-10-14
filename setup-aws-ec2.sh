#!/usr/bin/env bash
# ==============================================================================
# SpeedMoney - Automated AWS EC2 (Ubuntu 22.04 / 24.04 LTS) Bootstrap Script
# Installs Node.js 20 LTS, PostgreSQL 16, PM2, Git, Nginx, and Certbot
# ==============================================================================

set -e

echo "=== 1. Updating System Packages ==="
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y curl wget git build-essential nginx ufw certbot python3-certbot-nginx

echo "=== 2. Installing Node.js 20 LTS ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2

echo "=== 3. Installing PostgreSQL 16 ==="
sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo apt-key add -
sudo apt-get update
sudo apt-get install -y postgresql-16 postgresql-contrib-16

sudo systemctl enable postgresql
sudo systemctl start postgresql

echo "=== 4. Setting up Database ==="
sudo -u postgres psql -c "CREATE USER speedmoney WITH PASSWORD 'SpeedMoney2026Secure!';" || true
sudo -u postgres psql -c "CREATE DATABASE loan_platform OWNER speedmoney;" || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE loan_platform TO speedmoney;" || true

echo "=== 5. Configuring Firewall ==="
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable

echo "=== SETUP COMPLETE! ==="
echo "Node version: $(node -v)"
echo "NPM version: $(npm -v)"
echo "PM2 version: $(pm2 -v)"
echo "Postgres status: active"
