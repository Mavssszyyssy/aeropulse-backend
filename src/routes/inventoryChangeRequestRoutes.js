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

// Branch admins request inventory changes; Super Admin reviews them.
router.post("/", allowRoles("admin"), createChangeRequest);

// Manager gets their own requests
router.get("/my-requests", allowRoles("admin"), getMyRequests);

// Owner gets all pending requests
router.get("/pending", allowRoles("superadmin"), getPendingRequests);

// Owner approves a request
router.patch("/:id/approve", allowRoles("superadmin"), approveRequest);

// Owner rejects a request
router.patch("/:id/reject", allowRoles("superadmin"), rejectRequest);

module.exports = router;
