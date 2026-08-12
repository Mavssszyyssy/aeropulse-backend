const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { createReorderRequest, listMyReorders } = require("../controllers/reorderController");

const router = express.Router();

router.use(requireAuth);

router.get("/mine", listMyReorders);
router.post("/", createReorderRequest);

module.exports = router;

