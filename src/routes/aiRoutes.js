const express = require("express");

const { requireAuth } = require("../middleware/auth");
const { getUnitHealthInsight } = require("../controllers/aiController");

const router = express.Router();

// AI Routes disabled for cleanup
// router.post("/unit-health", requireAuth, getUnitHealthInsight);

module.exports = router;
