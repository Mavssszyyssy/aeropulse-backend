const User = require("../models/User");
const Task = require("../models/Task");
const Order = require("../models/Order");
const ServiceRequest = require("../models/ServiceRequest");
const { DEFAULT_BUSINESS_TIME_ZONE } = require("../utils/dateTime");
const { resolveReportRange } = require("../domain/operationalReports");
const { BRANCHES } = require("../domain/branchRouting");
const { summarizeAcquisitionRows } = require("../domain/acquisitionAttribution");

const DAY_MS = 24 * 60 * 60 * 1000;
const ORDER_STAGE_LABELS = {
  to_pay: "To pay",
  to_deliver: "To deliver",
  to_dispatch: "To dispatch",
  to_install: "To install",
  for_rescheduling: "For rescheduling",
  complete: "Complete",
  cancelled: "Cancelled",
};

const startOfToday = () => {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
};

const getOrderQuery = (branch = "") => {
  const query = {};
  if (branch) {
    query.$or = [
      { stockSourceBranch: branch },
      // Match the same effective branch used by the branch-performance facet.
      // A customer's home branch must not also count an order fulfilled by a
      // different stock-source branch in the Admin dashboard.
      { stockSourceBranch: { $in: ["", null] }, customerBranch: branch },
    ];
  }
  return query;
};

const roundMoney = (value) => Math.round(Math.max(0, Number(value || 0)) * 100) / 100;
const numericExpression = (value) => ({
  $max: [
    0,
    { $convert: { input: value, to: "double", onError: 0, onNull: 0 } },
  ],
});
const trimmedStringExpression = (value, fallback = "") => ({
  $trim: {
    input: {
      $convert: {
        input: { $ifNull: [value, fallback] },
        to: "string",
        onError: fallback,
        onNull: fallback,
      },
    },
  },
});

