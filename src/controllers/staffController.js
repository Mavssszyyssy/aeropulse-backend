const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const User = require("../models/User");
const { canSendEmail, sendEmail } = require("../utils/email");
const { BRANCHES } = require("../domain/branchRouting");

// Only Super Admin can create staff
const createStaff = async (req, res) => {
  if (req.authUser.role !== "superadmin") {
    return res.status(403).json({ message: "Only Super Admin can create staff accounts." });
  }
  const { email, name_first, name_last, role, branch } = req.body;
  if (!email || !name_first || !name_last || !role) {
    return res.status(400).json({ message: "Missing required fields." });
  }
  if (!['admin', 'technician'].includes(role)) {
    return res.status(400).json({ message: "Role must be Admin or Technician." });
  }
  if (!branch || !BRANCHES.includes(branch)) {
    return res.status(400).json({ message: "A valid branch is required." });
  }
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    return res.status(409).json({ message: "Email already exists." });
  }
  // Generate temp password
  const tempPassword = crypto.randomBytes(6).toString("base64");
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  const user = await User.create({
    email: email.toLowerCase(),
    name_first,
    name_last,
    name: `${name_first} ${name_last}`.trim(),
    passwordHash,
    role,
    assignedBranch: branch,
    activeBranch: branch,
    isFirstLogin: true,
    accountStatus: "active",
  });
  if (canSendEmail()) {
    await sendEmail({
      to: user.email,
      subject: "Your Staff Account (AeroPulse)",
      text: `Your staff account has been created.\n\nEmail: ${user.email}\nTemporary Password: ${tempPassword}\n\nYou must change your password on first login.`,
      html: `<p>Your staff account has been created.</p><p><b>Email:</b> ${user.email}<br/><b>Temporary Password:</b> ${tempPassword}</p><p>You must change your password on first login.</p>`,
    });
  }
  return res.status(201).json({ user: user.toJSON(), tempPassword: canSendEmail() ? undefined : tempPassword });
};

module.exports = { createStaff };