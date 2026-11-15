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

const { limitTextFields } = require("../middleware/limitTextFields");

const router = express.Router();

const serviceNotes = limitTextFields({
  notes: [2000, "Notes"],
  other: [1000, "Additional details"],
  otherIssue: [1000, "Additional details"],
  otherDescription: [1000, "Additional details"],
});
const { setServiceQuote } = require("../controllers/servicePaymentController");

router.use(requireAuth);

router.get("/", allowRoles("admin", "superadmin"), listServiceRequests);
router.post("/", allowRoles("admin", "superadmin"), serviceNotes, createServiceRequest);
router.get("/catalog", listServiceCatalog);
router.get("/me", allowRoles("customer"), listMyServiceRequests);
router.post("/me", allowRoles("customer"), serviceNotes, createMyServiceRequest);
router.patch("/:id/status", allowRoles("customer", "admin", "superadmin"), limitTextFields({ description: [1000, "Description"] }), updateServiceRequestStatus);
router.patch("/:id/quote", allowRoles("admin", "superadmin"), setServiceQuote);

module.exports = router;

