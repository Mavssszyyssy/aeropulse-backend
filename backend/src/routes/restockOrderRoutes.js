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

const { limitTextFields } = require("../middleware/limitTextFields");

const router = express.Router();

const restockText = limitTextFields({
  "supplier.name": [120, "Supplier name"],
  "supplier.contact": [120, "Supplier contact"],
  "supplier.email": [254, "Email address"],
  "supplier.phone": [30, "Phone number"],
  notes: [1000, "Notes"],
});

router.use(requireAuth);

// Owner creates a restock order
router.post("/", allowRoles("superadmin"), restockText, createRestockOrder);

// Get restock orders (filtered by status, branch, etc.)
router.get("/", allowRoles("admin", "superadmin"), getRestockOrders);

// Get my branch's restock orders
router.get("/my-deliveries", allowRoles("admin"), getMyRestockOrders);

// Manager marks restock as received
router.patch("/:id/receive", allowRoles("superadmin"), markRestockReceived);

// Owner signals restock order to managers
router.patch("/:id/signal", allowRoles("superadmin"), signalRestockOrder);

// Owner cancels a restock order
router.patch("/:id/cancel", allowRoles("superadmin"), limitTextFields({ reason: [1000, "Cancellation reason"] }), cancelRestockOrder);

module.exports = router;
