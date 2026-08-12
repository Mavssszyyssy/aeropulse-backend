const Order = require("../models/Order");
const AuditLog = require("../models/AuditLog");

const parseDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const normalizeInterval = (value = "") => {
  const v = String(value || "").trim().toLowerCase();
  if (v === "weekly" || v === "week") return "week";
  if (v === "monthly" || v === "month") return "month";
  return "day";
};

const getSalesReport = async (req, res) => {
  try {
    const interval = normalizeInterval(req.query.interval);
    const from = parseDate(req.query.from) || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = parseDate(req.query.to) || new Date();
    const topN = Math.min(50, Math.max(1, Number(req.query.topN) || 10));
    const status = String(req.query.status || "paid").toLowerCase();

    const match = {
      createdAt: { $gte: from, $lte: to },
    };

    if (status !== "all") {
      match.status = status === "complete" ? "paid" : "paid";
      match.workflowStatus = status === "complete" ? "complete" : { $ne: "cancelled" };
    } else {
      match.workflowStatus = { $ne: "cancelled" };
    }

    const activeBranch = req.authUser?.role === "superadmin" ? "" : String(req.activeBranch || "");
    if (activeBranch) {
      match.stockSourceBranch = activeBranch;
    }

    const results = await Order.aggregate([
      { $match: match },
      { $unwind: "$items" },
      {
        $facet: {
          series: [
            {
              $group: {
                _id: {
                  bucket: {
                    $dateTrunc: {
                      date: "$createdAt",
                      unit: interval,
                    },
                  },
                },
                unitsSold: { $sum: "$items.quantity" },
                revenue: { $sum: { $multiply: ["$items.quantity", "$items.price"] } },
              },
            },
            { $sort: { "_id.bucket": 1 } },
            {
              $project: {
                _id: 0,
                bucket: "$_id.bucket",
                unitsSold: 1,
                revenue: 1,
              },
            },
          ],
          topProducts: [
            {
              $group: {
                _id: { productId: "$items.productId", name: "$items.name" },
                unitsSold: { $sum: "$items.quantity" },
                revenue: { $sum: { $multiply: ["$items.quantity", "$items.price"] } },
              },
            },
            { $sort: { unitsSold: -1 } },
            { $limit: topN },
            {
              $project: {
                _id: 0,
                productId: "$_id.productId",
                name: "$_id.name",
                unitsSold: 1,
                revenue: 1,
              },
            },
          ],
        },
      },
    ]);

    const payload = results?.[0] || { series: [], topProducts: [] };

    return res.json({
      interval: interval === "day" ? "daily" : interval === "week" ? "weekly" : "monthly",
      from: from.toISOString(),
      to: to.toISOString(),
      branch: activeBranch || "all",
      updatedAt: new Date().toISOString(),
      series: payload.series || [],
      topProducts: payload.topProducts || [],
    });
  } catch (error) {
    console.error("Failed to load sales report:", error);
    return res.status(500).json({ message: "Unable to load analytics right now." });
  }
};

const getAuditLogs = async (req, res) => {
  try {
    const from = parseDate(req.query.from) || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = parseDate(req.query.to) || new Date();
    const userFilter = String(req.query.user || "").trim();
    const actionFilter = String(req.query.action || "").trim();
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 100));
    const skip = Math.max(0, Number(req.query.skip) || 0);

    const match = {
      createdAt: { $gte: from, $lte: to },
    };

    if (userFilter) {
      match.user = userFilter;
    }

    if (actionFilter) {
      match.action = actionFilter;
    }

    const activeBranch = req.authUser?.role === "superadmin" ? "" : String(req.activeBranch || "");
    if (activeBranch) {
      match.branch = activeBranch;
    }

    const logs = await AuditLog.find(match)
      .populate("user", "name email")
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .lean();

    const total = await AuditLog.countDocuments(match);

    return res.json({
      logs: logs.map(log => ({
        id: log._id.toString(),
        action: log.action,
        user: log.user ? `${log.user.name} (${log.user.email})` : "Unknown",
        branch: log.branch,
        entityType: log.entityType,
        entityId: log.entityId,
        changeDetails: log.changeDetails,
        description: log.description,
        ipAddress: log.ipAddress,
        timestamp: log.createdAt.toISOString(),
      })),
      total,
      from: from.toISOString(),
      to: to.toISOString(),
      branch: activeBranch || "all",
      limit,
      skip,
    });
  } catch (error) {
    console.error("Failed to load audit logs:", error);
    return res.status(500).json({ message: "Unable to load audit logs right now." });
  }
};

module.exports = { getSalesReport, getAuditLogs };

