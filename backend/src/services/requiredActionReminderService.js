const User = require("../models/User");
const Order = require("../models/Order");
const ServiceRequest = require("../models/ServiceRequest");
const Task = require("../models/Task");
const ReorderRequest = require("../models/ReorderRequest");
const ContactMessage = require("../models/ContactMessage");
const { createDedupedNotification } = require("./operationalNotificationService");
const { formatDateKeyInTimeZone } = require("../utils/dateTime");

const STAFF_ROLES = new Set(["admin", "manager", "owner", "superadmin"]);
const REMINDER_WINDOW_MINUTES = 12 * 60;
const PAYMENT_GRACE_MS = 15 * 60 * 1000;
const RECONCILE_THROTTLE_MS = 5 * 60 * 1000;
const lastReconciledByUser = new Map();

const branchForUser = (user = {}) => String(user.activeBranch || user.assignedBranch || "").trim();
const routePrefix = (role) => role === "superadmin" ? "/superadmin" : "/admin";

const createReminder = (user, payload) => createDedupedNotification({
  user: user._id || user.id,
  type: "system",
  category: "required_action",
  severity: "warning",
  targetType: "required_action",
  ...payload,
}, { dedupeMinutes: REMINDER_WINDOW_MINUTES });

const remindCustomer = async (user, now) => {
  const customerId = user._id || user.id;
  const abandonedPayments = await Order.find({
    customer: customerId,
    workflowStatus: "to_pay",
    status: { $ne: "cancelled" },
    $or: [
      { paymentStatus: { $in: ["failed", "expired"] } },
      { paymentStatus: "pending", createdAt: { $lte: new Date(now.getTime() - PAYMENT_GRACE_MS) } },
    ],
  }).select("_id orderCode paymentStatus updatedAt").sort({ updatedAt: -1 }).limit(10).lean();

  return Promise.all(abandonedPayments.map((order) => createReminder(user, {
    type: "payment",
    title: "Action required: complete payment",
    message: `Order ${order.orderCode || order._id} is still waiting for payment. Resume or cancel it from My Orders.`,
    targetId: String(order._id),
    targetType: "order",
    route: "/orders",
    dedupeKey: `required-action:customer-payment:${order._id}:${order.paymentStatus}`,
  })));
};

const remindTechnician = async (user, now) => {
  const userId = String(user._id || user.id || "");
  const dateKey = formatDateKeyInTimeZone(now);
  const tasks = await Task.find({
    assignedTechnicianId: userId,
    scheduledDate: { $lte: dateKey },
    status: { $in: ["accepted", "on-the-way", "arrived", "installing", "in-progress", "on-hold"] },
  }).select("_id taskCode title status scheduledDate timeSlot").sort({ scheduledDate: 1, updatedAt: 1 }).limit(20).lean();

  return Promise.all(tasks.map((task) => {
    const status = String(task.status || "");
    const nextAction = status === "accepted"
      ? "Start travel and record the required GPS arrival check-in."
      : status === "on-the-way"
        ? "Record the required GPS arrival check-in."
        : status === "on-hold"
          ? "Review the hold reason and add the required progress update or reschedule it."
          : "Complete the required service notes, unit verification, and proof before closing the visit.";
    return createReminder(user, {
      type: "technician",
      title: "Action required: finish work-order step",
      message: `${task.taskCode || task.title} is ${status.replace(/-/g, " ")}. ${nextAction}`,
      targetId: String(task._id),
      targetType: "task",
      route: "/technician/tasks",
      dedupeKey: `required-action:technician:${task._id}:${status}:${dateKey}`,
    });
  }));
};

