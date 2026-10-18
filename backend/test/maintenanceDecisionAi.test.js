const test = require("node:test");
const assert = require("node:assert/strict");
const env = require("../src/config/env");
const Task = require("../src/models/Task");
const ServiceRequest = require("../src/models/ServiceRequest");
const ServiceHistory = require("../src/models/ServiceHistory");
const Unit = require("../src/models/Unit");
const { buildEvidence, hasSufficientPostEvidence, getUnitDecisionSupport, getTaskDecisionSupport, generateRequestPreAssessment, generateTaskPreAssessment, generateFuturePrediction } = require("../src/controllers/maintenanceDecisionController");
const { generateMaintenanceAssessment, validAssessment } = require("../src/services/maintenanceDecisionAiService");

const evidence = [
  { id: "equipment", label: "Equipment", text: "LG Dual Inverter split 1.5 HP" },
  { id: "reported_issue", label: "Customer report", text: "Hindi na lumalamig yung aircon at may kakaibang tunog." },
];
const pre = {
  english_interpretation: "The unit is not cooling adequately and makes an unusual sound.",
  possible_problem: "Airflow, refrigerant-circuit, or fan concerns need inspection; no defect is confirmed.",
  evidence_ids: ["reported_issue"],
  parts_to_bring: [{ name: "Compatible filter sample", reason: "Check fit only after identifying the unit filter.", evidence_ids: ["reported_issue"] }],
  replace_only_after_diagnosis: [{ name: "Fan component", only_if: "Inspection confirms a faulty part and model compatibility.", evidence_ids: ["reported_issue"] }],
  tools_and_materials: [{ name: "Thermometer", reason: "Measure cooling performance.", evidence_ids: ["reported_issue"] }],
  reason_for_recommendation: "The customer reports poor cooling and noise, but the cause is unknown.",
  priority: "medium", confidence: "limited", diagnostic_actions: ["Inspect airflow and locate the sound before changing parts."],
  safety_flags: [], missing_evidence: ["No technician readings or inspection yet."],
};
const postEvidence = buildEvidence({ kind: "post", unit: { brand: "LG", modelName: "Dual Inverter" },
  request: { issue: "Cooling issue" },
  history: { findings: "Cleaned condenser coil, okay na cooling pero may slight vibration sa outdoor fan.",
    actionTaken: "Cleaned condenser coil and tested cooling.", partsUsed: [], conditionRating: "good" } });
const post = {
  english_interpretation: "Cooling is restored after cleaning, but slight outdoor fan vibration remains.",
  possible_future_issue: "The source of remaining fan vibration needs monitoring; failure is not confirmed.",
  component_to_monitor: "Outdoor fan assembly", evidence_ids: ["current_findings"],
  supporting_findings: ["Slight vibration remained after cleaning."], risk_level: "medium", confidence: "moderate",
  preventive_actions: ["Inspect fan mounting and vibration at the next visit."],
  follow_up: "Inspect earlier if vibration worsens.", safety_flags: [], missing_evidence: ["No vibration measurements recorded."],
};

test("Tagalog report and Taglish completed note stay separate from their English interpretation", () => {
  assert.equal(validAssessment("pre", pre, evidence), true);
  assert.equal(validAssessment("post", post, postEvidence), true);
  assert.match(JSON.stringify(postEvidence), /okay na cooling pero may slight vibration/);
  assert.match(JSON.stringify(evidence), /Hindi na lumalamig/);
  assert.equal(validAssessment("post", { ...post, evidence_ids: ["fabricated_visit"] }, postEvidence), false);
});

test("pre-visit evidence includes only saved observations from an open work order, preserving Tagalog wording", () => {
  const task = { status: "in-progress", payload: {
    findings: "Hindi lumalamig, may mahinang ingay sa fan.",
    notes: "Wala pang nasusukat na refrigerant pressure.",
    customerPhone: "private-contact",
    serviceLogs: [
      { findings: "Hindi lumalamig, may mahinang ingay sa fan.", notes: "May panginginig din sa outdoor unit.", resolution: "private-completed-work" },
      { findings: "Marumi ang filter pero hindi pa nakumpirma ang sira.", notes: "" },
    ],
  } };
  const facts = buildEvidence({ kind: "pre", request: { issue: "Air conditioner is not cooling" }, task });
  assert.equal(facts.find(item => item.id === "in_progress_findings")?.text, task.payload.findings);
  assert.equal(facts.find(item => item.id === "in_progress_notes")?.text, task.payload.notes);
  assert.equal(facts.filter(item => item.text === task.payload.findings).length, 1);
  assert.match(JSON.stringify(facts), /hindi pa nakumpirma/);
  assert.doesNotMatch(JSON.stringify(facts), /private-contact|private-completed-work/);
  assert.equal(buildEvidence({ kind: "pre", task: { ...task, status: "completed" } }).length, 0);
});

