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

const router = express.Router();

router.get("/public", listPublicProducts);
router.get("/:productId/image", getProductImage);
router.get("/serial/:serialNumber", requireAuthNoBranch, allowRoles("technician", "admin", "superadmin"), getProductSerialUnit);
router.get("/", requireAuthNoBranch, allowRoles("customer", "technician", "admin", "superadmin"), listProducts);

router.use(requireAuth);

router.get("/low-stock", allowRoles("admin", "superadmin"), listLowStockProducts);
router.get("/stock-status", allowRoles("admin", "superadmin"), listStockStatus);
router.post("/", allowRoles("superadmin"), createProduct);
router.patch("/:productId/restock", allowRoles("superadmin"), restockProduct);
router.patch("/:productId/stock", allowRoles("superadmin"), updateBranchStock);
router.patch("/:productId/serial-units/:serialNumber", allowRoles("superadmin"), updateProductSerialUnit);
router.patch("/:productId", allowRoles("superadmin"), updateProduct);
router.patch("/:productId/archive", allowRoles("superadmin"), archiveProduct);
router.patch("/:productId/restore", allowRoles("superadmin"), restoreProduct);
router.delete("/:productId", allowRoles("superadmin"), deleteProduct);

module.exports = router;