const remindStaff = async (user) => {
  const role = String(user.role || "").toLowerCase();
  const branch = branchForUser(user);
  const branchScope = role === "superadmin" || !branch ? {} : { branch };
  const orderBranchScope = role === "superadmin" || !branch
    ? {}
    : { $or: [{ customerBranch: branch }, { stockSourceBranch: branch }] };
  const prefix = routePrefix(role);

  const [unassignedServices, pendingTasks, newMessages, orderReviews, pendingReorders] = await Promise.all([
    ServiceRequest.countDocuments({
      ...branchScope,
      status: { $in: ["Pending", "Submitted", "Reviewed"] },
      $or: [{ assignedTechnicianId: "" }, { assignedTechnicianId: { $exists: false } }],
    }),
    Task.countDocuments({ ...branchScope, status: "pending", assignedTechnicianId: { $nin: ["", null] } }),
    ContactMessage.countDocuments({ ...branchScope, status: "new" }),
    Order.countDocuments({
      $and: [
        orderBranchScope,
        { $or: [
          { "cancellationRequest.status": "requested" },
          { "refundReview.status": "needs_review" },
        ] },
      ],
    }),
    role === "superadmin" ? ReorderRequest.countDocuments({ status: "submitted" }) : Promise.resolve(0),
  ]);

  const reminders = [];
  if (unassignedServices) reminders.push(createReminder(user, {
    type: "service", title: "Action required: assign service requests",
    message: `${unassignedServices} service request${unassignedServices === 1 ? " is" : "s are"} waiting for technician assignment${branch ? ` in ${branch}` : ""}.`,
    route: `${prefix}/services?tab=service-requests`, dedupeKey: `required-action:service-assignment:${branch || "all"}:${unassignedServices}`,
  }));
  if (pendingTasks) reminders.push(createReminder(user, {
    type: "technician", title: "Action required: activate work orders",
    message: `${pendingTasks} assigned work order${pendingTasks === 1 ? " still needs" : "s still need"} activation or schedule review.`,
    route: `${prefix}/services?tab=technicians`, dedupeKey: `required-action:task-activation:${branch || "all"}:${pendingTasks}`,
  }));
  if (newMessages) reminders.push(createReminder(user, {
    title: "Action required: reply to customers", message: `${newMessages} customer message${newMessages === 1 ? " is" : "s are"} waiting for a response.`,
    targetType: "contact_message", route: `${prefix}/services?tab=customer-messages`, dedupeKey: `required-action:messages:${branch || "all"}:${newMessages}`,
  }));
  if (orderReviews) reminders.push(createReminder(user, {
    type: "order", title: "Action required: review order requests", message: `${orderReviews} cancellation or refund request${orderReviews === 1 ? " requires" : "s require"} review.`,
    targetType: "order", route: `${prefix}/services?tab=orders`, dedupeKey: `required-action:order-review:${branch || "all"}:${orderReviews}`,
  }));
  if (pendingReorders) reminders.push(createReminder(user, {
    type: "inventory", title: "Action required: review reorder approvals", message: `${pendingReorders} inventory reorder request${pendingReorders === 1 ? " is" : "s are"} awaiting approval.`,
    targetType: "reorder", route: "/superadmin/inventory?tab=reorders", dedupeKey: `required-action:reorder-approval:${pendingReorders}`,
  }));
  return Promise.all(reminders);
};

const reconcileRequiredActionsForUser = async (user, { now = new Date(), force = false } = {}) => {
  if (!user || user.notifications?.inApp === false) return [];
  const userKey = String(user._id || user.id || "");
  const lastReconciledAt = Number(lastReconciledByUser.get(userKey) || 0);
  if (!force && lastReconciledAt && now.getTime() - lastReconciledAt < RECONCILE_THROTTLE_MS) return [];
  lastReconciledByUser.set(userKey, now.getTime());
  const role = String(user.role || "customer").toLowerCase();
  if (role === "customer") return remindCustomer(user, now);
  if (role === "technician") return remindTechnician(user, now);
  if (STAFF_ROLES.has(role)) return remindStaff(user);
  return [];
};

const runRequiredActionReminderSweep = async ({ now = new Date(), limit = 250 } = {}) => {
  const users = await User.find({
    isDeleted: { $ne: true },
    accountStatus: { $nin: ["disabled", "deleted"] },
    "notifications.inApp": { $ne: false },
  }).select("_id role activeBranch assignedBranch notifications").limit(Math.min(Math.max(Number(limit) || 250, 1), 500)).lean();
  const stats = { usersScanned: users.length, remindersProcessed: 0, errors: 0 };
  for (let index = 0; index < users.length; index += 10) {
    const batch = users.slice(index, index + 10);
    const results = await Promise.all(batch.map(async (user) => {
      try { return await reconcileRequiredActionsForUser(user, { now, force: true }); }
      catch (error) {
        stats.errors += 1;
        console.warn("Required-action reminder skipped a user", { userId: String(user._id), reason: error.message });
        return [];
      }
    }));
    stats.remindersProcessed += results.flat().filter(Boolean).length;
  }
  return stats;
};

module.exports = { reconcileRequiredActionsForUser, runRequiredActionReminderSweep };
