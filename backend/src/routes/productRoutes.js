const express = require("express");
const { requireAuth, requireAuthNoBranch, allowRoles } = require("../middleware/auth");
const {
  listProducts,
  listPublicProducts,
  listLowStockProducts,
  listStockStatus,
  getProductImage,
  getProductSerialUnit,
  updateProductSerialUnit,
  createProduct,
  restockProduct,
  updateBranchStock,
  updateProduct,
  deleteProduct,
  archiveProduct,
  restoreProduct,
} = require("../controllers/productController");

const { limitTextFields } = require("../middleware/limitTextFields");

const router = express.Router();

const productText = limitTextFields({
  name: [120, "Product name"],
  sku: [80, "SKU"],
  brand: [80, "Brand"],
  specs: [80, "Specs"],
  description: [2000, "Product description"],
  features: [1000, "Product features", true],
  image: [2048, "Image URL"],
});

router.get("/public", listPublicProducts);
router.get("/:productId/image", getProductImage);
router.get("/serial/:serialNumber", requireAuthNoBranch, allowRoles("technician", "admin", "superadmin"), getProductSerialUnit);
router.get("/", requireAuthNoBranch, allowRoles("customer", "technician", "admin", "superadmin"), listProducts);

router.use(requireAuth);

router.get("/low-stock", allowRoles("admin", "superadmin"), listLowStockProducts);
router.get("/stock-status", allowRoles("admin", "superadmin"), listStockStatus);
router.post("/", allowRoles("superadmin"), productText, createProduct);
router.patch("/:productId/restock", allowRoles("superadmin"), limitTextFields({ features: [1000, "Product features", true] }), restockProduct);
router.patch("/:productId/stock", allowRoles("superadmin"), updateBranchStock);
router.patch("/:productId/serial-units/:serialNumber", allowRoles("superadmin"), updateProductSerialUnit);
router.patch("/:productId", allowRoles("superadmin"), productText, updateProduct);
router.patch("/:productId/archive", allowRoles("superadmin"), archiveProduct);
router.patch("/:productId/restore", allowRoles("superadmin"), restoreProduct);
router.delete("/:productId", allowRoles("superadmin"), deleteProduct);

module.exports = router;
