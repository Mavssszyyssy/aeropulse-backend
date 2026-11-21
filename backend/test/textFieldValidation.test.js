const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { COMMON_TEXT_FIELDS, TEXT_API_ROOTS, validateHumanText, validateTextRequest, textPolicyFor } = require("../src/domain/textFieldValidation");
const { requestTextValidation } = require("../src/middleware/requestTextValidation");
const { changedServiceLogTextError } = require("../src/middleware/workOrderText");
const { validateServiceAreas } = require("../src/domain/branchInputValidation");

test("every human-text policy rejects screenshot nonsense, filler and invisible padding", () => {
  for (const [field, [max, label, kind]] of Object.entries(COMMON_TEXT_FIELDS)) {
    if (kind === "identifier") continue;
    for (const value of ["ssd sd", "jhjhjh", "Ehjdhdhshsh", "Lorem ipsum", "\u200b\u200d", "!!!"]) {
      assert.notEqual(validateHumanText(value, { max, label, kind }), "", `${field}: ${value}`);
    }
  }
  assert.notEqual(validateHumanText("Please check my AC ".repeat(20)), "");
  assert.notEqual(validateHumanText("help shshshshshsh"), "");
});

test("technical identifiers, Filipino concerns and genuine names retain their field-specific rules", () => {
  for (const text of ["May tagas po sa drain line.", "Na-test ang PCB at TXV; hindi pa rin lumalamig.", "R-32 pressure is 120 PSI.", "Nagpalit ng filter at sinubukan ang airflow.", "Noted po.", "LG", "TCL", "PCB", "E7", "BMS offline"]) {
    assert.equal(validateHumanText(text), "", text);
  }
  for (const name of ["Ng", "Sy", "Ana María", "O’Neil", "Jean-Luc", "J. P. Reyes", "J. P.", "Ma. Carmen"]) assert.equal(validateHumanText(name, { kind: "person", max: 60 }), "", name);
  for (const specs of ["12345678", "HSN24IPX3", "2.5 HP", "R-32", "Unit B"]) assert.equal(validateHumanText(specs, { kind: "identifier" }), "", specs);
  assert.match(validateHumanText("<script>", { kind: "identifier" }), /valid unit/);
  assert.match(validateHumanText("Please check the AC unit", { max: 10 }), /10 characters/);
  assert.match(validateHumanText("Please check my air conditioner", { maxWords: 3 }), /3 words/);
});

test("every writable API group applies the same free-text request checks", () => {
  for (const root of TEXT_API_ROOTS) {
    const body = { notes: "jhjhjh" };
    assert.equal(validateTextRequest(`/${root}/example`, "PATCH", body)?.field, "notes", root);
    assert.equal(body.notes, "jhjhjh");
  }
  assert.equal(validateTextRequest("/api/tasks/123", "PATCH", { payload: { proof: { notes: "ssd sd" } } })?.field, "payload.proof.notes");
  assert.equal(validateTextRequest("/tasks/1", "PATCH", { serviceActions: ["Flushed drain", "shshshshshsh"] })?.field, "serviceActions");
  assert.equal(validateTextRequest("/users/profile", "PATCH", { name_first: "jhjhjh" })?.field, "name_first");
  assert.equal(validateTextRequest("/products", "POST", { name: "LG Premium Inverter", sku: "HSN24IPX3", specs: "2.5 HP", brand: "LG" }), null);
  assert.equal(validateTextRequest("/products", "POST", { name: "MDV Inverter", brand: "MDV" }), null);
  assert.equal(validateTextRequest("/auth/register", "POST", { landmark: "Near SM Mall", thoroughfare: "J. P. Rizal Street", apartment_unit: "B" }), null);
  assert.equal(validateTextRequest("/tasks/1", "PATCH", { notes: { text: "Ignore the normal field type" } })?.field, "notes");
  assert.equal(validateTextRequest("/products", "POST", { features: [null] })?.field, "features");
  assert.equal(validateTextRequest("/users/profile", "PATCH", { suffix: "nonsense" })?.field, "suffix");
  assert.equal(validateTextRequest("/users/profile", "PATCH", { suffix: "Jr." }), null);
  assert.equal(validateTextRequest("/users/profile", "PATCH", { suffix: "Ph. D." }), null);
});