test("AMP unit assessments are scoped to the selected AC and the admin's branch", async () => {
  const originalUnitFind = Unit.findById;
  const originalRequestFind = ServiceRequest.findOne;
  const originalHistoryFind = ServiceHistory.findOne;
  const unitId = "507f1f77bcf86cd799439013";
  const queries = [];
  Unit.findById = () => ({ lean: async () => ({ _id: unitId, serviceBranch: "Cavite" }) });
  ServiceRequest.findOne = (query) => { queries.push(query); return { sort: () => ({ lean: async () => ({ _id: "507f1f77bcf86cd799439011", status: "Submitted", aiPreAssessment: { status: "completed" } }) }) }; };
  ServiceHistory.findOne = (query) => { queries.push(query); return { sort: () => ({ lean: async () => ({ sourceTaskId: "task-1", aiFuturePrediction: { status: "completed" } }) }) }; };
  const respond = () => ({ code: 200, status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } });
  try {
    const cavite = respond();
    await getUnitDecisionSupport({ authUser: { role: "admin" }, activeBranch: "Cavite", params: { unitId } }, cavite);
    assert.equal(cavite.code, 200);
    assert.equal(cavite.body.request.id, "507f1f77bcf86cd799439011");
    assert.equal(cavite.body.lastVisit.taskId, "task-1");
    assert.equal(queries[0].unitId, unitId);
    assert.equal(queries[0].branch, "Cavite");
    assert.equal(String(queries[1].unit), unitId);
    const otherBranch = respond();
    await getUnitDecisionSupport({ authUser: { role: "admin" }, activeBranch: "Bulacan", params: { unitId } }, otherBranch);
    assert.equal(otherBranch.code, 404);
    assert.equal(queries.length, 2);
  } finally {
    Unit.findById = originalUnitFind;
    ServiceRequest.findOne = originalRequestFind;
    ServiceHistory.findOne = originalHistoryFind;
  }
});

test("completed capacitor repair can report no supported future failure", () => {
  const complete = { ...post, possible_future_issue: "No specific future component failure is supported by the completed report.", component_to_monitor: "No specific component", risk_level: "low", confidence: "limited", follow_up: "Continue regular preventive maintenance." };
  const facts = buildEvidence({ kind: "post", history: { findings: "Replaced capacitor, cleaned filters, tested unit, normal operation.", actionTaken: "Replaced capacitor and tested operation.", partsUsed: ["capacitor"] } });
  assert.equal(validAssessment("post", { ...complete, evidence_ids: ["current_findings"] }, facts), true);
  assert.match(JSON.stringify(facts), /Replaced capacitor/);
});

test("a bare 'Okay na' report is insufficient; a detailed completed repair is eligible", () => {
  assert.equal(hasSufficientPostEvidence({ findings: "Okay na.", actionTaken: "" }), false);
  assert.equal(hasSufficientPostEvidence({ findings: "Replaced capacitor, cleaned filters, tested unit, normal operation.", actionTaken: "Replaced capacitor." }), true);
});

test("provider request uses structured output and rejects unsupported or failed replies without a fake assessment", async () => {
  const originalKey = env.openAiApiKey;
  env.openAiApiKey = "test-server-only-key";
  try {
    let body;
    const successful = async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, headers: { get: () => "test-request" }, json: async () => ({ status: "completed", output_text: JSON.stringify(pre) }) };
    };
    const result = await generateMaintenanceAssessment({ kind: "pre", evidence, actorId: "technician-1" }, { provider: successful });
    assert.equal(result.status, "completed");
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, "json_schema");
    assert.match(body.input[1].content[0].text, /Hindi na lumalamig/);
    assert.match(body.input[0].content[0].text, /faithful plain-English interpretation/);
    assert.match(body.input[0].content[0].text, /preserving uncertainty/);
    assert.equal(body.input[1].content[0].text.includes("test-server-only-key"), false);
    const invalid = await generateMaintenanceAssessment({ kind: "pre", evidence }, { provider: async () => ({ ok: true, headers: { get: () => "" }, json: async () => ({ status: "completed", output_text: JSON.stringify({ ...pre, evidence_ids: ["fake"] }) }) }) });
    assert.equal(invalid.status, "unavailable");
    assert.equal(invalid.assessment, undefined);
    const failed = await generateMaintenanceAssessment({ kind: "pre", evidence }, { provider: async () => { throw new Error("network down"); } });
    assert.equal(failed.status, "unavailable");
    assert.equal(failed.assessment, undefined);
  } finally { env.openAiApiKey = originalKey; }
});

