# Production Dockerfile for SpeedMoney API Backend
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy Prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy application source
COPY . .

# Production runner stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8860

# Install OpenSSL for Prisma engine on Alpine
RUN apk add --no-cache openssl ca-certificates

COPY --from=builder /app ./

EXPOSE 8860

CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]
