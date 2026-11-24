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

const { limitTextFields } = require("../middleware/limitTextFields");

const router = express.Router();

const registrationText = limitTextFields({
  email: [254, "Email address"],
  alias: [30, "Username"],
  phone: [20, "Mobile number"],
  thoroughfare: [180, "Street address"],
  property_block_lot: [80, "Property, block, or lot"],
  apartment_unit: [80, "Apartment unit"],
  landmark: [180, "Landmark"],
  messenger_handle: [120, "Messenger handle"],
  delivery_instructions: [1000, "Delivery instructions"],
});
const registrationAddresses = limitTextFields(
  { street: [180, "Street address"] },
  body => Array.isArray(body?.locations) ? body.locations.map(location => location?.address) : [],
);
const recoveryText = limitTextFields({
  identifier: [254, "Account login"],
  email: [254, "Email address"],
  accountLoginId: [30, "Account login ID"],
});

router.post("/register", registrationText, registrationAddresses, register);
router.post("/login", limitTextFields({ identifier: [254, "Account login"], password: [128, "Password"] }), login);
router.post(
  "/login/verify-email",
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
router.post("/forgot-password", recoveryText, requestPasswordReset);
router.post("/reset-password", recoveryText, resetPasswordWithCode);
router.get("/me", requireAuth, me);

module.exports = router;
