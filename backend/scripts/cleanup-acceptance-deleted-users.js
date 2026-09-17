/* eslint-disable no-console */
// Guarded cleanup for presentation-only acceptance data and previously
// anonymized test users. The script is read-only unless --apply and the exact
// confirmation phrase are supplied. Every changed document is archived first.
const path = require("path");
const mongoose = require("mongoose");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const env = require("../src/config/env");
const { buildDirectMongoUri } = require("../src/config/db");

const args = new Set(process.argv.slice(2));
const shouldApply = args.has("--apply");
const expectedDatabase = String(process.env.DATA_RESIDUE_CLEANUP_EXPECTED_DATABASE || "").trim();
const confirmation = String(process.env.DATA_RESIDUE_CLEANUP_CONFIRM || "").trim();
const CONFIRMATION = "PURGE_ACCEPTANCE_AND_DELETED_USER_RESIDUE";
const ARCHIVE_COLLECTION = "data_cleanup_archives";

const connectCleanupDb = async () => {
  const mongoUri = buildDirectMongoUri({
    mongoUri: env.mongoUri,
    directHosts: env.mongoDirectHosts,
    replicaSet: env.mongoReplicaSet,
  });
  await mongoose.connect(mongoUri, {
    bufferCommands: false,
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
    socketTimeoutMS: 180000,
    maxPoolSize: 5,
  });
  console.log("MongoDB connected for guarded cleanup.");
};

const exactCustomerNames = new Set(["acceptance customer", "deleted user"]);
const sourceCollections = [
  "users",
  "products",
  "orders",
  "units",
  "tasks",
  "servicerequests",
  "servicehistories",
  "maintenancepredictions",
  "visitattempts",
  "contactmessages",
  "partsrequests",
  "notifications",
  "attendances",
  "auditlogs",
  "reorderrequests",
  "inventorychangerequests",
  "restockorders",
  "otprequests",
  "otprequestv3",
  "sessions",
  "inventoryalerts",
  "inventorytransactions",
  "maintenance_reconciliations",
  "servicehistoryarchives",
];

