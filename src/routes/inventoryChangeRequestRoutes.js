const express = require("express");
const { requireAuth, allowRoles } = require("../middleware/auth");
const {
  createChangeRequest,
  getPendingRequests,
  getMyRequests,
  approveRequest,
  rejectRequest,
} = require("../controllers/inventoryChangeRequestController");

const router = express.Router();

router.use(requireAuth);

// Manager creates a change request
router.post("/", createChangeRequest);

// Manager gets their own requests
router.get("/my-requests", getMyRequests);

// Owner gets all pending requests
router.get("/pending", getPendingRequests);

// Owner approves a request
router.patch("/:id/approve", approveRequest);

// Owner rejects a request
router.patch("/:id/reject", rejectRequest);

module.exports = router;
