const InventoryChangeRequest = require("../models/InventoryChangeRequest");
const AuditLog = require("../models/AuditLog");
const Product = require("../models/Product");
const { createDedupedNotification, notifyOperationalStaff } = require("../services/operationalNotificationService");
const { ensureProductSerialUnits } = require("./productController");

/**
 * Manager creates a change request for inventory
 */
const createChangeRequest = async (req, res) => {
  if (req.authUser.role !== "admin") {
    return res.status(403).json({ message: "Only branch admins can request inventory changes" });
  }

  const { productId, requestedStock, addQuantity, reason } = req.body;
  const branch = req.activeBranch;

  if (!productId || (requestedStock === undefined && addQuantity === undefined) || !reason?.trim()) {
    return res.status(400).json({ message: "Product, quantity, and reason are required" });
  }

  const product = await Product.findById(productId);
  if (!product) {
    return res.status(404).json({ message: "Product not found" });
  }

  const currentStockValue = Number(product.branchStock.get(branch) || 0);
  let requestedQuantity = 0;
  if (addQuantity !== undefined) {
    const qty = Number(addQuantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ message: "Quantity must be a valid positive number" });
    }
    requestedQuantity = currentStockValue + qty;
  } else {
    requestedQuantity = Number(requestedStock);
  }

  if (!Number.isFinite(requestedQuantity) || requestedQuantity <= currentStockValue) {
    return res.status(400).json({ message: "Requested stock must be greater than the current branch stock." });
  }

  try {
    const request = await InventoryChangeRequest.create({
      product: productId,
      branch,
      requestedBy: req.authUser._id,
      currentStock: currentStockValue,
      requestedStock: requestedQuantity,
      reason: reason.trim(),
    });

    // Create audit log
    await AuditLog.create({
      action: "inventory_change_requested",
      user: req.authUser._id,
      branch,
      entityType: "inventory_change_request",
      entityId: request._id,
      description: `Manager requested inventory increase for ${product.name} from ${currentStockValue} to ${requestedQuantity}`,
      ipAddress: req.ip,
    });

    await notifyOperationalStaff({
      branch,
      roles: ["superadmin"],
      type: "inventory",
      category: "inventory_change_request",
      severity: "warning",
      title: "Pending inventory change request",
      message: `Admin ${req.authUser.name} requested to increase ${product.name} inventory from ${currentStockValue} to ${requestedQuantity} at ${branch}.`,
      targetId: String(request._id),
      targetType: "inventory_change_request",
      route: "/superadmin/inventory",
      dedupeKey: `inventory-change:${request._id}:pending`,
    });

    return res.status(201).json({ request: request.toJSON() });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

/**
 * Get pending change requests (for owners)
 */
const getPendingRequests = async (req, res) => {
  if (req.authUser.role !== "superadmin") {
    return res.status(403).json({ message: "Only owners can review requests" });
  }

  try {
    const requests = await InventoryChangeRequest.find({ status: "pending" })
      .populate("product", "name sku branchStock")
      .populate("requestedBy", "name email activeBranch")
      .sort({ createdAt: -1 });

    return res.json({ requests: requests.map((r) => r.toJSON()) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

/**
 * Get change requests for manager (their requests)
 */
const getMyRequests = async (req, res) => {
  try {
    const requests = await InventoryChangeRequest.find({ requestedBy: req.authUser._id })
      .populate("product", "name sku branchStock")
      .sort({ createdAt: -1 });

    return res.json({ requests: requests.map((r) => r.toJSON()) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

/**
 * Owner approves a change request
 */
const approveRequest = async (req, res) => {
  if (req.authUser.role !== "superadmin") {
    return res.status(403).json({ message: "Only owners can approve requests" });
  }

  const { id } = req.params;

  const request = await InventoryChangeRequest.findById(id);
  if (!request) {
    return res.status(404).json({ message: "Request not found" });
  }

  if (request.status !== "pending") {
    return res.status(400).json({ message: "Only pending requests can be approved" });
  }

  try {
    const product = await Product.findById(request.product);
    const oldStock = Number(product.branchStock.get(request.branch) || 0);

    if (request.requestedStock <= oldStock) {
      return res.status(400).json({ message: "Approved inventory changes must increase branch stock." });
    }

    // Update inventory
    product.branchStock.set(request.branch, request.requestedStock);
    product.stock = Array.from(product.branchStock.values()).reduce((sum, val) => sum + val, 0);
    await ensureProductSerialUnits(product, product.stock, { deferSave: true });
    await product.save();

    // Update request status
    request.status = "approved";
    request.reviewedBy = req.authUser._id;
    request.approvedAt = new Date();
    await request.save();

    // Create audit log
    await AuditLog.create({
      action: "inventory_change_approved",
      user: req.authUser._id,
      branch: request.branch,
      entityType: "inventory_change_request",
      entityId: request._id,
      changeDetails: {
        before: { stock: oldStock },
        after: { stock: request.requestedStock },
      },
      description: `Approved inventory change for ${product.name} at ${request.branch}: ${oldStock} → ${request.requestedStock}`,
      ipAddress: req.ip,
    });

    await createDedupedNotification({
      user: request.requestedBy,
      branch: request.branch,
      type: "inventory",
      category: "inventory_change_request",
      title: "Inventory Change Approved",
      message: `Your request to change ${product.name} from ${oldStock} to ${request.requestedStock} at ${request.branch} has been approved.`,
      targetId: String(request._id),
      targetType: "inventory_change_request",
      route: "/admin/inventory",
      dedupeKey: `inventory-change:${request._id}:approved`,
    });

    return res.json({ request: request.toJSON() });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

/**
 * Owner rejects a change request
 */
const rejectRequest = async (req, res) => {
  if (req.authUser.role !== "superadmin") {
    return res.status(403).json({ message: "Only owners can reject requests" });
  }

  const { id } = req.params;
  const { rejectionReason } = req.body;

  if (!rejectionReason?.trim()) {
    return res.status(400).json({ message: "Rejection reason is required" });
  }

  const request = await InventoryChangeRequest.findById(id);
  if (!request) {
    return res.status(404).json({ message: "Request not found" });
  }

  if (request.status !== "pending") {
    return res.status(400).json({ message: "Only pending requests can be rejected" });
  }

  try {
    const product = await Product.findById(request.product);

    // Update request status
    request.status = "rejected";
    request.reviewedBy = req.authUser._id;
    request.rejectionReason = rejectionReason.trim();
    request.rejectedAt = new Date();
    await request.save();

    // Create audit log
    await AuditLog.create({
      action: "inventory_change_rejected",
      user: req.authUser._id,
      branch: request.branch,
      entityType: "inventory_change_request",
      entityId: request._id,
      description: `Rejected inventory change request for ${product.name} at ${request.branch}: "${rejectionReason}"`,
      ipAddress: req.ip,
    });

    await createDedupedNotification({
      user: request.requestedBy,
      branch: request.branch,
      type: "inventory",
      category: "inventory_change_request",
      severity: "warning",
      title: "Inventory Change Rejected",
      message: `Your request to change ${product.name} at ${request.branch} has been rejected. Reason: ${rejectionReason}`,
      targetId: String(request._id),
      targetType: "inventory_change_request",
      route: "/admin/inventory",
      dedupeKey: `inventory-change:${request._id}:rejected`,
    });

    return res.json({ request: request.toJSON() });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createChangeRequest,
  getPendingRequests,
  getMyRequests,
  approveRequest,
  rejectRequest,
};
