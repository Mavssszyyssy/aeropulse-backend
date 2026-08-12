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
  requestPasswordChangeEmail,
  deleteAccount,
  unlockUser,
  updateUserStatus,
  deleteUserById,
} = require("../controllers/userController");

const { createStaff } = require("../controllers/staffController");
const router = express.Router();

router.use(requireAuth);

// Super Admin: create staff (admin/technician)
router.post("/staff", allowRoles("superadmin"), createStaff);
router.get("/profile", getProfile);
router.patch("/profile", updateProfile);
router.put("/profile/update", updateProfile);
router.patch("/location", updateLocation);

router.patch("/settings", updateSettings);
router.put("/settings/update", updateSettings);

router.patch("/preferences", updatePreferences);
router.patch("/privacy", updatePrivacy);
router.patch("/notifications", updateNotifications);

router.get("/addresses", listAddresses);
router.post("/addresses", addAddress);
router.patch("/addresses/:addressId", updateAddress);
router.delete("/addresses/:addressId", deleteAddress);
router.patch("/addresses/:addressId/default", setDefaultAddress);

router.patch("/password", changePassword);
router.post("/password/request-email", requestPasswordChangeEmail);
router.delete("/account", deleteAccount);
router.delete("/me", deleteAccount);

router.get("/", allowRoles("admin", "superadmin"), listUsers);
router.get("/:id/profile", allowRoles("admin", "superadmin"), getProfileById);
router.patch("/:id", allowRoles("admin", "superadmin"), updateProfileById);
router.patch("/:id/status", allowRoles("admin", "superadmin"), updateUserStatus);
router.put("/:id/profile", allowRoles("admin", "superadmin"), updateProfileById);
router.delete("/:id", allowRoles("admin", "superadmin"), deleteUserById);
router.post("/:id/unlock", allowRoles("admin", "superadmin"), unlockUser);

module.exports = router;
