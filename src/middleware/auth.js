const jwt = require("jsonwebtoken");
const env = require("../config/env");
const User = require("../models/User");
const { BRANCHES } = require("../domain/branchRouting");

const authenticate = async (req, res, next, options = {}) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ message: "Missing token" });
    }

    const payload = jwt.verify(token, env.jwtSecret);
    const user = await User.findById(payload.sub);
    if (!user) {
      return res.status(401).json({ message: "Invalid token user" });
    }
    if (user.isDeleted || user.accountStatus === "deleted" || user.accountStatus === "disabled") {
      return res.status(403).json({ message: "Account is not active." });
    }

    req.authUser = user;
    req.user = payload;
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

module.exports = { requireAuth, requireAuthNoBranch, allowRoles };
