/**
 * Lightweight In-Memory Sliding-Window Rate Limiter
 * 
 * Provides defense-in-depth against brute-force attacks and volumetric request floods
 * without requiring external Redis or native binary dependencies.
 */

function createRateLimiter({
  windowMs = 60 * 1000,
  max = 60,
  message = "Too many requests. Please try again later.",
  statusCode = 429,
  keyGenerator = (req) => req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown",
} = {}) {
  const hits = new Map();

  // Periodic garbage collection every 60 seconds
  const gcInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of hits.entries()) {
      if (now > record.resetTime) {
        hits.delete(key);
      }
    }
  }, 60 * 1000);

  if (gcInterval.unref) {
    gcInterval.unref();
  }

  return function rateLimiterMiddleware(req, res, next) {
    // Skip OPTIONS pre-flight requests
    if (req.method === "OPTIONS") {
      return next();
    }

    const key = keyGenerator(req);
    const now = Date.now();
    let record = hits.get(key);

    if (!record || now > record.resetTime) {
      record = {
        count: 1,
        resetTime: now + windowMs,
      };
      hits.set(key, record);
    } else {
      record.count += 1;
    }

    const remaining = Math.max(0, max - record.count);
    const resetSeconds = Math.ceil((record.resetTime - now) / 1000);

    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", resetSeconds);

    if (record.count > max) {
      res.setHeader("Retry-After", resetSeconds);
      return res.status(statusCode).json({
        success: false,
        code: "RATE_LIMIT_EXCEEDED",
        message,
        retryAfterSeconds: resetSeconds,
      });
    }

    return next();
  };
}

const authLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 15, // max 15 login/auth attempts per minute per IP
  message: "Too many authentication attempts from this IP. Please wait 1 minute before trying again.",
});

const apiLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 200, // max 200 general requests per minute per IP
  message: "API rate limit exceeded. Please slow down requests.",
});

module.exports = {
  createRateLimiter,
  authLimiter,
  apiLimiter,
};
