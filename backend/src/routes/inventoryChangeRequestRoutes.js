const express = require("express");
const { requireAuth, allowRoles } = require("../middleware/auth");
const {
  createChangeRequest,
  getPendingRequests,
  getMyRequests,
  approveRequest,
  rejectRequest,
} = require("../controllers/inventoryChangeRequestController");

const { limitTextFields } = require("../middleware/limitTextFields");

const router = express.Router();

router.use(requireAuth);

// Branch admins request inventory changes; Super Admin reviews them.
router.post("/", allowRoles("admin"), limitTextFields({ reason: [1000, "Reason"] }), createChangeRequest);

// Manager gets their own requests
router.get("/my-requests", allowRoles("admin"), getMyRequests);

// Owner gets all pending requests
router.get("/pending", allowRoles("superadmin"), getPendingRequests);

// Owner approves a request
router.patch("/:id/approve", allowRoles("superadmin"), approveRequest);

// Owner rejects a request
router.patch("/:id/reject", allowRoles("superadmin"), limitTextFields({ rejectionReason: [1000, "Rejection reason"] }), rejectRequest);

module.exports = router;
