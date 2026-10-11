const express = require("express");
const { requireAuthNoBranch, allowRoles } = require("../middleware/auth");
const {
  createContactMessage,
  listContactMessages,
  listMyContactMessages,
  updateContactMessage,
} = require("../controllers/contactMessageController");

const router = express.Router();

router.use(requireAuthNoBranch);
router.post("/", allowRoles("customer"), createContactMessage);
router.get("/me", allowRoles("customer"), listMyContactMessages);
router.get("/", allowRoles("admin", "superadmin"), listContactMessages);
router.patch("/:id", allowRoles("admin", "superadmin"), updateContactMessage);

module.exports = router;