test("technician cannot read another technician's work-order assessment", async () => {
  const originalFind = Task.findOne;
  Task.findOne = async () => ({ assignedTechnicianId: "someone-else", schedule: { teamMemberIds: [] }, branch: "Cavite" });
  try {
    let status = 200; let response;
    await getTaskDecisionSupport({ authUser: { role: "technician", _id: "current-tech" }, activeBranch: "Cavite", params: { taskId: "TASK-1" } }, {
      status(code) { status = code; return this; }, json(value) { response = value; return this; },
    });
    assert.equal(status, 404);
    assert.equal(response.message, "Work order not found.");
  } finally { Task.findOne = originalFind; }
});

test("admin generation persists advice beside, not over, the original service request", async () => {
  const originalKey = env.openAiApiKey;
  const originalFetch = global.fetch;
  const originalFind = ServiceRequest.findById;
  const originalUpdate = ServiceRequest.updateOne;
  const request = { _id: "507f1f77bcf86cd799439011", branch: "Cavite", status: "Submitted", issue: "General AC problem",
    payload: { concern: "Hindi na lumalamig yung aircon at may kakaibang tunog." }, unitId: "" };
  let write;
  env.openAiApiKey = "test-key";
  ServiceRequest.findById = async () => request;
  ServiceRequest.updateOne = async (_filter, change) => { write = change.$set; };
  global.fetch = async () => ({ ok: true, headers: { get: () => "req-test" }, json: async () => ({ status: "completed", output_text: JSON.stringify(pre) }) });
  try {
    let status = 200; let response;
    await generateRequestPreAssessment({ authUser: { role: "admin", _id: "admin-1" }, activeBranch: "Cavite", params: { requestId: String(request._id) } }, {
      status(code) { status = code; return this; }, json(value) { response = value; return this; },
    });
    assert.equal(status, 200);
    assert.equal(response.preAssessment.status, "completed");
    assert.match(JSON.stringify(write.aiPreAssessment.evidence), /Hindi na lumalamig/);
    assert.deepEqual(Object.keys(write), ["aiPreAssessment"]);
    assert.equal(request.issue, "General AC problem");
  } finally {
    env.openAiApiKey = originalKey; global.fetch = originalFetch;
    ServiceRequest.findById = originalFind; ServiceRequest.updateOne = originalUpdate;
  }
});

test("provider failure keeps a prior assessment and is not reported as backend connectivity loss", async () => {
  const originalKey = env.openAiApiKey;
  const originalFetch = global.fetch;
  const originalFind = ServiceRequest.findById;
  const originalUpdate = ServiceRequest.updateOne;
  const priorAssessment = { status: "completed", assessment: pre, generatedAt: new Date() };
  const request = { _id: "507f1f77bcf86cd799439011", branch: "Cavite", status: "In Progress",
    issue: "Air conditioner is not cooling properly", unitId: "", payload: {}, aiPreAssessment: priorAssessment };
  let writes = 0;
  env.openAiApiKey = "test-key";
  ServiceRequest.findById = async () => request;
  ServiceRequest.updateOne = async () => { writes += 1; };
  global.fetch = async () => ({ ok: false, status: 503 });
  try {
    const response = { code: 200, status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } };
    await generateRequestPreAssessment({ authUser: { role: "admin", _id: "admin-1" }, activeBranch: "Cavite", params: { requestId: String(request._id) } }, response);
    assert.equal(response.code, 424);
    assert.equal(response.body.preAssessment, priorAssessment);
    assert.equal(writes, 0);
    assert.match(response.body.message, /unavailable right now/);
  } finally {
    env.openAiApiKey = originalKey; global.fetch = originalFetch;
    ServiceRequest.findById = originalFind; ServiceRequest.updateOne = originalUpdate;
  }
});

