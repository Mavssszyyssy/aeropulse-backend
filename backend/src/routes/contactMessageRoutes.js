const express = require("express");
const { requireAuthNoBranch, allowRoles } = require("../middleware/auth");
const { limitTextFields } = require("../middleware/limitTextFields");
const { CONTACT_NAME_MAX_CHARACTERS, MESSAGE_MAX_CHARACTERS, SUBJECT_MAX_CHARACTERS } = require("../domain/contactInquiryValidation");
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
  customerName: [CONTACT_NAME_MAX_CHARACTERS, "Your Name"],
  subject: [SUBJECT_MAX_CHARACTERS, "Subject"],
  message: [MESSAGE_MAX_CHARACTERS, "Message"],
  email: [180, "Email address"],
  phone: [30, "Phone number"],
}), createContactMessage);
router.get("/me", allowRoles("customer"), listMyContactMessages);
router.get("/me/:id", allowRoles("customer"), getMyContactMessage);
router.get("/", allowRoles("admin", "superadmin"), listContactMessages);
router.patch("/:id", allowRoles("admin", "superadmin"), limitTextFields({ adminReply: [MESSAGE_MAX_CHARACTERS, "Reply to customer"] }), updateContactMessage);

module.exports = router;
