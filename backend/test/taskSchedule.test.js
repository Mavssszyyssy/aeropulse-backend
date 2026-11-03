const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const {
  buildTaskScheduleDetails,
  normalizeTaskSchedule,
  serviceCategory,
} = require("../src/domain/taskSchedule");

test("normalizes a single assigned technician schedule and ignores obsolete team input", () => {
  assert.deepEqual(normalizeTaskSchedule(
    { driverName: "  Driver A  ", notes: "  Bring ladder.  ", teamMemberIds: ["legacy-tech"] },
    [{ id: "tech-2", name: "Tech Two" }, { id: "tech-2", name: "Tech Two" }],
  ), {
    driverName: "Driver A",
    notes: "Bring ladder.",
  });
});

test("builds an installation schedule snapshot from the linked order", () => {
  const task = { taskCode: "TSK-1", title: "Fulfill order", payload: { orderId: "order-1" } };
  const details = buildTaskScheduleDetails(task, { order: {
    orderCode: "ORD-1",
    paymentMethod: "gcash",
    paymentStatus: "paid",
    items: [{ name: "Split AC", quantity: 2 }],
  } });
  assert.equal(details.category, "installation");
  assert.equal(details.reference, "ORD-1");
  assert.equal(details.paymentMethod, "GCash");
  assert.equal(details.paymentStatus, "paid");
  assert.equal(details.workDescription, "2 × Split AC");
});

test("classifies cleaning and service work without inventing missing fields", () => {
  assert.equal(serviceCategory({ issueType: "Deep Cleaning" }), "deep_cleaning");
  assert.equal(serviceCategory({ issueType: "Regular Cleaning" }), "regular_cleaning");
  const details = buildTaskScheduleDetails({ taskCode: "TSK-2", issueType: "Check-up", payload: {} });
  assert.equal(details.category, "service_checkup");
  assert.equal(details.paymentMethod, "");
  assert.equal(details.sellerPersonnel, "");
  assert.equal(details.otherExpenses, null);
});

const taskControllerSource = fs.readFileSync(require.resolve("../src/controllers/taskController"), "utf8");

test("schedule responses use the saved task date and time over stale embedded order data", () => {
  const start = taskControllerSource.indexOf("const hydrateTaskResponse =");
  const source = taskControllerSource.slice(start, taskControllerSource.indexOf("\nconst getTaskUnitSummary =", start));
  const hydrateTaskResponse = vm.runInNewContext(`${source}\nhydrateTaskResponse`, {
    withoutObsoleteTeamAssignment: (value) => value,
    withoutEmbeddedProofMedia: (value) => value,
    getRegistrationProgress: () => ({}),
    serviceCosts: () => ({}),
    singleTechnicianSchedule: (task) => task.schedule,
  });
  const task = {
    taskCode: "TSK-1", scheduledDate: "2099-10-18", timeSlot: "1:00 PM - 4:00 PM",
    assignedTechnicianId: "tech-1", status: "pending", schedule: { notes: "Bring ladder" },
    payload: { scheduledDate: "2099-10-17", timeSlot: "9:00 AM - 12:00 PM", orderId: "order-1" },
    toJSON() { return { id: "task-1", ...this }; },
  };
  const result = hydrateTaskResponse(task);
  assert.equal(result.scheduledDate, "2099-10-18");
  assert.equal(result.timeSlot, "1:00 PM - 4:00 PM");
  assert.equal(result.schedule.notes, "Bring ladder");
  assert.equal(result.orderId, "order-1");
});

test("superadmin work orders require a valid branch before any account is assigned", async () => {
  const start = taskControllerSource.indexOf("const createTask =");
  const source = taskControllerSource.slice(start, taskControllerSource.indexOf("\nconst updateTask =", start));
  let saved = 0;
  const createTask = vm.runInNewContext(`${source}\ncreateTask`, {
    withoutObsoleteTeamAssignment: (value) => value,
    parseTaskPriority: (value) => ["urgent", "high", "medium", "normal", "low"].includes(String(value).trim().toLowerCase()) ? String(value).trim().toLowerCase() : null,
    getScheduledAppointmentError: () => "",
    getServiceAppointmentError: () => "",
    normalizeStatus: (status) => status || "pending",
    BRANCHES: ["Bulacan", "Cavite"],
    resolveTaskTechnician: async (id, branch) => {
      assert.equal(branch, "Bulacan");
      return { _id: id, name: "Bulacan Technician", assignedBranch: "Bulacan" };
    },
    getTechnicianDisplayName: (technician) => technician.name,
    normalizeTaskSchedule: (schedule) => schedule,
    assertNoTaskScheduleConflict: async () => {},
    notifyTaskAssignment: async () => {},
    hydrateTaskResponse: (task) => task,
    Task: class { constructor(fields) { Object.assign(this, fields); } async save() { saved += 1; } },
  });
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const body = { branch: "Unknown", assignedTechnicianId: "tech-bulacan", scheduledDate: "2099-10-18", timeSlot: "1:00 PM - 4:00 PM" };
  const invalid = response();
  await createTask({ authUser: { role: "superadmin" }, body }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(saved, 0);
  const invalidPriority = response();
  await createTask({ authUser: { role: "superadmin" }, body: { ...body, branch: "Bulacan", priority: "critical" } }, invalidPriority);
  assert.equal(invalidPriority.statusCode, 400);
  assert.equal(saved, 0);
  const valid = response();
  await createTask({ authUser: { role: "superadmin" }, body: { ...body, branch: "Bulacan" } }, valid);
  assert.equal(valid.statusCode, 201);
  assert.equal(valid.body.task.branch, "Bulacan");
  assert.equal(saved, 1);
});

test("work-order priorities include technician mobile values and reject invalid assignments", async () => {
  const { TASK_PRIORITIES, parseTaskPriority } = require("../src/domain/taskPriority");
  const Task = require("../src/models/Task");
  assert.deepEqual(TASK_PRIORITIES, ["urgent", "high", "medium", "normal", "low"]);
  assert.deepEqual(Task.schema.path("priority").enumValues, TASK_PRIORITIES);
  assert.equal(parseTaskPriority(" Urgent "), "urgent");
  assert.equal(parseTaskPriority("critical"), null);
  for (const priority of TASK_PRIORITIES) {
    const task = new Task({ taskCode: `test-${priority}`, title: "Service", customer: "Customer", address: "Address", assignedTechnicianId: "tech", scheduledDate: "2099-01-01", timeSlot: "9:00 AM - 12:00 PM", priority });
    await task.validate();
  }
});