test("admin and assigned technician send only matching saved work-order observations for a pre-visit assessment", async () => {
  const originals = { key: env.openAiApiKey, fetch: global.fetch, taskFindById: Task.findById,
    taskFindOne: Task.findOne, requestFind: ServiceRequest.findById, requestUpdate: ServiceRequest.updateOne,
    unitFind: Unit.findById, historyFind: ServiceHistory.find };
  const taskId = "507f1f77bcf86cd799439012";
  const requestId = "507f1f77bcf86cd799439011";
  const unitId = "507f1f77bcf86cd799439013";
  const request = { _id: requestId, branch: "Cavite", unitId, status: "In Progress",
    payload: { concern: "Hindi lumalamig at may kakaibang ingay.", linkedTaskId: taskId } };
  const task = { _id: taskId, taskCode: "TASK-1", status: "in-progress", branch: "Cavite", unitId,
    assignedTechnicianId: "tech-1", payload: { requestId, findings: "May ingay sa fan pero hindi pa nasuri ang motor.",
      notes: "Wala pang confirmed na sira.", customerPhone: "private-contact" } };
  const sent = [];
  const writes = [];
  env.openAiApiKey = "test-key";
  Task.findById = async () => task;
  Task.findOne = async () => task;
  ServiceRequest.findById = async () => request;
  ServiceRequest.updateOne = async (_filter, change) => { writes.push(change.$set); };
  Unit.findById = () => ({ lean: async () => ({ _id: unitId, brand: "LG", serviceBranch: "Cavite" }) });
  ServiceHistory.find = () => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) });
  global.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body).input[1].content[0].text);
    return { ok: true, headers: { get: () => "req-pre" }, json: async () => ({ status: "completed", output_text: JSON.stringify(pre) }) };
  };
  const respond = () => ({ code: 200, status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } });
  try {
    const admin = respond();
    await generateRequestPreAssessment({ authUser: { role: "admin", _id: "admin-1" }, activeBranch: "Cavite", params: { requestId } }, admin);
    const technician = respond();
    await generateTaskPreAssessment({ authUser: { role: "technician", _id: "tech-1" }, activeBranch: "Cavite", params: { taskId } }, technician);
    assert.equal(admin.code, 200);
    assert.equal(technician.code, 200);
    assert.equal(sent.length, 2);
    for (const payload of sent) {
      assert.match(payload, /May ingay sa fan pero hindi pa nasuri ang motor/);
      assert.match(payload, /Wala pang confirmed na sira/);
      assert.doesNotMatch(payload, /private-contact/);
    }
    assert.equal(writes.length, 2);
    assert.deepEqual(Object.keys(writes[0]), ["aiPreAssessment"]);
    assert.equal(task.payload.findings, "May ingay sa fan pero hindi pa nasuri ang motor.");

    request.unitId = "507f1f77bcf86cd799439099";
    const mismatch = respond();
    await generateTaskPreAssessment({ authUser: { role: "technician", _id: "tech-1" }, activeBranch: "Cavite", params: { taskId } }, mismatch);
    assert.equal(mismatch.code, 409);
    assert.equal(sent.length, 2);
  } finally {
    env.openAiApiKey = originals.key; global.fetch = originals.fetch;
    Task.findById = originals.taskFindById; Task.findOne = originals.taskFindOne;
    ServiceRequest.findById = originals.requestFind; ServiceRequest.updateOne = originals.requestUpdate;
    Unit.findById = originals.unitFind; ServiceHistory.find = originals.historyFind;
  }
});

test("completed Taglish visit saves a separate future assessment on its service history", async () => {
  const originals = { key: env.openAiApiKey, fetch: global.fetch,
    taskFind: Task.findOne, historyFindOne: ServiceHistory.findOne, historyFind: ServiceHistory.find,
    historyUpdate: ServiceHistory.updateOne, unitFind: Unit.findById };
  const taskId = "507f1f77bcf86cd799439012";
  const unitId = "507f1f77bcf86cd799439013";
  const visit = { _id: "507f1f77bcf86cd799439014", unit: unitId,
    findings: "Cleaned condenser coil, okay na cooling pero may slight vibration sa outdoor fan.",
    actionTaken: "Cleaned condenser coil and tested cooling.", partsUsed: [], conditionRating: "good" };
  let write;
  env.openAiApiKey = "test-key";
  global.fetch = async () => ({ ok: true, headers: { get: () => "req-post" }, json: async () => ({ status: "completed", output_text: JSON.stringify(post) }) });
  Task.findOne = async () => ({ _id: taskId, status: "completed", branch: "Cavite", assignedTechnicianId: "tech-1", payload: {} });
  ServiceHistory.findOne = async () => visit;
  ServiceHistory.find = () => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) });
  ServiceHistory.updateOne = async (_filter, change) => { write = change.$set; };
  Unit.findById = () => ({ lean: async () => ({ _id: unitId, brand: "LG", modelName: "Dual Inverter", serviceBranch: "Cavite" }) });
  try {
    let status = 200; let response;
    await generateFuturePrediction({ authUser: { role: "technician", _id: "tech-1" }, activeBranch: "Cavite", params: { taskId } }, {
      status(code) { status = code; return this; }, json(value) { response = value; return this; },
    });
    assert.equal(status, 200);
    assert.equal(response.futurePrediction.status, "completed");
    assert.match(JSON.stringify(write.aiFuturePrediction.evidence), /slight vibration sa outdoor fan/);
    assert.deepEqual(Object.keys(write), ["aiFuturePrediction"]);
    assert.match(visit.findings, /okay na cooling/);
  } finally {
    env.openAiApiKey = originals.key; global.fetch = originals.fetch;
    Task.findOne = originals.taskFind; ServiceHistory.findOne = originals.historyFindOne;
    ServiceHistory.find = originals.historyFind; ServiceHistory.updateOne = originals.historyUpdate;
    Unit.findById = originals.unitFind;
  }
});
