const express = require("express");
const {
  login,
  verifyLoginEmail,
  resendLoginEmail,
  register,
  me,
  requestPasswordReset,
  requestOtp,
  verifyOtp,
  checkAliasAvailability,
  resetPasswordWithCode,
  logout,
  getSession,
  updateRegistrationProgress,
  updateCart,
} = require("../controllers/authController");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.post("/register", register);
router.post("/login", login);
router.post(
  "/login/verify-email",
  require("../middleware/requestRateLimit").createMemoryRateLimit({
    scope: "login-email-verification",
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: "Too many verification attempts. Please wait and sign in again.",
  }),
  verifyLoginEmail,
);
router.post("/login/resend-email", resendLoginEmail);
router.post("/logout", logout);
router.get("/session", getSession);
router.post("/session/registration", updateRegistrationProgress);
router.post("/session/cart", updateCart);
router.post("/request-otp", requestOtp);
router.post("/verify-otp", verifyOtp);
router.get("/check-alias", checkAliasAvailability);
router.post("/forgot-password", requestPasswordReset);
router.post("/reset-password", resetPasswordWithCode);
router.get("/me", requireAuth, me);

module.exports = router;
