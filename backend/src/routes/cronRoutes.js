const express = require("express");
const { runDailyAmpMaintenance, runRequiredActionReminders } = require("../controllers/cronController");

const router = express.Router();
router.get("/amp-maintenance", runDailyAmpMaintenance);
router.get("/required-actions", runRequiredActionReminders);
module.exports = router;
