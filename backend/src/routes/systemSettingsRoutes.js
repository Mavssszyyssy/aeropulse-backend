const express = require("express");
const { requireAuthNoBranch, allowRoles } = require("../middleware/auth");
const {
  getManagedEmailDomainPolicy,
  getPublicEmailDomainPolicy,
  updateEmailDomainPolicy,
} = require("../controllers/systemSettingsController");

const router = express.Router();

router.get("/email-domains/public", getPublicEmailDomainPolicy);
router.get(
  "/email-domains",
  requireAuthNoBranch,
  allowRoles("superadmin"),
  getManagedEmailDomainPolicy,
);
router.put(
  "/email-domains",
  requireAuthNoBranch,
  allowRoles("superadmin"),
  updateEmailDomainPolicy,
);

module.exports = router;
