const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("destructive QA utilities require a separately named isolated database", () => {
  const acceptance = fs.readFileSync(path.join(__dirname, "..", "scripts", "acceptance-e2e.js"), "utf8");
  const reset = fs.readFileSync(path.join(__dirname, "..", "maintenance_reset_users.js"), "utf8");
  assert.match(acceptance, /ACCEPTANCE_EXPECTED_DATABASE/);
  assert.match(acceptance, /databaseName/);
  assert.match(acceptance, /cannot run against a production backend/);
  assert.match(reset, /RESET_ISOLATED_QA/);
  assert.match(reset, /\(_qa\|_e2e\)/);
});

test("the retired-authentication migration is dry-run by default and preserves live sessions", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "remove-authenticator-data.js"),
    "utf8",
  );
  assert.match(migration, /process\.argv\.includes\("--apply"\)/);
  assert.match(migration, /CONFIRM_REMOVE_AUTHENTICATOR_DATA/);
  assert.match(migration, /REMOVE_AUTHENTICATOR_EXPECTED_DATABASE/);
  assert.match(migration, /passwordReset: ""/);
  assert.match(migration, /"security\.totpSecretEncrypted": ""/);
  assert.doesNotMatch(migration.match(/const OBSOLETE_AUTH_FIELDS = \{[\s\S]*?\n\};/)?.[0] || "", /sessionVersion/);
});
