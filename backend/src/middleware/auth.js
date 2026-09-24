const jwt = require("jsonwebtoken");
const env = require("../config/env");
const User = require("../models/User");
const { BRANCHES } = require("../domain/branchRouting");

// Dashboard pages make several authenticated reads at once (orders, tasks,
// notifications, stock). Reusing a recently-read account avoids turning a
// single screen refresh into several identical database lookups. The cache is
// deliberately brief and is never used for writes, so account/branch changes
// are picked up immediately when a user saves them.
const READ_AUTH_CACHE_TTL_MS = 5000;
const readAuthCache = new Map();
const invalidateAuthCache = (userId) => readAuthCache.delete(String(userId || ""));
const readCachedUser = async (userId, requestMethod) => {
  const canUseCache = ["GET", "HEAD"].includes(String(requestMethod || "").toUpperCase());
  const cacheKey = String(userId || "");
  // Writes must invalidate the short read cache before loading the user. This
  // lets an address/profile/branch update made in one browser be visible to a
  // second browser on its very next refresh.
  if (!canUseCache) readAuthCache.delete(cacheKey);
  const cached = canUseCache ? readAuthCache.get(cacheKey) : null;
  if (cached && cached.expiresAt > Date.now()) {
    // Security revocation must remain effective across serverless instances,
    // even while their short-lived profile caches still contain an old user.
    const live = await User.findById(userId).select("security.sessionVersion accountStatus isDeleted isFirstLogin technicianOnboardedAt").lean();
    if (!live) return null;
    const hydrated = User.hydrate(cached.user);
    hydrated.security.sessionVersion = live.security?.sessionVersion || 0;
    hydrated.accountStatus = live.accountStatus;
    hydrated.isDeleted = live.isDeleted;
    hydrated.isFirstLogin = live.isFirstLogin;
    hydrated.technicianOnboardedAt = live.technicianOnboardedAt;
    return hydrated;
  }

  const user = await User.findById(userId);
  if (canUseCache && user) {
    readAuthCache.set(cacheKey, {
      expiresAt: Date.now() + READ_AUTH_CACHE_TTL_MS,
      user: user.toObject(),
    });
    // Prevent a long-lived serverless process from retaining obsolete entries.
    if (readAuthCache.size > 500) {
      const now = Date.now();
      for (const [key, value] of readAuthCache.entries()) {
        if (value.expiresAt <= now) readAuthCache.delete(key);
      }
    }
  }
  return user;
};

const authenticate = async (req, res, next, options = {}) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ message: "Missing token" });
    }

    const payload = jwt.verify(token, env.jwtSecret);
    if (payload.purpose || payload.recovery || !payload.sub || !payload.role) {
      return res.status(401).json({ message: "A verified sign-in session is required." });
    }
    const user = await readCachedUser(payload.sub, req.method);
    if (!user) {
      return res.status(401).json({ message: "Invalid token user" });
    }
    if (user.isDeleted || user.accountStatus === "deleted" || user.accountStatus === "disabled") {
      return res.status(403).json({ message: "Account is not active." });
    }

    req.authUser = user;
    req.user = payload;
    if (Number(payload.securityVersion || 0) !== Number(user.security?.sessionVersion || 0)) {
      return res.status(401).json({ message: "Your session has ended. Please sign in again." });
    }
    const requestPath = String(req.originalUrl || req.url).split("?")[0];
    if (user.role === "technician" && user.isFirstLogin) {
      const setupPath = ["/api/auth/me", "/api/auth/logout", "/api/users/profile", "/api/users/profile/update", "/api/users/password"].includes(requestPath);
      if (!setupPath) return res.status(403).json({ message: "Complete technician account setup before accessing work orders." });
    }
    const headerBranch = typeof req.headers["x-branch"] === "string" ? req.headers["x-branch"].trim() : "";
    const isBranchScopedRole = user.role === "admin" || user.role === "manager" || user.role === "technician";
    req.activeBranch = "";
    if (isBranchScopedRole) {
      const storedBranch = BRANCHES.includes(user.activeBranch)
        ? user.activeBranch
        : user.assignedBranch;
      if (headerBranch && headerBranch !== storedBranch) {
        return res.status(403).json({
          message: "You cannot access records from another branch.",
        });
      }
      const effectiveBranch = storedBranch;
      if (options.requireBranch === false) {
        req.activeBranch = BRANCHES.includes(effectiveBranch) ? effectiveBranch : "";
        return next();
      }
      if (!effectiveBranch || !BRANCHES.includes(effectiveBranch)) {
        return res.status(400).json({ message: "Branch is required for this account." });
      }
      req.activeBranch = effectiveBranch;
    }
    return next();
  } catch (_error) {
    return res.status(401).json({ message: "Unauthorized" });
  }
};

const requireAuth = (req, res, next) => authenticate(req, res, next);

const requireAuthNoBranch = (req, res, next) =>
  authenticate(req, res, next, { requireBranch: false });

const allowRoles = (...allowedRoles) => (req, res, next) => {
  if (!req.authUser) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  if (!allowedRoles.includes(req.authUser.role)) {
    return res.status(403).json({ message: "Forbidden" });
  }
  return next();
};

module.exports = {
  requireAuth,
  requireAuthNoBranch,
  allowRoles,
  invalidateAuthCache,
};
