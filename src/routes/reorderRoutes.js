const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  createReorderRequest,
  listReorders,
  listMyReorders,
  updateReorderStatus,
} = require("../controllers/reorderController");

const router = express.Router();

router.use(requireAuth);

router.get("/mine", listMyReorders);
router.get("/", listReorders);
router.post("/", createReorderRequest);
router.patch("/:reorderId", updateReorderStatus);

module.exports = router;

