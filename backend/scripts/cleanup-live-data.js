/* eslint-disable no-console */
// Guarded cleanup for the approved presentation-database residue. The script
// is read-only unless --apply and the exact confirmation phrase are supplied.
const path = require("path");
const mongoose = require("mongoose");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const connectDb = require("../src/config/db");
const User = require("../src/models/User");
const Order = require("../src/models/Order");
const Task = require("../src/models/Task");
const Unit = require("../src/models/Unit");
const Product = require("../src/models/Product");
const ServiceRequest = require("../src/models/ServiceRequest");
const Notification = require("../src/models/Notification");
const { PROTECTED_DEMO_STAFF, isProtectedDemoStaff } = require("../src/domain/demoStaffPolicy");
const { isNonRetailCatalogProduct } = require("../src/domain/catalogVisibility");

const args = new Set(process.argv.slice(2));
const shouldApply = args.has("--apply");
const allowNonTransactional = args.has("--allow-nontransactional");
const confirmation = process.env.LIVE_DATA_CLEANUP_CONFIRM || "";
const expectedDatabase = String(process.env.LIVE_DATA_CLEANUP_EXPECTED_DATABASE || "").trim();
const CONFIRMATION = "CLEAN_APPROVED_PRESENTATION_DATA";
const normalized = (value) => String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
const buildPlan = async () => {
  const [users, orders, tasks, units, products, serviceRequests] = await Promise.all([
    User.find({ isDeleted: { $ne: true }, accountStatus: { $ne: "deleted" } })
      .select("alias email role assignedBranch activeBranch name name_first name_last")
      .lean(),
    Order.find({}).select("orderCode workflowStatus deliveryStatus stockReservationStatus cancelledAt updatedAt items.productId").limit(5000).lean(),
    Task.find({}).select("taskCode status completedAt orderId payload assignedTechnicianId").limit(5000).lean(),
    Unit.find({ status: { $ne: "retired" } }).select("serialNumber customer productId status").limit(5000).lean(),
    Product.find({}).select("name sku brand stock isActive serialUnits.status").limit(5000).lean(),
    ServiceRequest.find({}).select("status linkedTaskId payload").limit(5000).lean(),
  ]);

  const activeUserIds = new Set(users.map((user) => String(user._id)));
  const productIds = new Set(products.map((product) => String(product._id)));
  const orderIds = new Set(orders.map((order) => String(order._id)));
  const taskIds = new Set(tasks.map((task) => String(task._id)));
  const protectedAliases = new Set(PROTECTED_DEMO_STAFF.map(([alias]) => alias));
  const extraStaff = users.filter((user) => user.role !== "customer" && !isProtectedDemoStaff(user));
  const missingProtectedAliases = [...protectedAliases].filter(
    (alias) => !users.some((user) => String(user.alias || "").trim().toLowerCase() === alias),
  );

  const completeOrders = orders.filter((order) => normalized(order.workflowStatus) === "complete" && (
    normalized(order.deliveryStatus) !== "completed" || normalized(order.stockReservationStatus) !== "consumed"
  ));
  const cancelledOrders = orders.filter((order) => normalized(order.workflowStatus) === "cancelled" && (
    normalized(order.deliveryStatus) !== "cancelled" || normalized(order.stockReservationStatus) !== "released"
  ));
  const orphanTasks = tasks.filter((task) => {
    const orderId = String(task.orderId || task.payload?.orderId || "").trim();
    return orderId && mongoose.isValidObjectId(orderId) && !orderIds.has(orderId);
  });
  const staleServiceRequests = serviceRequests.filter((request) => {
    const taskId = String(request.linkedTaskId || request.payload?.linkedTaskId || "").trim();
    return taskId && mongoose.isValidObjectId(taskId) && !taskIds.has(taskId);
  });
  const unownedUnits = units.filter((unit) => unit.customer && !activeUserIds.has(String(unit.customer)));
  const missingProductUnits = units.filter((unit) => unit.productId && !productIds.has(String(unit.productId)));
  const openOrderProductIds = new Set(
    orders
      .filter((order) => !["complete", "cancelled"].includes(normalized(order.workflowStatus)))
      .flatMap((order) => (order.items || []).map((item) => String(item.productId || "")))
      .filter(Boolean),
  );
  const activeNonRetailProducts = products.filter(
    (product) => product.isActive !== false && isNonRetailCatalogProduct(product),
  );
  const nonRetailProductsBlockedByOpenOrders = activeNonRetailProducts.filter((product) =>
    openOrderProductIds.has(String(product._id)),
  );
  const nonRetailProductsToArchive = activeNonRetailProducts.filter((product) =>
    !openOrderProductIds.has(String(product._id)),
  );

  return {
    users,
    extraStaff,
    missingProtectedAliases,
    completeOrders,
    cancelledOrders,
    orphanTasks,
    staleServiceRequests,
    unownedUnits,
    missingProductUnits,
    nonRetailProductsToArchive,
    nonRetailProductsBlockedByOpenOrders,
  };
};

