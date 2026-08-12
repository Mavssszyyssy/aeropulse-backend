const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  createPartsRequest,
  getMyPartsRequests,
  listPartsRequests,
  updatePartsRequestStatus,
} = require("../controllers/partsRequestController");

const router = express.Router();

router.use(requireAuth);
router.post("/", createPartsRequest);
router.get("/me", getMyPartsRequests);
router.get("/", listPartsRequests);
router.patch("/:requestId/status", updatePartsRequestStatus);

module.exports = router;
