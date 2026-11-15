const express = require("express");
const { requireAuthNoBranch, allowRoles } = require("../middleware/auth");
const { limitTextFields } = require("../middleware/limitTextFields");
const {
  createContactMessage,
  listContactMessages,
  listMyContactMessages,
  getMyContactMessage,
  updateContactMessage,
} = require("../controllers/contactMessageController");

const router = express.Router();

router.use(requireAuthNoBranch);
router.post("/", allowRoles("customer"), limitTextFields({
  customerName: [120, "Your Name"],
  email: [180, "Email address"],
  phone: [30, "Phone number"],
}), createContactMessage);
router.get("/me", allowRoles("customer"), listMyContactMessages);
router.get("/me/:id", allowRoles("customer"), getMyContactMessage);
router.get("/", allowRoles("admin", "superadmin"), listContactMessages);
router.patch("/:id", allowRoles("admin", "superadmin"), limitTextFields({ adminReply: [3000, "Reply to customer"] }), updateContactMessage);

module.exports = router;
