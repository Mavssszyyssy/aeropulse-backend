const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const {
  duplicateIdentityField,
  duplicateIdentityMessage,
  normalizeOptionalIdentity,
} = require("../src/utils/optionalIdentity");

test("blank optional unique identities are omitted instead of indexed", () => {
  const user = new User({
    name_first: "Blank",
    name_last: "Identity",
    email: "   ",
    phone: "",
    alias: null,
    username: undefined,
    googleId: "  ",
  });

  assert.equal(user.email, undefined);
  assert.equal(user.phone, undefined);
  assert.equal(user.alias, undefined);
  assert.equal(user.username, undefined);
  assert.equal(user.googleId, undefined);
  assert.equal(Object.hasOwn(user.toObject(), "email"), false);
  assert.equal(Object.hasOwn(user.toObject(), "phone"), false);
});

test("optional identity indexes allow more than one account to omit a field", () => {
  const indexes = new Map(
    User.schema.indexes().map(([keys, options]) => [Object.keys(keys)[0], options]),
  );

  ["emailIdentityKey", "phone", "alias", "username", "googleId"].forEach((field) => {
    assert.equal(indexes.get(field)?.unique, true, `${field} must remain unique`);
    assert.equal(indexes.get(field)?.sparse, true, `${field} must remain sparse`);
  });
});

test("non-empty optional identities remain available to their normal setters", () => {
  assert.equal(normalizeOptionalIdentity("  Customer@Example.com  "), "Customer@Example.com");
  const user = new User({
    name_first: "Real",
    name_last: "Identity",
    email: "  Customer@Example.com  ",
    phone: "09123456789",
  });
  assert.equal(user.email, "customer@example.com");
  assert.equal(user.phone, "09123456789");
});

test("duplicate account fields return customer-safe conflict messages", () => {
  const phoneError = {
    code: 11000,
    keyPattern: { phone: 1 },
    keyValue: { phone: "09123456789" },
  };
  assert.equal(duplicateIdentityField(phoneError), "phone");
  assert.equal(
    duplicateIdentityMessage(phoneError),
    "An account with this mobile number already exists.",
  );
  assert.equal(
    duplicateIdentityMessage({ code: 11000, message: "index: email_1 dup key" }),
    "An account with this email address already exists.",
  );
  assert.equal(
    duplicateIdentityMessage({ code: 11000, keyPattern: { emailIdentityKey: 1 } }),
    "An account with this email address already exists.",
  );
  assert.equal(duplicateIdentityMessage(new Error("Database offline")), "");
});
