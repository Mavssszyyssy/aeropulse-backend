const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const User = require("../models/User");
const { canSendEmail, sendEmail } = require("../utils/email");
const { BRANCHES } = require("../domain/branchRouting");
const { withIdentityConflict } = require("../utils/optionalIdentity");
const { normalizeServiceQuota } = require("../domain/technicianServiceQuota");
const { validateEmailAddress } = require("../services/emailDomainPolicyService");

const credentialPart = (value = "") => String(value)
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ".")
  .replace(/^\.+|\.+$/g, "")
  .replace(/\.{2,}/g, ".");

const buildTechnicianCredentials = ({ branch, loginName, nameFirst }) => {
  const branchPart = credentialPart(branch);
  const namePart = credentialPart(loginName || nameFirst);
  return {
    branchPart,
    namePart,
    loginIdentifier: branchPart && namePart ? `tech.${branchPart}.${namePart}` : "",
    defaultPassword: branchPart && namePart ? `${branchPart}.${namePart}` : "",
  };
};

// Only Super Admin can create staff
const createStaff = async (req, res) => {
  if (req.authUser.role !== "superadmin") {
    return res.status(403).json({ message: "Only Super Admin can create staff accounts." });
  }
  const { email, name_first, name_last, role, branch, loginName, serviceQuota } = req.body;
  const firstName = String(name_first || "").trim();
  const lastName = String(name_last || "").trim();
  if (!firstName || !lastName || !role) {
    return res.status(400).json({ message: "Missing required fields." });
  }
  if (!['admin', 'technician'].includes(role)) {
    return res.status(400).json({ message: "Role must be Admin or Technician." });
  }
  if (!branch || !BRANCHES.includes(branch)) {
    return res.status(400).json({ message: "A valid branch is required." });
  }

  if (role === "technician") {
    const normalizedServiceQuota = normalizeServiceQuota(serviceQuota);
    if (!normalizedServiceQuota) {
      return res.status(400).json({
        message: "Service Quota is required for a technician account and must be a whole number greater than 0.",
      });
    }
    const credentials = buildTechnicianCredentials({
      branch,
      loginName,
      nameFirst: firstName,
    });
    if (!credentials.namePart || credentials.namePart.length < 2) {
      return res.status(400).json({
        message: "Enter a technician login name with at least 2 letters or numbers.",
      });
    }
    if (credentials.loginIdentifier.length > 30) {
      return res.status(400).json({
        message: "The technician login name is too long for this branch.",
      });
    }
    if (credentials.defaultPassword.length > 25) {
      return res.status(400).json({
        message: "The generated default password exceeds 25 characters. Use a shorter login name.",
      });
    }

    const existingTechnician = await User.findOne({
      $or: [
        { username: credentials.loginIdentifier },
        { alias: credentials.loginIdentifier },
      ],
    });
    if (existingTechnician) {
      return res.status(409).json({
        message: `Login ID ${credentials.loginIdentifier} already exists. Use another login name.`,
      });
    }

    const passwordHash = await bcrypt.hash(credentials.defaultPassword, 10);
    const user = await User.create({
      username: credentials.loginIdentifier,
      alias: credentials.loginIdentifier,
      name_first: firstName,
      name_last: lastName,
      name: `${firstName} ${lastName}`.trim(),
      passwordHash,
      role: "technician",
      assignedBranch: branch,
      activeBranch: branch,
      isFirstLogin: true,
      accountStatus: "active",
      serviceQuota: normalizedServiceQuota,
    });
    return res.status(201).json({
      user: user.toJSON(),
      loginIdentifier: credentials.loginIdentifier,
      tempPassword: credentials.defaultPassword,
      deliveryWarning: "",
    });
  }

  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) {
    return res.status(400).json({ message: "Email is required for an Admin account." });
  }
  const emailValidation = await validateEmailAddress(normalizedEmail);
  if (!emailValidation.ok) {
    return res.status(400).json({ message: emailValidation.message });
  }
  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) return res.status(409).json({ message: "Email already exists." });

  // Generate temp password
  const tempPassword = crypto.randomBytes(6).toString("base64");
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  const user = await User.create({
    email: normalizedEmail,
    name_first: firstName,
    name_last: lastName,
    name: `${firstName} ${lastName}`.trim(),
    passwordHash,
    role,
    assignedBranch: branch,
    activeBranch: branch,
    isFirstLogin: true,
    accountStatus: "active",
  });
  let emailDelivered = false;
  let deliveryWarning = "";
  if (canSendEmail()) {
    try {
      await sendEmail({
        to: user.email,
        subject: "Your Staff Account (AeroPulse)",
        text: `Your staff account has been created.\n\nEmail: ${user.email}\nTemporary Password: ${tempPassword}\n\nYou must change your password on first login.`,
        html: `<p>Your staff account has been created.</p><p><b>Email:</b> ${user.email}<br/><b>Temporary Password:</b> ${tempPassword}</p><p>You must change your password on first login.</p>`,
      });
      emailDelivered = true;
    } catch (error) {
      // The account was successfully created. Return the temporary password once
      // instead of turning a delivery problem into a duplicate-account retry.
      console.error("Unable to deliver staff credentials:", error.message);
      deliveryWarning = "The account was created, but the invitation email could not be delivered. Share the temporary password securely.";
    }
  }
  return res.status(201).json({
    user: user.toJSON(),
    tempPassword: emailDelivered ? undefined : tempPassword,
    deliveryWarning,
  });
};

module.exports = { buildTechnicianCredentials, createStaff: withIdentityConflict(createStaff) };