const summarize = (plan) => ({
  database: mongoose.connection.name,
  mode: shouldApply ? "apply" : "dry-run",
  missingProtectedAliases: plan.missingProtectedAliases,
  extraStaff: plan.extraStaff.map((user) => ({ alias: user.alias || "(no alias)", role: user.role })),
  completeOrdersToNormalize: plan.completeOrders.map((order) => order.orderCode),
  cancelledOrdersToNormalize: plan.cancelledOrders.map((order) => order.orderCode),
  orphanTasksToClose: plan.orphanTasks.map((task) => task.taskCode),
  staleServiceRequestLinksToClear: plan.staleServiceRequests.map((request) => String(request._id)),
  unownedUnitsToRetire: plan.unownedUnits.map((unit) => unit.serialNumber),
  missingProductUnitsToRetire: plan.missingProductUnits.map((unit) => unit.serialNumber),
  nonRetailProductsToArchive: plan.nonRetailProductsToArchive.map((product) => ({ name: product.name, sku: product.sku })),
  nonRetailProductsBlockedByOpenOrders: plan.nonRetailProductsBlockedByOpenOrders.map((product) => ({ name: product.name, sku: product.sku })),
});

const runCleanupOperations = async (plan, session = null) => {
  if (plan.missingProtectedAliases.length) {
    throw new Error(`Refusing cleanup because protected accounts are missing: ${plan.missingProtectedAliases.join(", ")}`);
  }
  const technician = plan.users.find((user) => String(user.alias || "").toLowerCase() === "tech.main");
  if (!technician) throw new Error("Refusing cleanup because tech.main is unavailable.");
  const technicianName = String(
    technician.name || `${technician.name_first || "Technician"} ${technician.name_last || "User"}`,
  ).trim();
  const extraStaffIds = plan.extraStaff.map((user) => user._id);
  const extraStaffIdStrings = extraStaffIds.map(String);
  const now = new Date();
  const options = session ? { session } : {};
      if (extraStaffIdStrings.length) {
        await Promise.all([
          Task.updateMany(
            { assignedTechnicianId: { $in: extraStaffIdStrings } },
            { $set: { assignedTechnicianId: String(technician._id), assignedTechnicianName: technicianName } },
            options,
          ),
          Order.updateMany(
            { assignedTechnicianId: { $in: extraStaffIdStrings } },
            { $set: { assignedTechnicianId: String(technician._id), assignedTechnician: technicianName } },
            options,
          ),
          ServiceRequest.updateMany(
            { assignedTechnicianId: { $in: extraStaffIdStrings } },
            { $set: { assignedTechnicianId: String(technician._id), assignedTechnicianName: technicianName } },
            options,
          ),
        ]);

        await User.bulkWrite(
          plan.extraStaff.map((user) => ({
            updateOne: {
              filter: { _id: user._id },
              update: {
                $set: {
                  alias: `deleted.${user._id}`,
                  email: `deleted_${user._id}@deleted.local`,
                  name: "Deleted User",
                  name_first: "Deleted",
                  name_last: "User",
                  passwordHash: "",
                  role: user.role,
                  assignedBranch: "",
                  activeBranch: "",
                  accountStatus: "deleted",
                  isDeleted: true,
                  deletedAt: now,
                  expoPushTokens: [],
                },
                $unset: {
                  username: "",
                  phone: "",
                  googleId: "",
                },
              },
            },
          })),
          options,
        );
        await Notification.deleteMany({ user: { $in: extraStaffIds } }, options);
      }

      if (plan.completeOrders.length) {
        await Order.updateMany(
          { _id: { $in: plan.completeOrders.map((order) => order._id) } },
          { $set: { status: "paid", deliveryStatus: "completed", stockReservationStatus: "consumed", stockReleasedAt: null } },
          options,
        );
      }
      if (plan.cancelledOrders.length) {
        await Order.bulkWrite(
          plan.cancelledOrders.map((order) => ({
            updateOne: {
              filter: { _id: order._id },
              update: {
                $set: {
                  status: "cancelled",
                  deliveryStatus: "cancelled",
                  stockReservationStatus: "released",
                  stockReleasedAt: order.stockReleasedAt || order.cancelledAt || order.updatedAt || now,
                  cancelledAt: order.cancelledAt || order.updatedAt || now,
                },
              },
            },
          })),
          options,
        );
      }

      if (plan.orphanTasks.length) {
        await Task.collection.updateMany(
          { _id: { $in: plan.orphanTasks.map((task) => task._id) } },
          {
            $set: {
              status: "cancelled",
              completedAt: null,
              "payload.status": "cancelled",
              "payload.integrityNote": "Legacy work order link removed during approved presentation-data cleanup.",
              "payload.updatedAt": now.toISOString(),
            },
            $unset: { orderId: "", "payload.orderId": "", "payload.orderCode": "" },
          },
          options,
        );
      }
      if (plan.staleServiceRequests.length) {
        await ServiceRequest.collection.updateMany(
          { _id: { $in: plan.staleServiceRequests.map((request) => request._id) } },
          {
            $set: { "payload.integrityNote": "Stale work-order link removed during approved presentation-data cleanup." },
            $unset: { linkedTaskId: "", "payload.linkedTaskId": "" },
          },
          options,
        );
      }
      if (plan.unownedUnits.length) {
        await Unit.updateMany(
          { _id: { $in: plan.unownedUnits.map((unit) => unit._id) } },
          { $set: { customer: null, customerName: "Deleted User", status: "retired", "warranty.status": "void" } },
          options,
        );
      }
      if (plan.missingProductUnits.length) {
        await Unit.updateMany(
          { _id: { $in: plan.missingProductUnits.map((unit) => unit._id) } },
          { $set: { productId: "", status: "retired", "warranty.status": "void" } },
          options,
        );
      }
      if (plan.nonRetailProductsToArchive.length) {
        await Product.collection.updateMany(
          { _id: { $in: plan.nonRetailProductsToArchive.map((product) => product._id) } },
          {
            $set: {
              isActive: false,
              stock: 0,
              branchStock: {},
              "serialUnits.$[availableUnit].status": "retired",
            },
          },
          { ...options, arrayFilters: [{ "availableUnit.status": "available" }] },
        );
      }
};

