const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  createOrder,
  listMyOrders,
  getMyOrderById,
  getMyOrderSummary,
  approveOrder,
  listOrdersForAdmin,
  getOrderByIdForAdmin,
  processOrder,
  recoverOrder,
  updateRefundReview,
  requestCustomerCancellation,
  handlePaymongoWebhook,
  handlePaymongoReturn,
  retryPaymongoCheckout,
  verifyPaymongoCheckout,
} = require("../controllers/orderController");

const router = express.Router();

router.post("/paymongo/webhook", handlePaymongoWebhook);
router.get("/:orderId/paymongo/return", handlePaymongoReturn);
router.use(requireAuth);
router.post("/", createOrder);
router.get("/", listOrdersForAdmin);
router.patch("/:orderId/approve", approveOrder);
router.patch("/:orderId/process", processOrder);
router.patch("/:orderId/recovery", recoverOrder);
router.patch("/:orderId/refund-review", updateRefundReview);
router.post("/:orderId/paymongo/checkout", retryPaymongoCheckout);
router.post("/:orderId/paymongo/verify", verifyPaymongoCheckout);
router.get("/me", listMyOrders);
router.get("/me/summary", getMyOrderSummary);
router.patch("/me/:orderId/cancel-request", requestCustomerCancellation);
router.get("/me/:orderId", getMyOrderById);
router.get("/:orderId", getOrderByIdForAdmin);

module.exports = router;