test("passwords, authentication, search queries, evidence and historical context are preserved", () => {
  assert.equal(validateTextRequest("/auth/login", "POST", { identifier: "asd123", password: "sD!7jhjhjh_qwerty" }), null);
  assert.equal(validateTextRequest("/tasks?search=ssd+sd", "GET", {}), null);
  assert.equal(validateTextRequest("/orders/paymongo/webhook", "POST", { data: { name: "ssd sd", notes: "jhjhjh" } }), null);
  assert.equal(validateTextRequest("/tasks/1", "PATCH", { proof: { photo: { uri: "data:image/png;base64," + "a".repeat(5000) } }, serviceLogs: [{ id: "old", notes: "jhjhjh" }] }), null);
  assert.equal(validateTextRequest("/tasks/1", "PATCH", { proof: { afterPhotos: [{ name: "IMG_0012.jpg", uri: "data:image/jpeg;base64,AAA" }] } }), null);
  assert.equal(validateTextRequest("/ai/customer-chat", "POST", { message: "May available po bang LG sa Bulacan?", history: [{ role: "user", content: "ssd sd" }] }), null);
  assert.equal(validateTextRequest("/tasks/1", "PATCH", JSON.parse('{"__proto__":{"x":1}}')), null);
  const old = { id: "old", notes: "jhjhjh" };
  assert.equal(changedServiceLogTextError([old], [old]), "");
  assert.match(changedServiceLogTextError([{ ...old, notes: "ssd sd" }], [old]), /meaningful/);
  assert.match(changedServiceLogTextError([{ id: "new", label: "jhjhjh" }], []), /meaningful/);
  assert.equal(changedServiceLogTextError([{ ...old, label: "jhjhjh", hoursSpent: 2 }], [{ ...old, label: "jhjhjh" }]), "");
});

test("service areas must exist in the reference rather than merely resemble words", () => {
  for (const area of ["ssd sd", "blabla place", "Some imaginary city", "Unknownville"]) assert.ok(validateServiceAreas(area).error, area);
  for (const area of ["Pasay City", "Metro Manila", "Quezon City", "Sto. Niño", "Barangay 1", "Biñan", "Santo Niño (Pob.)"]) assert.ok(!validateServiceAreas(area).error, area);
});

test("server rejects bad input before the handler can persist it or send notifications", () => {
  for (const [url, body] of [["/api/branches", { name: "MOA", coverageAreas: "ssd sd" }], ["/api/parts-requests", { partName: "PCB", reason: "jhjhjh" }], ["/api/tasks/1", { payload: { findings: "shshshshshsh" } }], ["/api/users/addresses", { city: "Imaginaryville" }]]) {
    let next = false;
    const res = { status(code) { this.code = code; return this; }, json(data) { this.data = data; } };
    requestTextValidation({ originalUrl: url, method: "POST", body }, res, () => { next = true; });
    assert.equal(next, false);
    assert.equal(res.code, 400);
    assert.ok(Object.keys(res.data.errors).length);
  }
});

test("controller text inputs remain explicitly covered as the system grows", () => {
  // These are containers, generated staff display values, enum actions, and an
  // authentication identifier, rather than editable natural-language fields.
  const nonProse = new Set(["action", "assignedTechnicianName", "technicianName", "billingAddress", "partsCost", "username"]);
  const directory = path.join(__dirname, "../src/controllers");
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(directory, file), "utf8");
    for (const match of source.matchAll(/\b(?:req\.body\??\.|payload\??\.|input\??\.)([A-Za-z_]\w*)/g)) {
      const key = match[1];
      if (!/name|note|reason|desc|advice|finding|resol|action|concern|address|street|other|title|part|label|supplier|instruct|message|summary|remark/i.test(key) || nonProse.has(key)) continue;
      assert.ok(textPolicyFor(key, { root: key === "message" ? "contact-messages" : "users" }), `${file}: ${key} needs an input policy`);
    }
  }
});
