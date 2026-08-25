const express = require("express");
const { requireAuth, allowRoles } = require("../middleware/auth");
const {
	listServiceRequests,
	createServiceRequest,
	listMyServiceRequests,
	listServiceCatalog,
	createMyServiceRequest,
	updateServiceRequestStatus,
} = require("../controllers/serviceRequestController");

const router = express.Router();

router.use(requireAuth);

router.get("/", allowRoles("admin", "superadmin"), listServiceRequests);
router.post("/", allowRoles("admin", "superadmin"), createServiceRequest);
router.get("/catalog", listServiceCatalog);
router.get("/me", allowRoles("customer"), listMyServiceRequests);
router.post("/me", allowRoles("customer"), createMyServiceRequest);
router.patch("/:id/status", allowRoles("customer", "admin", "superadmin"), updateServiceRequestStatus);

module.exports = router;