const applyPlan = async (plan) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() => runCleanupOperations(plan, session));
    return;
  } catch (error) {
    const transactionUnsupported = /cannot start a new transaction|transaction numbers are only allowed|only servers in a sharded cluster/i.test(
      String(error?.message || ""),
    );
    if (!transactionUnsupported || !allowNonTransactional) throw error;
    console.warn("Transactions are unavailable on this test database; continuing with guarded idempotent operations.");
    await runCleanupOperations(plan);
  } finally {
    await session.endSession();
  }
};

const main = async () => {
  await connectDb();
  const databaseName = String(mongoose.connection.name || "");
  if (!expectedDatabase || databaseName !== expectedDatabase) {
    throw new Error(`Database mismatch. Set LIVE_DATA_CLEANUP_EXPECTED_DATABASE to the exact configured database name (${databaseName || "unknown"}).`);
  }
  const plan = await buildPlan();
  console.log(JSON.stringify(summarize(plan), null, 2));
  if (!shouldApply) {
    console.log("Dry run only. No records were changed.");
    return;
  }
  if (confirmation !== CONFIRMATION) {
    throw new Error(`Refusing cleanup. Set LIVE_DATA_CLEANUP_CONFIRM=${CONFIRMATION}.`);
  }
  await applyPlan(plan);
  const after = await buildPlan();
  console.log("Cleanup applied successfully.");
  console.log(JSON.stringify(summarize(after), null, 2));
};

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
