const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const env = require("../config/env");
const { createMemoryRateLimit } = require("./requestRateLimit");

const address = (req) => req.ip || req.socket?.remoteAddress || "unknown";
const routePath = (req) => String(req.path || "").toLowerCase().replace(/\/+$/, "") || "/";
const digest = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const identifier = (req) => String(req.body?.accountLoginId || req.body?.identifier || req.body?.email || "")
  .trim().toLowerCase();
const identityKey = (req) => digest(`${address(req)}\n${identifier(req)}`);
const challengeKey = (req) => {
  try {
    const payload = jwt.verify(String(req.body?.challengeToken || ""), env.jwtSecret);
    if (payload.purpose === "login_email_verification" && payload.sub && payload.jti) {
      return digest(`${payload.sub}\n${payload.jti}`);
    }
  } catch (_error) { /* Invalid challenges share an address-based abuse limit. */ }
  return digest(`invalid\n${address(req)}`);
};

// Session restoration, cart sync, drafts and logout must not consume password
// or OTP attempts. Password/OTP controllers retain their account/code locks.
const createAuthRateLimit = () => {
  const network = createMemoryRateLimit({
    scope: "auth-credential-network", windowMs: 60_000, max: 600,
    message: "Too many sign-in requests from this network. Please wait and try again.",
  });
  const policies = new Map([
    ["/login", { max: 30, keyGenerator: identityKey }],
    ["/login/verify-email", { max: 10, keyGenerator: challengeKey }],
    ["/login/resend-email", { max: 10, keyGenerator: challengeKey }],
    ["/register", { max: 10, keyGenerator: identityKey }],
    ["/request-otp", { max: 10, keyGenerator: identityKey }],
    ["/verify-otp", { max: 20, keyGenerator: identityKey }],
    ["/forgot-password", { max: 10, keyGenerator: identityKey }],
    ["/reset-password", { max: 10, keyGenerator: identityKey }],
  ].map(([path, policy]) => [path, createMemoryRateLimit({
    scope: `auth-operation:${path}`, windowMs: 15 * 60_000,
    message: "Too many attempts for this sign-in or verification. Please wait and try again.",
    ...policy,
  })]));
  const lookup = createMemoryRateLimit({
    scope: "auth-username-lookup", windowMs: 60_000, max: 1200,
    message: "Too many username checks. Please wait and try again.",
  });
  return (req, res, next) => {
    const path = routePath(req);
    if ((req.method === "GET" || req.method === "HEAD") && path === "/check-alias") return lookup(req, res, next);
    const operation = req.method === "POST" && policies.get(path);
    if (!operation) return next();
    return network(req, res, () => operation(req, res, next));
  };
};

const SESSION_PATHS = new Set([
  "/register", "/request-otp", "/verify-otp", "/logout",
  "/session", "/session/registration", "/session/cart",
]);
const createAuthSessionMiddleware = (session) => (req, res, next) => (
  SESSION_PATHS.has(routePath(req)) ? session(req, res, next) : next()
);

module.exports = { createAuthRateLimit, createAuthSessionMiddleware };