const asString = (value) => String(value || "").trim();
const lower = (value) => asString(value).toLowerCase();
const idOf = (document) => asString(document?._id);
const hasExactCustomerName = (value) => exactCustomerNames.has(lower(value));
const serialized = (document) => JSON.stringify(document || {});
const containsAnyToken = (document, tokens) => {
  const value = serialized(document);
  return [...tokens].some((token) => token && value.includes(token));
};
const uniqueDocuments = (documents) => {
  const seen = new Set();
  return documents.filter((document) => {
    const id = idOf(document);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

const isAcceptanceUser = (user) => {
  const identity = [user.name, user.name_first, user.name_last, user.email, user.alias]
    .map(lower)
    .filter(Boolean);
  return identity.some((value) =>
    value === "acceptance customer"
    || value.startsWith("acceptance.")
    || value.endsWith("@example.test") && value.startsWith("acceptance."),
  );
};

const isDeletedUser = (user) =>
  user.isDeleted === true
  || lower(user.accountStatus) === "deleted"
  || lower(user.name) === "deleted user";

const isAcceptanceProduct = (product) =>
  /^acceptance ac\b/i.test(asString(product.name))
  || /^qa-(96149688|01577116|01655497|01741659)$/i.test(asString(product.sku));

const addDocumentTokens = (tokens, documents, fields = []) => {
  for (const document of documents) {
    tokens.add(idOf(document));
    for (const field of fields) {
      const value = asString(document?.[field]);
      if (value) tokens.add(value);
    }
  }
};

const buildPlan = async () => {
  const db = mongoose.connection.db;
  const existing = new Set((await db.listCollections().toArray()).map((item) => item.name));
  const collection = (name) => db.collection(name);
  const find = async (name, query) => existing.has(name)
    ? collection(name).find(query).toArray()
    : [];
  const exactCustomerRegex = /^(Acceptance Customer|Deleted User)$/i;

  const userMatches = await find("users", {
    $or: [
      { name: /^Acceptance Customer$/i },
      { name_first: /^Acceptance$/i },
      { email: /^acceptance\./i },
      { alias: /^acceptance\./i },
      { name: /^Deleted User$/i },
      { isDeleted: true },
      { accountStatus: "deleted" },
    ],
  });
  const acceptanceUsers = userMatches.filter(isAcceptanceUser);
  const deletedUsers = userMatches.filter(isDeletedUser);
  const candidateUsers = uniqueDocuments([...acceptanceUsers, ...deletedUsers]);
  const candidateProducts = (await find("products", {
    $or: [
      { name: /^Acceptance AC\b/i },
      { sku: /^QA-(96149688|01577116|01655497|01741659)$/i },
    ],
  })).filter(isAcceptanceProduct);
  const acceptanceUserIds = new Set(acceptanceUsers.map(idOf));
  const candidateUserIds = new Set(candidateUsers.map(idOf));
  const candidateProductIds = new Set(candidateProducts.map(idOf));
  const acceptanceUserObjectIds = acceptanceUsers.map((user) => user._id);
  const candidateUserObjectIds = candidateUsers.map((user) => user._id);

  const orders = await find("orders", {
    $or: [
      { customerName: exactCustomerRegex },
      { customer: { $in: acceptanceUserObjectIds } },
      { "items.productId": { $in: [...candidateProductIds] } },
    ],
  });
  const orderTokens = new Set();
  addDocumentTokens(orderTokens, orders, ["orderCode"]);

  const units = await find("units", {
    $or: [
      { customerName: exactCustomerRegex },
      { customer: { $in: acceptanceUserObjectIds } },
      { productId: { $in: [...candidateProductIds] } },
      { orderId: { $in: [...orderTokens] } },
    ],
  });
  const unitTokens = new Set();
  addDocumentTokens(unitTokens, units, ["serialNumber"]);

  const orderIds = orders.map((document) => document._id);
  const orderRefs = [...new Set([...orderTokens, ...orderIds.map(asString)])];
  const unitIds = units.map((document) => document._id);
  const unitRefs = [...new Set([...unitTokens, ...unitIds.map(asString)])];
  const tasks = await find("tasks", {
    $or: [
      { customer: exactCustomerRegex },
      { "payload.customerName": exactCustomerRegex },
      { customerId: { $in: [...acceptanceUserIds] } },
      { "payload.customerId": { $in: [...acceptanceUserIds] } },
      { orderId: { $in: [...orderIds, ...orderRefs] } },
      { "payload.orderId": { $in: orderRefs } },
      { unitId: { $in: unitRefs } },
      { "payload.unitId": { $in: unitRefs } },
      { "payload.serialNumber": { $in: [...unitTokens] } },
      { "payload.serialNumbers": { $in: [...unitTokens] } },
      { "payload.items.serialNumbers": { $in: [...unitTokens] } },
      { "payload.items.serialUnits.serialNumber": { $in: [...unitTokens] } },
      { "payload.items.productId": { $in: [...candidateProductIds] } },
    ],
  });
  const taskTokens = new Set();
  addDocumentTokens(taskTokens, tasks, ["taskCode"]);

  const taskIds = tasks.map((document) => document._id);
  const taskRefs = [...new Set([...taskTokens, ...taskIds.map(asString)])];
  const serviceRequests = await find("servicerequests", {
    $or: [
      { customer: exactCustomerRegex },
      { "payload.customerName": exactCustomerRegex },
      { customerId: { $in: [...acceptanceUserIds] } },
      { "payload.customerId": { $in: [...acceptanceUserIds] } },
      { unitId: { $in: unitRefs } },
      { "payload.unitId": { $in: unitRefs } },
      { linkedTaskId: { $in: taskRefs } },
      { "payload.linkedTaskId": { $in: taskRefs } },
      { orderId: { $in: orderRefs } },
      { "payload.orderId": { $in: orderRefs } },
    ],
  });
  const serviceRequestTokens = new Set();
  addDocumentTokens(serviceRequestTokens, serviceRequests);

  const chainTokens = new Set([
    ...orderRefs,
    ...unitRefs,
    ...taskRefs,
    ...serviceRequestTokens,
    ...candidateProductIds,
    ...acceptanceUserIds,
  ]);
  const candidateByCollection = new Map([
    ["users", candidateUsers],
    ["products", candidateProducts],
    ["orders", orders],
    ["units", units],
    ["tasks", tasks],
    ["servicerequests", serviceRequests],
  ]);

  const objectEntityIds = [
    ...candidateUserObjectIds,
    ...candidateProducts.map((document) => document._id),
    ...orderIds,
    ...unitIds,
    ...taskIds,
    ...serviceRequests.map((document) => document._id),
  ];
  const notificationTokenRegex = chainTokens.size
    ? new RegExp([...chainTokens].map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i")
    : /$a/;

  const targetedQueries = new Map([
    ["servicehistories", { $or: [{ unit: { $in: unitIds } }, { sourceTaskId: { $in: taskRefs } }] }],
    ["maintenancepredictions", { unit: { $in: unitIds } }],
    ["visitattempts", { taskId: { $in: taskIds } }],
    ["contactmessages", { $or: [{ customer: { $in: acceptanceUserObjectIds } }, { customerName: exactCustomerRegex }] }],
    ["partsrequests", { taskId: { $in: taskRefs } }],
    ["notifications", { $or: [
      { user: { $in: candidateUserObjectIds } },
      { targetId: { $in: [...chainTokens] } },
      { dedupeKey: notificationTokenRegex },
    ] }],
    ["attendances", { user: { $in: candidateUserObjectIds } }],
    ["auditlogs", { $or: [{ user: { $in: candidateUserObjectIds } }, { entityId: { $in: objectEntityIds } }] }],
    ["reorderrequests", { $or: [
      { requestedBy: { $in: candidateUserObjectIds } },
      { reviewedBy: { $in: candidateUserObjectIds } },
      { product: { $in: candidateProducts.map((document) => document._id) } },
    ] }],
    ["inventorychangerequests", { $or: [
      { requestedBy: { $in: candidateUserObjectIds } },
      { reviewedBy: { $in: candidateUserObjectIds } },
      { product: { $in: candidateProducts.map((document) => document._id) } },
    ] }],
    ["restockorders", { $or: [
      { createdBy: { $in: candidateUserObjectIds } },
      { receivedBy: { $in: candidateUserObjectIds } },
      { "products.product": { $in: candidateProducts.map((document) => document._id) } },
    ] }],
    ["otprequests", { email: /^acceptance\./i }],
    ["otprequestv3", { email: /^acceptance\./i }],
    ["sessions", { $or: [
      { user: { $in: candidateUserObjectIds } },
      { userId: { $in: [...candidateUserIds] } },
    ] }],
  ]);
  for (const [name, query] of targetedQueries.entries()) {
    candidateByCollection.set(name, await find(name, query));
  }

  for (const name of [
    "inventoryalerts",
    "inventorytransactions",
    "maintenance_reconciliations",
    "servicehistoryarchives",
  ]) {
    const documents = await find(name, {});
    candidateByCollection.set(name, documents.filter((document) => containsAnyToken(document, chainTokens)));
  }

  const serialNumbers = new Set();
  for (const unit of units) if (unit.serialNumber) serialNumbers.add(asString(unit.serialNumber));
  for (const order of orders) {
    for (const item of order.items || []) {
      for (const serial of item.serialNumbers || []) serialNumbers.add(asString(serial));
      for (const serialUnit of item.serialUnits || []) {
        if (serialUnit?.serialNumber) serialNumbers.add(asString(serialUnit.serialNumber));
      }
    }
  }

  const stockRestorations = new Map();
  for (const order of orders) {
    if (lower(order.workflowStatus) !== "complete" || lower(order.stockReservationStatus) !== "consumed") continue;
    for (const item of order.items || []) {
      const productId = asString(item.productId);
      if (!productId || candidateProductIds.has(productId)) continue;
      const quantity = Number(item.quantity || 0);
      const branch = asString(item.sourceBranch || order.stockSourceBranch);
      if (quantity < 1 || !branch) continue;
      const key = `${productId}:${branch}`;
      const current = stockRestorations.get(key) || { productId, branch, quantity: 0 };
      current.quantity += quantity;
      stockRestorations.set(key, current);
    }
  }

  const adjustedProductIds = [...new Set([
    ...[...stockRestorations.values()].map((item) => item.productId),
    ...orders.flatMap((order) => (order.items || []).map((item) => asString(item.productId))),
    ...units.map((unit) => asString(unit.productId)),
  ].filter((id) => id && !candidateProductIds.has(id)))];
  const adjustedObjectIds = adjustedProductIds
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  const realProductsToAdjust = (await find("products", { _id: { $in: adjustedObjectIds } })).filter((product) =>
    [...stockRestorations.values()].some((item) => item.productId === idOf(product))
    || (product.serialUnits || []).some((unit) => serialNumbers.has(asString(unit.serialNumber))),
  );

  const archiveDocuments = new Map(candidateByCollection);
  archiveDocuments.set(
    "products",
    uniqueDocuments([...candidateProducts, ...realProductsToAdjust]),
  );

  return {
    candidateByCollection,
    archiveDocuments,
    acceptanceUsers,
    deletedUsers,
    candidateProducts,
    serialNumbers,
    stockRestorations: [...stockRestorations.values()],
    realProductsToAdjust,
  };
};

const summarize = (plan) => ({
  database: mongoose.connection.name,
  mode: shouldApply ? "apply" : "dry-run",
  acceptanceAccounts: plan.acceptanceUsers.length,
  deletedAccounts: plan.deletedUsers.length,
  acceptanceProducts: plan.candidateProducts.length,
  recordsByCollection: Object.fromEntries(
    [...plan.candidateByCollection.entries()]
      .filter(([, documents]) => documents.length)
      .map(([name, documents]) => [name, documents.length]),
  ),
  serialRecordsToRemove: plan.serialNumbers.size,
  stockToRestore: plan.stockRestorations,
  realProductsToAdjust: plan.realProductsToAdjust.map((product) => ({
    id: idOf(product),
    name: product.name,
    sku: product.sku,
  })),
});

const archivePlan = async (plan, batchId, session) => {
  const archive = mongoose.connection.db.collection(ARCHIVE_COLLECTION);
  const records = [];
  for (const [sourceCollection, documents] of plan.archiveDocuments.entries()) {
    for (const document of documents) {
      records.push({
        batchId,
        reason: "Approved cleanup of acceptance and Deleted User presentation residue",
        sourceCollection,
        sourceId: idOf(document),
        archivedAt: new Date(),
        original: document,
      });
    }
  }
  if (records.length) await archive.insertMany(records, { session });
};

const applyPlan = async (plan) => {
  const session = await mongoose.startSession();
  const batchId = `acceptance-deleted-user-cleanup-${new Date().toISOString()}`;
  try {
    await session.withTransaction(async () => {
      await archivePlan(plan, batchId, session);

      const products = mongoose.connection.db.collection("products");
      const serials = [...plan.serialNumbers];
      for (const restoration of plan.stockRestorations) {
        await products.updateOne(
          { _id: new mongoose.Types.ObjectId(restoration.productId) },
          {
            $inc: {
              stock: restoration.quantity,
              [`branchStock.${restoration.branch}`]: restoration.quantity,
            },
          },
          { session },
        );
      }
      if (serials.length) {
        await products.updateMany(
          { "serialUnits.serialNumber": { $in: serials } },
          { $pull: { serialUnits: { serialNumber: { $in: serials } } } },
          { session },
        );
      }

      for (const [name, documents] of plan.candidateByCollection.entries()) {
        if (!documents.length) continue;
        await mongoose.connection.db.collection(name).deleteMany(
          { _id: { $in: documents.map((document) => document._id) } },
          { session },
        );
      }
    });
    return batchId;
  } finally {
    await session.endSession();
  }
};

const verifyCleanup = async (plan) => {
  const db = mongoose.connection.db;
  const serials = [...plan.serialNumbers];
  const remaining = {
    acceptanceAccounts: await db.collection("users").countDocuments({
      $or: [
        { name: /^Acceptance Customer$/i },
        { email: /^acceptance\./i },
        { alias: /^acceptance\./i },
      ],
    }),
    deletedAccounts: await db.collection("users").countDocuments({
      $or: [{ isDeleted: true }, { accountStatus: "deleted" }, { name: /^Deleted User$/i }],
    }),
    acceptanceProducts: await db.collection("products").countDocuments({
      $or: [{ name: /^Acceptance AC\b/i }, { sku: /^QA-(96149688|01577116|01655497|01741659)$/i }],
    }),
    namedOrders: await db.collection("orders").countDocuments({ customerName: { $in: ["Acceptance Customer", "Deleted User"] } }),
    namedUnits: await db.collection("units").countDocuments({ customerName: { $in: ["Acceptance Customer", "Deleted User"] } }),
    namedTasks: await db.collection("tasks").countDocuments({ customer: { $in: ["Acceptance Customer", "Deleted User"] } }),
    namedServiceRequests: await db.collection("servicerequests").countDocuments({ customer: { $in: ["Acceptance Customer", "Deleted User"] } }),
    serialUnits: serials.length
      ? await db.collection("products").countDocuments({ "serialUnits.serialNumber": { $in: serials } })
      : 0,
  };
  const failures = Object.entries(remaining).filter(([, count]) => count !== 0);
  if (failures.length) {
    throw new Error(`Cleanup verification failed: ${JSON.stringify(remaining)}`);
  }
  return remaining;
};

const main = async () => {
  await connectCleanupDb();
  const databaseName = asString(mongoose.connection.name);
  if (!expectedDatabase || databaseName !== expectedDatabase) {
    throw new Error(
      `Database mismatch. Set DATA_RESIDUE_CLEANUP_EXPECTED_DATABASE to the exact configured database name (${databaseName || "unknown"}).`,
    );
  }

  const plan = await buildPlan();
  console.log(JSON.stringify(summarize(plan), null, 2));
  if (!shouldApply) {
    console.log("Dry run only. No records were changed.");
    return;
  }
  if (confirmation !== CONFIRMATION) {
    throw new Error(`Refusing cleanup. Set DATA_RESIDUE_CLEANUP_CONFIRM=${CONFIRMATION}.`);
  }

  const batchId = await applyPlan(plan);
  const verification = await verifyCleanup(plan);
  console.log(`Cleanup applied and archived under batch ${batchId}.`);
  console.log(JSON.stringify({ verification }, null, 2));
};

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

