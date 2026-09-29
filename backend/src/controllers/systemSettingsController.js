const {
  DEFAULT_ALLOWED_EMAIL_DOMAINS,
  EMAIL_DOMAIN_NOT_ALLOWED_MESSAGE,
  getEmailDomainPolicy,
  isDisposableEmailDomain,
  isValidDomain,
  normalizeDomain,
  saveEmailDomainPolicy,
} = require("../services/emailDomainPolicyService");

const getPublicEmailDomainPolicy = async (_req, res) => {
  const policy = await getEmailDomainPolicy();
  return res.json({ activeDomains: policy.activeDomains });
};

const getManagedEmailDomainPolicy = async (_req, res) => {
  const policy = await getEmailDomainPolicy({ fresh: true });
  return res.json({
    ...policy,
    defaultDomains: DEFAULT_ALLOWED_EMAIL_DOMAINS,
  });
};

const updateEmailDomainPolicy = async (req, res) => {
  const entries = Array.isArray(req.body?.domains) ? req.body.domains : null;
  if (!entries) return res.status(400).json({ message: "Email domains are required." });

  for (const entry of entries) {
    const domain = normalizeDomain(typeof entry === "string" ? entry : entry?.domain);
    if (!isValidDomain(domain)) {
      return res.status(400).json({ message: `Enter a valid email domain: ${domain || "empty value"}.` });
    }
    if (isDisposableEmailDomain(domain)) {
      return res.status(400).json({ message: EMAIL_DOMAIN_NOT_ALLOWED_MESSAGE });
    }
  }

  try {
    const policy = await saveEmailDomainPolicy(entries, req.authUser?._id || null);
    return res.json({
      message: "Email domain whitelist saved and applied system-wide.",
      ...policy,
      defaultDomains: DEFAULT_ALLOWED_EMAIL_DOMAINS,
    });
  } catch (error) {
    return res.status(Number(error.status) || 500).json({
      message: error.message || "Unable to save the email domain whitelist.",
    });
  }
};

module.exports = {
  getManagedEmailDomainPolicy,
  getPublicEmailDomainPolicy,
  updateEmailDomainPolicy,
};