const buildCommerceAnalyticsPipeline = (branch = "", range = null) => {
  const timeZone = process.env.APP_TIME_ZONE || DEFAULT_BUSINESS_TIME_ZONE;
  const salesDate = { $ifNull: ["$paymongo.paidAt", "$createdAt"] };
  const year = { $year: { date: salesDate, timezone: timeZone } };
  const month = { $month: { date: salesDate, timezone: timeZone } };

  return [
    { $match: getOrderQuery(branch) },
    {
      $set: {
        _analyticsCancelled: {
          $or: [
            { $eq: ["$workflowStatus", "cancelled"] },
            { $eq: ["$status", "cancelled"] },
            { $eq: ["$paymentStatus", "cancelled"] },
          ],
        },
        _analyticsAmount: numericExpression("$totalAmount"),
        _analyticsSalesDate: salesDate,
        _analyticsBranch: {
          $let: {
            vars: {
              stock: trimmedStringExpression("$stockSourceBranch"),
              customer: trimmedStringExpression("$customerBranch"),
            },
            in: {
              $cond: [
                { $ne: ["$$stock", ""] },
                "$$stock",
                { $cond: [{ $ne: ["$$customer", ""] }, "$$customer", "Unassigned"] },
              ],
            },
          },
        },
        _analyticsPaymentMethod: {
          $let: {
            vars: { method: trimmedStringExpression("$paymentMethod", "Other") },
            in: {
              $cond: [
                { $eq: ["$$method", ""] },
                "OTHER",
                { $toUpper: "$$method" },
              ],
            },
          },
        },
      },
    },
    ...(range ? [{ $match: { _analyticsSalesDate: { $gte: range.from, $lte: range.to } } }] : []),
    {
      $set: {
        _analyticsPaid: {
          $and: [
            { $eq: ["$_analyticsCancelled", false] },
            {
              $or: [
                { $eq: ["$status", "paid"] },
                { $eq: ["$paymentStatus", "paid"] },
              ],
            },
          ],
        },
        _analyticsStage: {
          $cond: [
            "$_analyticsCancelled",
            "cancelled",
            {
              $let: {
                vars: { stage: trimmedStringExpression("$workflowStatus", "to_pay") },
                in: { $cond: [{ $eq: ["$$stage", ""] }, "to_pay", "$$stage"] },
              },
            },
          ],
        },
      },
    },
    {
      $facet: {
        summary: [
          {
            $group: {
              _id: null,
              totalOrders: { $sum: { $cond: ["$_analyticsCancelled", 0, 1] } },
              paidOrders: { $sum: { $cond: ["$_analyticsPaid", 1, 0] } },
              cancelledOrders: { $sum: { $cond: ["$_analyticsCancelled", 1, 0] } },
              revenue: { $sum: { $cond: ["$_analyticsPaid", "$_analyticsAmount", 0] } },
            },
          },
        ],
        daily: [
          { $match: { _analyticsPaid: true } },
          {
            $group: {
              _id: { $dateToString: { date: "$_analyticsSalesDate", format: "%Y-%m-%d", timezone: timeZone } },
              sales: { $sum: "$_analyticsAmount" },
              orders: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ],
        monthly: [
          { $match: { _analyticsPaid: true } },
          {
            $group: {
              _id: { $dateToString: { date: "$_analyticsSalesDate", format: "%Y-%m", timezone: timeZone } },
              sales: { $sum: "$_analyticsAmount" },
              orders: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ],
        quarterly: [
          { $match: { _analyticsPaid: true } },
          {
            $group: {
              _id: {
                year,
                quarter: { $ceil: { $divide: [month, 3] } },
              },
              sales: { $sum: "$_analyticsAmount" },
              orders: { $sum: 1 },
            },
          },
          { $sort: { "_id.year": 1, "_id.quarter": 1 } },
        ],
        topProducts: [
          { $match: { _analyticsPaid: true } },
          { $unwind: "$items" },
          {
            $set: {
              _itemName: trimmedStringExpression("$items.name", "Unnamed product"),
              _itemProductId: trimmedStringExpression("$items.productId"),
              _itemQuantity: numericExpression("$items.quantity"),
              _itemPrice: numericExpression("$items.price"),
            },
          },
          {
            $group: {
              _id: {
                $cond: [
                  { $ne: ["$_itemProductId", ""] },
                  "$_itemProductId",
                  "$_itemName",
                ],
              },
              product: { $first: "$_itemName" },
              unitsSold: { $sum: "$_itemQuantity" },
              sales: { $sum: { $multiply: ["$_itemQuantity", "$_itemPrice"] } },
            },
          },
          { $sort: { sales: -1, unitsSold: -1 } },
          { $limit: 5 },
        ],
        orderStages: [
          {
            $group: {
              _id: "$_analyticsStage",
              count: { $sum: 1 },
              revenue: { $sum: { $cond: ["$_analyticsPaid", "$_analyticsAmount", 0] } },
            },
          },
        ],
        paymentMethods: [
          { $match: { _analyticsPaid: true } },
          {
            $group: {
              _id: "$_analyticsPaymentMethod",
              count: { $sum: 1 },
              revenue: { $sum: "$_analyticsAmount" },
            },
          },
          { $sort: { revenue: -1 } },
        ],
        branches: [
          {
            $group: {
              _id: "$_analyticsBranch",
              orders: { $sum: { $cond: ["$_analyticsCancelled", 0, 1] } },
              allOrders: { $sum: 1 },
              cancelledOrders: { $sum: { $cond: ["$_analyticsCancelled", 1, 0] } },
              paidOrders: { $sum: { $cond: ["$_analyticsPaid", 1, 0] } },
              revenue: { $sum: { $cond: ["$_analyticsPaid", "$_analyticsAmount", 0] } },
            },
          },
          { $sort: { revenue: -1, orders: -1 } },
        ],
        branchProducts: [
          { $match: { _analyticsPaid: true } },
          { $unwind: "$items" },
          { $group: {
            _id: { branch: "$_analyticsBranch", productId: trimmedStringExpression("$items.productId", ""), product: trimmedStringExpression("$items.name", "Unnamed product") },
            quantity: { $sum: numericExpression("$items.quantity") },
            revenue: { $sum: { $multiply: [numericExpression("$items.quantity"), numericExpression("$items.price")] } },
          } },
          { $sort: { "_id.branch": 1, revenue: -1 } },
        ],
      },
    },
  ];
};

const normalizeCommerceAnalytics = (facets = {}) => {
  const summaryRow = facets.summary?.[0] || {};
  const paidOrders = Number(summaryRow.paidOrders || 0);
  const rawRevenue = Math.max(0, Number(summaryRow.revenue || 0));
  const revenue = roundMoney(rawRevenue);
  const stageRows = new Map((facets.orderStages || []).map((row) => [String(row._id), row]));
  const otherStageRows = (facets.orderStages || []).filter((row) => !Object.hasOwn(ORDER_STAGE_LABELS, String(row._id)));
  const productsByBranch = new Map();
  for (const row of facets.branchProducts || []) {
    const name = String(row._id?.branch || "Unassigned");
    if (!productsByBranch.has(name)) productsByBranch.set(name, []);
    productsByBranch.get(name).push({ productId: String(row._id?.productId || ""), product: String(row._id?.product || "Unnamed product"), quantity: Number(row.quantity || 0), revenue: roundMoney(row.revenue) });
  }
  const series = (rows = [], key, formatKey = (value) => value) => rows.map((row) => ({
    [key]: formatKey(row._id),
    sales: roundMoney(row.sales),
    orders: Number(row.orders || 0),
  }));

  return {
    summary: {
      totalOrders: Number(summaryRow.totalOrders || 0),
      paidOrders,
      cancelledOrders: Number(summaryRow.cancelledOrders || 0),
      revenue,
      averageOrderValue: paidOrders ? roundMoney(rawRevenue / paidOrders) : 0,
    },
    sales: {
      daily: series(facets.daily, "date"),
      monthly: series(facets.monthly, "month"),
      quarterly: series(
        facets.quarterly,
        "quarter",
        (value) => `${value?.year || 0}-Q${value?.quarter || 0}`,
      ),
    },
    topProducts: (facets.topProducts || []).map((row) => ({
      product: String(row.product || "Unnamed product") || "Unnamed product",
      sales: roundMoney(row.sales),
      unitsSold: Number(row.unitsSold || 0),
    })),
    orderStages: [...Object.entries(ORDER_STAGE_LABELS).map(([key, label]) => ({
      key,
      label,
      count: Number(stageRows.get(key)?.count || 0),
      revenue: roundMoney(stageRows.get(key)?.revenue),
    })), ...(otherStageRows.length ? [{
      key: "other_status",
      label: "Other status",
      count: otherStageRows.reduce((sum, row) => sum + Number(row.count || 0), 0),
      revenue: roundMoney(otherStageRows.reduce((sum, row) => sum + Number(row.revenue || 0), 0)),
    }] : [])],
    paymentMethods: (facets.paymentMethods || []).map((row) => ({
      label: String(row._id || "OTHER"),
      count: Number(row.count || 0),
      revenue: roundMoney(row.revenue),
    })),
    branches: (facets.branches || []).map((row) => ({
      branch: String(row._id || "Unassigned"),
      orders: Number(row.orders || 0),
      allOrders: Number(row.allOrders ?? row.orders ?? 0),
      cancelledOrders: Number(row.cancelledOrders || 0),
      paidOrders: Number(row.paidOrders || 0),
      revenue: roundMoney(row.revenue),
      products: productsByBranch.get(String(row._id || "Unassigned")) || [],
    })),
  };
};

const getCommerceAnalytics = async (branch = "", range = null) => {
  const [facets = {}] = await Order.aggregate(buildCommerceAnalyticsPipeline(branch, range));
  return normalizeCommerceAnalytics(facets);
};

const buildCustomerAcquisitionPipeline = (branch = "", range = null) => [
  { $match: { role: "customer", ...(branch ? { activeBranch: branch } : {}), ...(range ? { createdAt: { $gte: range.from, $lte: range.to } } : {}) } },
  // Group by the recorded value on each customer record. Missing values are
  // unknown; an explicitly recorded "other" remains its own category.
  { $group: { _id: "$sourceOfAcquisition", count: { $sum: 1 } } },
];

const getCustomerAcquisitionBySource = async (branch = "", range = null) => {
  const rows = await User.aggregate(buildCustomerAcquisitionPipeline(branch, range));
  return summarizeAcquisitionRows(rows);
};

const activeTechnicianQuery = (activeBranch = "") => {
  const techQuery = {
    role: "technician",
    isDeleted: { $ne: true },
    accountStatus: { $nin: ["disabled", "deleted"] },
  };
  if (activeBranch) techQuery.$or = [{ assignedBranch: activeBranch }, { assignedBranch: "" }];
  return techQuery;
};

const getTechnicianKPIs = async (activeBranch = "") => {
  const techQuery = activeTechnicianQuery(activeBranch);
  const technicians = await User.find(techQuery)
    .select("name name_first name_last email activeBranch assignedBranch")
    .lean();
  const today = startOfToday();
  const weekStart = new Date(Date.now() - 7 * DAY_MS);
  weekStart.setHours(0, 0, 0, 0);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  // One grouped task read replaces three count queries per technician. This
  // keeps dashboard latency stable as branches add more technicians.
  const technicianIds = technicians.map((tech) => String(tech._id));
  const completionRows = technicianIds.length
    ? await Task.aggregate([
      {
        $match: {
          assignedTechnicianId: { $in: technicianIds },
          status: "completed",
          completedAt: { $gte: monthStart },
        },
      },
      {
        $group: {
          _id: "$assignedTechnicianId",
          completedToday: { $sum: { $cond: [{ $gte: ["$completedAt", today] }, 1, 0] } },
          completedWeek: { $sum: { $cond: [{ $gte: ["$completedAt", weekStart] }, 1, 0] } },
          completedMonth: { $sum: 1 },
        },
      },
    ])
    : [];
  const completionsByTechnician = new Map(
    completionRows.map((row) => [String(row._id), row]),
  );
  const results = technicians.map((tech) => {
    const completion = completionsByTechnician.get(String(tech._id)) || {};
    return {
      id: String(tech._id),
      name: tech.name || `${tech.name_first || ""} ${tech.name_last || ""}`.trim() || tech.email || "Technician",
      branch: tech.activeBranch || tech.assignedBranch || "",
      completedToday: Number(completion.completedToday || 0),
      completedWeek: Number(completion.completedWeek || 0),
      completedMonth: Number(completion.completedMonth || 0),
    };
  });
  return results.sort((left, right) => right.completedMonth - left.completedMonth);
};

const getTechnicianDashboard = async (activeBranch = "") => {
  const taskQuery = { assignedRole: "technician" };
  if (activeBranch) taskQuery.$or = [{ branch: activeBranch }, { branch: "" }, { branch: { $exists: false } }];
  const tasks = await Task.find(taskQuery)
    .select("-proof.beforePhotos -proof.afterPhotos -proof.customerSignature.signature -payload.proof -payload.beforePhotos -payload.afterPhotos -payload.beforePhotoUri -payload.afterPhotoUri -payload.customerSignature -payload.signature")
    .sort({ createdAt: -1 })
    .limit(20);
  const today = startOfToday();
  return {
    stats: {
      pendingTasks: tasks.filter((task) => task.status === "pending").length,
      processingTasks: tasks.filter((task) => ["accepted", "on-the-way", "arrived", "installing"].includes(task.status)).length,
      inProgressTasks: tasks.filter((task) => task.status === "in-progress").length,
      onHoldTasks: tasks.filter((task) => task.status === "on-hold").length,
      completedToday: tasks.filter((task) => task.completedAt && task.completedAt >= today).length,
      totalTasks: tasks.length,
      branchLabel: activeBranch || "All branches",
    },
    tasks: tasks.map((task) => task.toJSON()),
  };
};

const getAdminDashboard = async (activeBranch = "", { includeAllTechnicians = false, range = null } = {}) => {
  const taskQuery = { status: { $in: ["pending", "accepted", "on-the-way", "arrived", "installing", "in-progress", "on-hold"] } };
  const techQuery = activeTechnicianQuery();
  const customerQuery = { role: "customer" };
  const serviceQuery = {};
  if (activeBranch) {
    taskQuery.$or = [{ branch: activeBranch }, { branch: "" }, { branch: { $exists: false } }];
    techQuery.$or = [{ assignedBranch: activeBranch }, { assignedBranch: "" }, { assignedBranch: { $exists: false } }];
    customerQuery.$or = [{ activeBranch }, { activeBranch: "" }, { activeBranch: { $exists: false } }];
    serviceQuery.$or = [{ branch: activeBranch }, { branch: "" }, { branch: { $exists: false } }];
  }
  const [commerce, pendingTasks, activeTechnicians, totalCustomers, serviceRequests, technicianKPIs] = await Promise.all([
    getCommerceAnalytics(activeBranch, range),
    Task.countDocuments(taskQuery),
    User.countDocuments(techQuery),
    User.countDocuments(customerQuery),
    ServiceRequest.countDocuments(serviceQuery),
    getTechnicianKPIs(activeBranch),
  ]);
  return {
    stats: {
      totalSales: commerce.summary.revenue,
      totalOrders: commerce.summary.totalOrders,
      paidOrders: commerce.summary.paidOrders,
      cancelledOrders: commerce.summary.cancelledOrders,
      averageOrderValue: commerce.summary.averageOrderValue,
      lowStockItems: 0,
      activeTechnicians,
      pendingTasks,
      totalCustomers,
      serviceRequests,
      branchLabel: activeBranch || "All branches",
    },
    analytics: { ...commerce, technicianKPIs: includeAllTechnicians ? technicianKPIs : technicianKPIs.slice(0, 10) },
  };
};

const getSuperAdminDashboard = async ({ includeAllTechnicians = false, branch = "", range = null } = {}) => {
  const oneDayAgo = new Date(Date.now() - DAY_MS);
  const customerScope = branch ? { activeBranch: branch } : {};
  const [totalUsers, admins, technicians, customers, recentlyActiveUsers, commerce, customerAcquisition, technicianKPIs] = await Promise.all([
    User.countDocuments(customerScope),
    User.countDocuments({ role: { $in: ["admin", "superadmin"] }, ...(branch ? { assignedBranch: branch } : {}) }),
    User.countDocuments({ role: "technician", ...(branch ? { assignedBranch: branch } : {}) }),
    User.countDocuments({ role: "customer", ...customerScope }),
    User.countDocuments({ lastLogin: { $gte: oneDayAgo }, ...customerScope }),
    getCommerceAnalytics(branch, range),
    getCustomerAcquisitionBySource(branch, range),
    getTechnicianKPIs(branch),
  ]);
  return {
    stats: { totalUsers, admins, technicians, customers, customerAcquisitionTotal: customerAcquisition.reduce((sum, item) => sum + item.count, 0), recentlyActiveUsers, totalSales: commerce.summary.revenue, totalOrders: commerce.summary.totalOrders, paidOrders: commerce.summary.paidOrders, cancelledOrders: commerce.summary.cancelledOrders, averageOrderValue: commerce.summary.averageOrderValue, branchLabel: branch || "All branches" },
    analytics: { ...commerce, customerAcquisition, technicianKPIs: includeAllTechnicians ? technicianKPIs : technicianKPIs.slice(0, 10) },
  };
};

const getMyDashboard = async (req, res) => {
  try {
    const role = req.authUser.role;
    const includeAllTechnicians = String(req.query?.includeAllTechnicians || "").toLowerCase() === "true";
    const from = String(req.query?.from || "").trim();
    const to = String(req.query?.to || "").trim();
    if (Boolean(from) !== Boolean(to)) return res.status(400).json({ message: "Select both From and To dates." });
    const range = from && to ? resolveReportRange({ from, to }) : null;
    const requestedBranch = String(req.query?.branch || "").trim();
    if (role === "superadmin" && requestedBranch && requestedBranch !== "all" && !BRANCHES.includes(requestedBranch)) return res.status(400).json({ message: "Select an active branch." });
    const branch = role === "superadmin" && requestedBranch !== "all" ? requestedBranch : "";
    if (role === "technician") return res.json({ role, ...(await getTechnicianDashboard(req.activeBranch)) });
    if (role === "admin") return res.json({ role, ...(await getAdminDashboard(req.activeBranch, { includeAllTechnicians, range })) });
    if (role === "superadmin") return res.json({ role, ...(await getSuperAdminDashboard({ includeAllTechnicians, branch, range })) });
    return res.json({ role, stats: { message: "Customer dashboard uses storefront pages." } });
  } catch (error) {
    if (error?.statusCode === 400) return res.status(400).json({ message: error.message });
    console.error("Failed to load dashboard:", error);
    return res.status(500).json({ message: "Unable to load dashboard right now." });
  }
};

module.exports = {
  activeTechnicianQuery,
  buildCustomerAcquisitionPipeline,
  buildCommerceAnalyticsPipeline,
  getCommerceAnalytics,
  getCustomerAcquisitionBySource,
  getMyDashboard,
  normalizeCommerceAnalytics,
};
