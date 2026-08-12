const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { getMyDashboard } = require("../controllers/dashboardController");

const router = express.Router();

router.get("/me", requireAuth, getMyDashboard);

module.exports = router;
