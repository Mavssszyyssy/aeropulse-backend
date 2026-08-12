const User = require("../models/User");
const Task = require("../models/Task");
const Order = require("../models/Order");
const ServiceRequest = require("../models/ServiceRequest");

const DAY_MS = 24 * 60 * 60 * 1000;
const ORDER_STAGE_LABELS = {
  to_pay: "To pay",
  to_deliver: "To deliver",
  to_install: "To install",
  complete: "Complete",
  cancelled: "Cancelled",
};

const startOfToday = () => {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
};

const isCancelled = (order = {}) =>
  order.workflowStatus === "cancelled" ||
  order.status === "cancelled" ||
  order.paymentStatus === "cancelled";

const isPaid = (order = {}) =>
  !isCancelled(order) &&
  (order.status === "paid" || order.paymentStatus === "paid");

const safeAmount = (order = {}) => Math.max(0, Number(order.totalAmount || 0));
const safeDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const salesDate = (order) => safeDate(order?.paymongo?.paidAt) || safeDate(order?.createdAt);

const getOrderQuery = (branch = "") => {
  const query = {};
  if (branch) {
    query.$or = [
      { customerBranch: branch },
      { stockSourceBranch: branch },
    ];
  }
  return query;
};

const bucketForDate = (date, interval) => {
  const copy = new Date(date);
  if (interval === "monthly") return `${copy.getFullYear()}-${String(copy.getMonth() + 1).padStart(2, "0")}`;
  if (interval === "quarterly") return `${copy.getFullYear()}-Q${Math.floor(copy.getMonth() / 3) + 1}`;
  return copy.toISOString().slice(0, 10);
};

const buildSalesSeries = (paidOrders, interval) => {
  const buckets = new Map();
  paidOrders.forEach((order) => {
    const date = salesDate(order);
    if (!date) return;
    const bucket = bucketForDate(date, interval);
    const current = buckets.get(bucket) || { sales: 0, orders: 0 };
    current.sales += safeAmount(order);
    current.orders += 1;
    buckets.set(bucket, current);
  });

  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([bucket, values]) => {
      const common = { sales: Math.round(values.sales * 100) / 100, orders: values.orders };
      if (interval === "daily") return { date: bucket, ...common };
      if (interval === "monthly") return { month: bucket, ...common };
      return { quarter: bucket, ...common };
    });
};

const getTopProducts = (paidOrders, limit = 5) => {
  const products = new Map();
  paidOrders.forEach((order) => {
    (order.items || []).forEach((item) => {
      const name = String(item?.name || "Unnamed product").trim();
      const key = String(item?.productId || name);
      const current = products.get(key) || { product: name, sales: 0, unitsSold: 0 };
      const quantity = Math.max(0, Number(item?.quantity || 0));
      current.unitsSold += quantity;
      current.sales += quantity * Math.max(0, Number(item?.price || 0));
      products.set(key, current);
    });
  });
  return [...products.values()]
    .sort((left, right) => right.sales - left.sales || right.unitsSold - left.unitsSold)
    .slice(0, limit)
    .map((item) => ({ ...item, sales: Math.round(item.sales * 100) / 100 }));
};

const getCommerceAnalytics = async (branch = "") => {
  const orders = await Order.find(getOrderQuery(branch)).lean();
  const paidOrders = orders.filter(isPaid);
  const sellableOrders = orders.filter((order) => !isCancelled(order));
  const revenue = paidOrders.reduce((sum, order) => sum + safeAmount(order), 0);
  const orderStages = Object.keys(ORDER_STAGE_LABELS).map((stage) => {
    const stageOrders = orders.filter((order) => {
      if (stage === "cancelled") return isCancelled(order);
      return !isCancelled(order) && String(order.workflowStatus || "to_pay") === stage;
    });
    return {
      key: stage,
      label: ORDER_STAGE_LABELS[stage],
      count: stageOrders.length,
      revenue: stageOrders.filter(isPaid).reduce((sum, order) => sum + safeAmount(order), 0),
    };
  });

  const paymentMethodMap = new Map();
  paidOrders.forEach((order) => {
    const label = String(order.paymentMethod || "Other").trim().toUpperCase() || "OTHER";
    const current = paymentMethodMap.get(label) || { label, count: 0, revenue: 0 };
    current.count += 1;
    current.revenue += safeAmount(order);
    paymentMethodMap.set(label, current);
  });

  const branchMap = new Map();
  sellableOrders.forEach((order) => {
    const label = String(order.stockSourceBranch || order.customerBranch || "Unassigned").trim() || "Unassigned";
    const current = branchMap.get(label) || { branch: label, orders: 0, paidOrders: 0, revenue: 0 };
    current.orders += 1;
    if (isPaid(order)) {
      current.paidOrders += 1;
      current.revenue += safeAmount(order);
    }
    branchMap.set(label, current);
  });

  return {
    summary: {
      totalOrders: sellableOrders.length,
      paidOrders: paidOrders.length,
      cancelledOrders: orders.filter(isCancelled).length,
      revenue: Math.round(revenue * 100) / 100,
      averageOrderValue: paidOrders.length ? Math.round((revenue / paidOrders.length) * 100) / 100 : 0,
    },
    sales: {
      daily: buildSalesSeries(paidOrders, "daily"),
      monthly: buildSalesSeries(paidOrders, "monthly"),
      quarterly: buildSalesSeries(paidOrders, "quarterly"),
    },
    topProducts: getTopProducts(paidOrders),
    orderStages,
    paymentMethods: [...paymentMethodMap.values()]
      .sort((left, right) => right.revenue - left.revenue)
      .map((item) => ({ ...item, revenue: Math.round(item.revenue * 100) / 100 })),
    branches: [...branchMap.values()]
      .sort((left, right) => right.revenue - left.revenue || right.orders - left.orders)
      .map((item) => ({ ...item, revenue: Math.round(item.revenue * 100) / 100 })),
  };
};

