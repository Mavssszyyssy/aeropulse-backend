const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
	listServiceRequests,
	createServiceRequest,
	listMyServiceRequests,
	createMyServiceRequest,
	updateServiceRequestStatus,
} = require("../controllers/serviceRequestController");

const router = express.Router();

router.use(requireAuth);

router.get("/", listServiceRequests);
router.post("/", createServiceRequest);
router.get("/me", listMyServiceRequests);
router.post("/me", createMyServiceRequest);
router.patch("/:id/status", updateServiceRequestStatus);

module.exports = router;

