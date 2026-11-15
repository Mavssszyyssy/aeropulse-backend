const express = require("express");
const { requireAuth, allowRoles } = require("../middleware/auth");
const {
  listUsers,
  getProfile,
  getProfileById,
  updateProfile,
  updateProfileById,
  updateLocation,
  listAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
  updateSettings,
  updatePreferences,
  updatePrivacy,
  updateNotifications,
  changePassword,
  deleteAccount,
  unlockUser,
  updateUserStatus,
  deleteUserById,
} = require("../controllers/userController");

const { createStaff } = require("../controllers/staffController");
const { limitTextFields } = require("../middleware/limitTextFields");

const router = express.Router();

const addressText = limitTextFields({
  label: [80, "Address label"],
  name: [60, "Recipient name"],
  street: [180, "Street address"],
  phone: [20, "Mobile number"],
});
const profileText = limitTextFields({
  address: [220, "Address"],
  email: [254, "Email address"],
});

router.use(requireAuth);

// Super Admin: create staff (admin/technician)
router.post("/staff", allowRoles("superadmin"), limitTextFields({ email: [254, "Email address"] }), createStaff);
router.get("/profile", getProfile);
router.patch("/profile", profileText, updateProfile);
router.put("/profile/update", profileText, updateProfile);
router.patch("/location", limitTextFields({ "location.address.street": [180, "Street address"] }), updateLocation);

router.patch("/settings", updateSettings);
router.put("/settings/update", updateSettings);

router.patch("/preferences", updatePreferences);
router.patch("/privacy", updatePrivacy);
router.patch("/notifications", updateNotifications);

router.get("/addresses", listAddresses);
router.post("/addresses", addressText, addAddress);
router.patch("/addresses/:addressId", addressText, updateAddress);
router.delete("/addresses/:addressId", deleteAddress);
router.patch("/addresses/:addressId/default", setDefaultAddress);

router.patch("/password", changePassword);
router.delete("/account", deleteAccount);
router.delete("/me", deleteAccount);

router.get("/", allowRoles("admin", "superadmin"), listUsers);
router.get("/:id/profile", allowRoles("admin", "superadmin"), getProfileById);
router.patch("/:id", allowRoles("admin", "superadmin"), profileText, updateProfileById);
router.patch("/:id/status", allowRoles("admin", "superadmin"), updateUserStatus);
router.put("/:id/profile", allowRoles("admin", "superadmin"), profileText, updateProfileById);
router.delete("/:id", allowRoles("admin", "superadmin"), deleteUserById);
router.post("/:id/unlock", allowRoles("admin", "superadmin"), unlockUser);

module.exports = router;
