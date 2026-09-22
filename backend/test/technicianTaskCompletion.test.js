const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  isInstallationWorkOrder,
  validateTechnicianTaskCompletion,
} = require("../src/domain/technicianTaskCompletion");

test("maintenance work orders are not treated as zero-unit installations", () => {
  const task = {
    title: "Preventive maintenance",
    requestId: "service-request-1",
    payload: { requestId: "service-request-1" },
  };
  assert.equal(isInstallationWorkOrder(task, []), false);
  assert.equal(validateTechnicianTaskCompletion({ task, payload: {}, serialNumbers: [] }).ok, false);
});

test("installation work orders retain QR and photo completion logic", () => {
  const task = { title: "Delivery installation", payload: { orderId: "order-1" } };
  const validation = validateTechnicianTaskCompletion({ task, payload: {}, serialNumbers: ["CAA-001"] });
  assert.equal(isInstallationWorkOrder(task, ["CAA-001"]), true);
  assert.equal(validation.kind, "installation");
  assert.equal(validation.ok, true);
});

test("maintenance completion accepts a complete technician report", () => {
  const task = { title: "Maintenance", payload: { requestId: "service-request-1" } };
  const validation = validateTechnicianTaskCompletion({
    task,
    serialNumbers: [],
    payload: {
      serviceType: "regular_cleaning",
      conditionRating: "good",
      findings: "Evaporator coil had visible dust buildup.",
      resolution: "Cleaned the coil and verified normal cooling.",
    },
  });
  assert.equal(validation.kind, "service");
  assert.equal(validation.ok, true);
});

test("order and service technician events route staff to the correct admin screens", () => {
  const taskController = fs.readFileSync(path.resolve(__dirname, "../src/controllers/taskController.js"), "utf8");
  const orderController = fs.readFileSync(path.resolve(__dirname, "../src/controllers/orderController.js"), "utf8");
  assert.match(taskController, /title: checkedIn \? "Technician checked in"/);
  assert.match(taskController, /route: "\/admin\/services\/technicians"/);
  assert.match(taskController, /Record a verified GPS check-in at the customer location before completing this work order/);
  assert.match(taskController, /Maintenance work orders do not require QR registration/);
  assert.match(taskController, /title: "Technician checked in"/);
  assert.match(taskController, /if \(statusChanged\)/);
  assert.match(taskController, /visitType: "installation"/);
  assert.match(taskController, /ServiceHistory\.findOne\(\{[\s\S]*visitType: "installation"/);
  assert.match(taskController, /serviceType: serviceTypeFor\(service\)/);
  assert.match(taskController, /Admin controls work-order activation/);
  assert.match(taskController, /normalizeStatus\(task\.status\) === "completed" && requestedStatus === "completed"/);
  assert.match(taskController, /normalizeStatus\(task\.status\) === "completed" && status === "completed"/);
  assert.match(taskController, /const technicianReportPayload = \(payload = \{\}\)/);
  assert.match(taskController, /const technicianPayload = req\.authUser\.role === "technician"/);
  assert.match(taskController, /const persistedPayload = req\.authUser\.role === "technician"/);
  assert.match(taskController, /Do not persist the terminal task state until its linked request\/order/);
  assert.match(taskController, /await reconcileCompletedTask\(task\);[\s\S]*task\.status = nextStatus;[\s\S]*await task\.save\(\);/);
  assert.match(taskController, /completionSyncState: "completed"/);
  assert.match(taskController, /completionSynchronized/);
  assert.match(taskController, /runNonBlockingWorkflowStep\([\s\S]*?"service completion customer notification"/);
  assert.match(orderController, /title: "New customer order"[\s\S]*route: "\/admin\/services\/orders"/);
  assert.match(orderController, /type: "technician"[\s\S]*category: "task_assignment"/);
  assert.match(orderController, /dedupeKey: `task-assignment:/);
  assert.match(orderController, /route: taskId[\s\S]*\/technician\/task\/\$\{encodeURIComponent\(taskId\)\}\/information/);
  assert.doesNotMatch(orderController, /title: "Work order awaiting assignment"/);
});

test("notification filtering and warranty decisions preserve workflow integrity", () => {
  const notificationController = fs.readFileSync(path.resolve(__dirname, "../src/controllers/notificationController.js"), "utf8");
  const warrantyController = fs.readFileSync(path.resolve(__dirname, "../src/controllers/warrantyController.js"), "utf8");
  assert.match(notificationController, /limit\(100\)/);
  assert.match(notificationController, /\.slice\(0, 30\)/);
  assert.match(warrantyController, /previousStatus === "service_completed"/);
  assert.match(warrantyController, /claim\.serviceRequestId && previousStatus === "approved" && status !== "approved"/);
  assert.match(warrantyController, /replayed: true/);
});

test("retired technician web screens are not bundled and staff management remains available", () => {
  const app = fs.readFileSync(path.resolve(__dirname, "../../front/src/App.js"), "utf8");
  assert.doesNotMatch(app, /components\/TECH\//);
  assert.match(app, /TechnicianMobileNotice/);
  assert.match(app, /\/admin\/services\/technicians/);
  assert.match(app, /\/superadmin\/technicians/);
  assert.equal(fs.existsSync(path.resolve(__dirname, "../../front/src/components/TECH/Tasks/TaskDetails.js")), false);
});
