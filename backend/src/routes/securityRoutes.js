const express = require("express");
const { requireAuthNoBranch } = require("../middleware/auth");
const { createMemoryRateLimit } = require("../middleware/requestRateLimit");
const {
  beginTotpSetup,
  consumeRecoveryCode,
  getSecurityStatus,
  listRecoveryCodes,
  regenerateRecoveryCodes,
  resetTotpAuthenticator,
  verifyTotpSetup,
} = require("../controllers/securityController");

const router = express.Router();

router.post(
  "/recovery-codes/consume",
  createMemoryRateLimit({
    scope: "recovery-code",
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: "Too many recovery attempts. Please wait and try again.",
  }),
  consumeRecoveryCode,
);

router.use(requireAuthNoBranch);
router.get("/status", getSecurityStatus);
router.get("/recovery-codes", listRecoveryCodes);
router.post("/recovery-codes/regenerate", regenerateRecoveryCodes);
router.post("/totp/setup", beginTotpSetup);
router.post("/totp/verify", verifyTotpSetup);
router.post("/totp/reset", resetTotpAuthenticator);

// Compatibility aliases for existing mobile builds. Secrets are returned only
// for a pending setup and are never the already-enabled authenticator secret.
router.get("/totp-secret", beginTotpSetup);
router.post("/totp-secret/regenerate", beginTotpSetup);

module.exports = router;
