const ReorderRequest = require("../models/ReorderRequest");
const Product = require("../models/Product");
const Notification = require("../models/Notification");
const { BRANCHES } = require("../domain/branchRouting");
const { ensureProductSerialUnits } = require("./productController");

const requireAdmin = (req, res) => {
  if (!["admin", "superadmin"].includes(req.authUser.role)) {
    res.status(403).json({ message: "Forbidden" });
    return false;
  }
  return true;
};

const getBranchScope = (req) =>
  req.authUser.role === "superadmin"
    ? {}
    : { branch: String(req.activeBranch || "") };

const serializeReorder = (request) => {
  const json = request.toJSON();
  return {
    ...json,
    product: request.product?.toJSON ? request.product.toJSON() : request.product || null,
    requestedBy: request.requestedBy?.toJSON
      ? request.requestedBy.toJSON()
      : request.requestedBy || null,
    reviewedBy: request.reviewedBy?.toJSON
      ? request.reviewedBy.toJSON()
      : request.reviewedBy || null,
  };
};

const createReorderRequest = async (req, res) => {
  if (!requireAdmin(req, res)) return null;

  const { productId, quantity, notes = "" } = req.body || {};
  const requestedQuantity = Number(quantity);
  if (!productId || !Number.isInteger(requestedQuantity) || requestedQuantity <= 0) {
    return res.status(400).json({ message: "Quantity must be a whole number greater than zero." });
  }

  const product = await Product.findById(productId);
  if (!product) return res.status(404).json({ message: "Product not found" });

  const branch = req.authUser.role === "superadmin"
    ? String(req.body?.branch || "").trim()
    : String(req.activeBranch || "").trim();
  if (!branch || !BRANCHES.includes(branch)) {
    return res.status(400).json({ message: "A valid branch is required for a reorder request." });
  }

  const reorder = await ReorderRequest.create({
    requestedBy: req.authUser._id,
    product: product._id,
    quantity: requestedQuantity,
    branch,
    notes: String(notes || "").trim(),
  });
  await reorder.populate(["product", { path: "requestedBy", select: "name name_first name_last email" }]);
  return res.status(201).json({ reorder: serializeReorder(reorder) });
};

const listReorders = async (req, res) => {
  if (!requireAdmin(req, res)) return null;
  const status = String(req.query?.status || "").trim().toLowerCase();
  const query = { ...getBranchScope(req) };
  if (["submitted", "approved", "rejected"].includes(status)) query.status = status;

  const reorders = await ReorderRequest.find(query)
    .populate("product")
    .populate("requestedBy", "name name_first name_last email")
    .populate("reviewedBy", "name name_first name_last email")
    .sort({ createdAt: -1 })
    .limit(200);
  return res.json({ reorders: reorders.map(serializeReorder) });
};

const listMyReorders = async (req, res) => {
  if (!requireAdmin(req, res)) return null;
  const query = { ...getBranchScope(req), requestedBy: req.authUser._id };
  const reorders = await ReorderRequest.find(query)
    .populate("product")
    .populate("requestedBy", "name name_first name_last email")
    .populate("reviewedBy", "name name_first name_last email")
    .sort({ createdAt: -1 })
    .limit(200);
  return res.json({ reorders: reorders.map(serializeReorder) });
};

const updateReorderStatus = async (req, res) => {
  if (!requireAdmin(req, res)) return null;
  if (req.authUser.role !== "superadmin") {
    return res.status(403).json({ message: "Only SuperAdmin can approve or reject reorder requests." });
  }

  const status = String(req.body?.status || "").trim().toLowerCase();
  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ message: "Status must be approved or rejected." });
  }

  const reorder = await ReorderRequest.findById(req.params.reorderId).populate("product");
  if (!reorder) return res.status(404).json({ message: "Reorder request not found." });
  if (reorder.status !== "submitted") {
    return res.status(409).json({ message: "This reorder request has already been reviewed." });
  }

  if (status === "approved") {
    const product = reorder.product;
    if (!product) return res.status(409).json({ message: "The requested product is no longer available." });
    const current = Number(product.branchStock?.get(reorder.branch) || 0);
    product.branchStock.set(reorder.branch, current + Number(reorder.quantity));
    product.stock = BRANCHES.reduce(
      (total, branch) => total + Number(product.branchStock?.get(branch) || 0),
      0,
    );
    await ensureProductSerialUnits(product, product.stock);
    await product.save();
  }

  reorder.status = status;
  reorder.reviewNotes = String(req.body?.reviewNotes || "").trim();
  reorder.reviewedBy = req.authUser._id;
  reorder.reviewedAt = new Date();
  await reorder.save();

  try {
    await Notification.create({
      user: reorder.requestedBy,
      type: "system",
      title: `Reorder ${status}`,
      message: `${reorder.product?.name || "Inventory item"}: ${reorder.quantity} unit(s) for ${reorder.branch} ${status}.`,
    });
  } catch (_error) {
    // A notification failure must not undo a completed inventory decision.
  }

  await reorder.populate([
    "product",
    { path: "requestedBy", select: "name name_first name_last email" },
    { path: "reviewedBy", select: "name name_first name_last email" },
  ]);
  return res.json({ reorder: serializeReorder(reorder) });
};

module.exports = {
  createReorderRequest,
  listReorders,
  listMyReorders,
  updateReorderStatus,
};

