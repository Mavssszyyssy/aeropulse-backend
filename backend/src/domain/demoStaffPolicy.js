const PROTECTED_DEMO_STAFF = [
  ["admin.bulacan", "admin-bulacan@example.com"],
  ["admin.cavite", "admin-cavite@example.com"],
  ["admin.laguna", "admin-laguna@example.com"],
  ["admin.bataan", "admin-bataan@example.com"],
  ["admin.pangasinan", "admin-pangasinan@example.com"],
  ["admin.ilocos", "admin-ilocos@example.com"],
  ["tech.main", "tech@example.com"],
  ["superadmin.main", "superadmin@example.com"],
];

const SHARED_DEMO_EMAIL = "lanlords2025@gmail.com";
const SHARED_DEMO_ACCOUNTS = Object.freeze([
  { accountKey: "superadmin.main", role: "superadmin", branch: "" },
  { accountKey: "admin.cavite", role: "admin", branch: "Cavite" },
  { accountKey: "admin.bulacan", role: "admin", branch: "Bulacan" },
  { accountKey: "tech.cavite.carl", role: "technician", branch: "Cavite" },
  { accountKey: "tech.cavite.lebron", role: "technician", branch: "Cavite" },
]);

const protectedAliases = new Set(PROTECTED_DEMO_STAFF.map(([alias]) => alias));
const protectedEmails = new Set(PROTECTED_DEMO_STAFF.map(([, email]) => email));

const isProtectedDemoStaff = (user = {}) =>
  protectedAliases.has(String(user.alias || "").trim().toLowerCase()) ||
  protectedEmails.has(String(user.email || "").trim().toLowerCase());

const normalizeEmail = (value = "") => String(value || "").trim().toLowerCase();
const normalizeAccountKey = (user = {}) => String(user.alias || user.username || "")
  .trim()
  .toLowerCase();
const accountBranch = (user = {}) => String(user.assignedBranch || user.activeBranch || "").trim();

const sharedDemoAccount = (user = {}) => {
  const key = normalizeAccountKey(user);
  const role = String(user.role || "").trim().toLowerCase();
  const branch = accountBranch(user);
  return SHARED_DEMO_ACCOUNTS.find((account) => (
    account.accountKey === key &&
    account.role === role &&
    (!account.branch || account.branch === branch)
  )) || null;
};

const canUseSharedDemoEmail = (user = {}, email = user.email) => (
  normalizeEmail(email) === SHARED_DEMO_EMAIL && Boolean(sharedDemoAccount(user))
);

const buildEmailIdentityKey = (user = {}, email = user.email) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return undefined;
  const demoAccount = sharedDemoAccount(user);
  if (normalizedEmail === SHARED_DEMO_EMAIL && demoAccount) {
    return `shared-demo:${demoAccount.accountKey}`;
  }
  return `email:${normalizedEmail}`;
};

module.exports = {
  PROTECTED_DEMO_STAFF,
  SHARED_DEMO_ACCOUNTS,
  SHARED_DEMO_EMAIL,
  buildEmailIdentityKey,
  canUseSharedDemoEmail,
  isProtectedDemoStaff,
  sharedDemoAccount,
};