const getCustomerAcquisitionBySource = async () => {
  const customers = await User.find({ role: "customer" }).lean();
  const sourceData = new Map();
  customers.forEach((customer) => {
    const source = String(customer.sourceOfAcquisition || "other").replace(/_/g, " ").toUpperCase();
    sourceData.set(source, (sourceData.get(source) || 0) + 1);
  });
  return [...sourceData.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((left, right) => right.count - left.count);
};

const getTechnicianKPIs = async (activeBranch = "") => {
  const techQuery = { role: "technician" };
  if (activeBranch) techQuery.$or = [{ assignedBranch: activeBranch }, { assignedBranch: "" }];
  const technicians = await User.find(techQuery).lean();
  const today = startOfToday();
  const weekStart = new Date(Date.now() - 7 * DAY_MS);
  weekStart.setHours(0, 0, 0, 0);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const results = await Promise.all(technicians.map(async (tech) => ({
    name: tech.name,
    completedToday: await Task.countDocuments({ assignedTo: tech._id, status: "completed", completedAt: { $gte: today } }),
    completedWeek: await Task.countDocuments({ assignedTo: tech._id, status: "completed", completedAt: { $gte: weekStart } }),
    completedMonth: await Task.countDocuments({ assignedTo: tech._id, status: "completed", completedAt: { $gte: monthStart } }),
  })));
  return results.sort((left, right) => right.completedMonth - left.completedMonth);
};

const getTechnicianDashboard = async (activeBranch = "") => {
  const taskQuery = { assignedRole: "technician" };
  if (activeBranch) taskQuery.$or = [{ branch: activeBranch }, { branch: "" }, { branch: { $exists: false } }];
  const tasks = await Task.find(taskQuery).sort({ createdAt: -1 }).limit(20);
  const today = startOfToday();
  return {
    stats: {
      pendingTasks: tasks.filter((task) => task.status === "pending").length,
      processingTasks: tasks.filter((task) => task.status === "pending").length,
      inProgressTasks: tasks.filter((task) => task.status === "in-progress").length,
      onHoldTasks: tasks.filter((task) => task.status === "on-hold").length,
      completedToday: tasks.filter((task) => task.completedAt && task.completedAt >= today).length,
      totalTasks: tasks.length,
      branchLabel: activeBranch || "All branches",
    },
    tasks: tasks.map((task) => task.toJSON()),
  };
};

const getAdminDashboard = async (activeBranch = "") => {
  const taskQuery = { status: { $in: ["pending", "in-progress"] } };
  const techQuery = { role: "technician" };
  const customerQuery = { role: "customer" };
  const serviceQuery = {};
  if (activeBranch) {
    taskQuery.$or = [{ branch: activeBranch }, { branch: "" }, { branch: { $exists: false } }];
    techQuery.$or = [{ assignedBranch: activeBranch }, { assignedBranch: "" }, { assignedBranch: { $exists: false } }];
    customerQuery.$or = [{ activeBranch }, { activeBranch: "" }, { activeBranch: { $exists: false } }];
    serviceQuery.$or = [{ branch: activeBranch }, { branch: "" }, { branch: { $exists: false } }];
  }
  const [commerce, pendingTasks, activeTechnicians, totalCustomers, serviceRequests, technicianKPIs] = await Promise.all([
    getCommerceAnalytics(activeBranch),
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
      averageOrderValue: commerce.summary.averageOrderValue,
      lowStockItems: 0,
      activeTechnicians,
      pendingTasks,
      totalCustomers,
      serviceRequests,
      branchLabel: activeBranch || "All branches",
    },
    analytics: { ...commerce, technicianKPIs: technicianKPIs.slice(0, 10) },
  };
};

const getSuperAdminDashboard = async () => {
  const oneDayAgo = new Date(Date.now() - DAY_MS);
  const [totalUsers, admins, technicians, customers, recentlyActiveUsers, commerce, customerAcquisition, technicianKPIs] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ role: { $in: ["admin", "superadmin"] } }),
    User.countDocuments({ role: "technician" }),
    User.countDocuments({ role: "customer" }),
    User.countDocuments({ lastLogin: { $gte: oneDayAgo } }),
    getCommerceAnalytics(),
    getCustomerAcquisitionBySource(),
    getTechnicianKPIs(),
  ]);
  return {
    stats: { totalUsers, admins, technicians, customers, recentlyActiveUsers, totalSales: commerce.summary.revenue, totalOrders: commerce.summary.totalOrders, paidOrders: commerce.summary.paidOrders, averageOrderValue: commerce.summary.averageOrderValue },
    analytics: { ...commerce, customerAcquisition, technicianKPIs: technicianKPIs.slice(0, 10) },
  };
};

const getMyDashboard = async (req, res) => {
  try {
    const role = req.authUser.role;
    if (role === "technician") return res.json({ role, ...(await getTechnicianDashboard(req.activeBranch)) });
    if (role === "admin") return res.json({ role, ...(await getAdminDashboard(req.activeBranch)) });
    if (role === "superadmin") return res.json({ role, ...(await getSuperAdminDashboard()) });
    return res.json({ role, stats: { message: "Customer dashboard uses storefront pages." } });
  } catch (error) {
    console.error("Failed to load dashboard:", error);
    return res.status(500).json({ message: "Unable to load dashboard right now." });
  }
};

module.exports = { getMyDashboard };
