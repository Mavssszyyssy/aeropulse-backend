const express = require("express");
const { requireAuth, allowRoles } = require("../middleware/auth");
const { getReportFilterOptions, getSalesReport, getInventoryReport, getTechnicianReport, getBusinessIntelligence, getAuditLogs } = require("../controllers/reportController");

const router = express.Router();

router.get("/filter-options", requireAuth, allowRoles("admin", "superadmin"), getReportFilterOptions);
router.get("/sales", requireAuth, allowRoles("admin", "superadmin"), getSalesReport);
router.get("/inventory", requireAuth, allowRoles("admin", "superadmin"), getInventoryReport);
router.get("/technicians", requireAuth, allowRoles("admin", "superadmin"), getTechnicianReport);
router.get("/business-intelligence", requireAuth, allowRoles("admin", "superadmin"), getBusinessIntelligence);
router.get("/audit-logs", requireAuth, allowRoles("admin", "superadmin"), getAuditLogs);

module.exports = router;

