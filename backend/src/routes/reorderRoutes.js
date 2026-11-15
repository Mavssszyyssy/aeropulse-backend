const express = require("express");
const { requireAuth, allowRoles } = require("../middleware/auth");
const {
  createReorderRequest,
  listReorders,
  listMyReorders,
  updateReorderStatus,
} = require("../controllers/reorderController");

const { limitTextFields } = require("../middleware/limitTextFields");

const router = express.Router();

router.use(requireAuth);

router.get("/mine", allowRoles("admin"), listMyReorders);
router.get("/", allowRoles("admin", "superadmin"), listReorders);
router.post("/", allowRoles("admin"), limitTextFields({ notes: [1000, "Notes"] }), createReorderRequest);
router.patch("/:reorderId", allowRoles("superadmin"), limitTextFields({ reviewNotes: [1000, "Review note"] }), updateReorderStatus);

module.exports = router;

