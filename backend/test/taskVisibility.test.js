const test = require("node:test");
const assert = require("node:assert/strict");

const Task = require("../src/models/Task");
const {
  buildCustomerTaskScopeQuery,
  listTasks,
} = require("../src/controllers/taskController");

test("customer task visibility is limited to the signed-in customer", () => {
  const query = buildCustomerTaskScopeQuery({
    _id: "customer-123",
    email: "Customer@example.com",
  });

  assert.deepEqual(query.$or.slice(0, 3), [
    { customerId: "customer-123" },
    { "payload.customerId": "customer-123" },
    { "payload.userId": "customer-123" },
  ]);
  assert.equal(query.$or[3].customerEmail.test("customer@example.com"), true);
  assert.equal(query.$or[4]["payload.customerEmail"].test("CUSTOMER@EXAMPLE.COM"), true);
});

test("customer task visibility fails closed without an account identity", () => {
  assert.deepEqual(buildCustomerTaskScopeQuery({}), {
    _id: { $exists: false },
  });
});

test("technician task lists exclude embedded proof media before MongoDB returns rows", async (t) => {
  let selected = "";
  let appliedLimit = 0;
  const chain = {
    select(value) {
      selected = value;
      return this;
    },
    sort() {
      return this;
    },
    limit(value) {
      appliedLimit = value;
      return this;
    },
    lean() {
      return Promise.resolve([{
        _id: "task-1",
        taskCode: "TSK-1",
        title: "Maintenance",
        customer: "Customer",
        address: "Service address",
        assignedTechnicianId: "tech-1",
        status: "pending",
        priority: "medium",
        scheduledDate: "2026-09-14",
        timeSlot: "10:00 AM - 12:00 PM",
        payload: {},
        proof: {},
      }]);
    },
  };
  t.mock.method(Task, "find", () => chain);
  let responseBody;
  const req = {
    authUser: { _id: "tech-1", role: "technician" },
    activeBranch: "Cavite",
    query: {},
  };
  const res = {
    json(value) {
      responseBody = value;
      return value;
    },
    status() {
      return this;
    },
  };

  await listTasks(req, res);

  assert.match(selected, /-proof\.beforePhotos/);
  assert.match(selected, /-payload\.proof/);
  assert.equal(appliedLimit, 100);
  assert.equal(responseBody.tasks[0].id, "task-1");
});
