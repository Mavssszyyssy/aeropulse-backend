const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("account deletion retires customer equipment and removes cross-module contact data", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "controllers", "userController.js"), "utf8");
  assert.match(source, /Unit\.updateMany/);
  assert.match(source, /status: "retired"/);
  assert.match(source, /"warranty\.status": "void"/);
  assert.match(source, /ServiceRequest\.updateMany/);
  assert.match(source, /Task\.updateMany/);
  assert.match(source, /ContactMessage\.updateMany/);
  assert.match(source, /hiddenFromOperationalInbox: true/);
  assert.match(source, /subject: "Deleted account conversation"/);
  assert.match(source, /\$mergeObjects: \["\$\$event", \{ note: "Conversation removed with deleted account\."/);
  assert.match(source, /address\.street": "Removed with deleted account"/);
});
