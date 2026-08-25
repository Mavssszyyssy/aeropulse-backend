const express = require("express");
const { requireAuth, allowRoles } = require("../middleware/auth");
const {
  createReorderRequest,
  listReorders,
  listMyReorders,
  updateReorderStatus,
} = require("../controllers/reorderController");

const router = express.Router();

router.use(requireAuth);

router.get("/mine", allowRoles("admin"), listMyReorders);
router.get("/", allowRoles("admin", "superadmin"), listReorders);
router.post("/", allowRoles("admin"), createReorderRequest);
router.patch("/:reorderId", allowRoles("superadmin"), updateReorderStatus);

module.exports = router;

