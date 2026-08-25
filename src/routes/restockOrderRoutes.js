const express = require("express");
const { requireAuth, allowRoles } = require("../middleware/auth");
const {
  createRestockOrder,
  signalRestockOrder,
  markRestockReceived,
  getRestockOrders,
  getMyRestockOrders,
  cancelRestockOrder,
} = require("../controllers/restockOrderController");

const router = express.Router();

router.use(requireAuth);

// Owner creates a restock order
router.post("/", allowRoles("superadmin"), createRestockOrder);

// Get restock orders (filtered by status, branch, etc.)
router.get("/", allowRoles("admin", "superadmin"), getRestockOrders);

// Get my branch's restock orders
router.get("/my-deliveries", allowRoles("admin"), getMyRestockOrders);

// Manager marks restock as received
router.patch("/:id/receive", allowRoles("superadmin"), markRestockReceived);

// Owner signals restock order to managers
router.patch("/:id/signal", allowRoles("superadmin"), signalRestockOrder);

// Owner cancels a restock order
router.patch("/:id/cancel", allowRoles("superadmin"), cancelRestockOrder);

module.exports = router;
