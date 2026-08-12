const express = require("express");
const { requireAuth, requireAuthNoBranch } = require("../middleware/auth");
const {
  listProducts,
  listPublicProducts,
  listLowStockProducts,
  getProductImage,
  getProductSerialUnit,
  createProduct,
  restockProduct,
  updateBranchStock,
  updateProduct,
  deleteProduct,
} = require("../controllers/productController");

const router = express.Router();

router.get("/public", listPublicProducts);
router.get("/:productId/image", getProductImage);
router.get("/serial/:serialNumber", requireAuthNoBranch, getProductSerialUnit);
router.get("/", requireAuthNoBranch, listProducts);

router.use(requireAuth);

router.get("/low-stock", listLowStockProducts);
router.post("/", createProduct);
router.patch("/:productId/restock", restockProduct);
router.patch("/:productId/stock", updateBranchStock);
router.patch("/:productId", updateProduct);
router.delete("/:productId", deleteProduct);

module.exports = router;
