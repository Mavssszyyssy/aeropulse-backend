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
router.post("/", createRestockOrder);

// Get restock orders (filtered by status, branch, etc.)
router.get("/", getRestockOrders);

// Get my branch's restock orders
router.get("/my-deliveries", getMyRestockOrders);

// Manager marks restock as received
router.patch("/:id/receive", markRestockReceived);

// Owner signals restock order to managers
router.patch("/:id/signal", signalRestockOrder);

// Owner cancels a restock order
router.patch("/:id/cancel", cancelRestockOrder);

module.exports = router;
