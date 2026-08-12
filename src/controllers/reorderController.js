const ReorderRequest = require("../models/ReorderRequest");
const Product = require("../models/Product");

const requireAdmin = (req, res) => {
  if (req.authUser.role !== "admin" && req.authUser.role !== "superadmin") {
    res.status(403).json({ message: "Forbidden" });
    return false;
  }
  return true;
};

const createReorderRequest = async (req, res) => {
  if (!requireAdmin(req, res)) return null;

  const { productId, quantity, notes = "" } = req.body || {};
  if (!productId || !quantity) {
    return res.status(400).json({ message: "productId and quantity are required" });
  }

  const product = await Product.findById(productId);
  if (!product) {
    return res.status(404).json({ message: "Product not found" });
  }

  const reorder = await ReorderRequest.create({
    requestedBy: req.authUser._id,
    product: product._id,
    quantity: Number(quantity),
    branch: req.authUser.role === "superadmin" ? (req.body?.branch || "") : req.activeBranch,
    notes,
  });

  return res.status(201).json({ reorder: reorder.toJSON() });
};

const listMyReorders = async (req, res) => {
  if (!requireAdmin(req, res)) return null;
  const query = { requestedBy: req.authUser._id };
  if (req.authUser.role !== "superadmin") {
    query.$or = [{ branch: req.activeBranch }, { branch: "" }, { branch: { $exists: false } }];
  }
  const reorders = await ReorderRequest.find(query)
    .populate("product")
    .sort({ createdAt: -1 })
    .limit(100);
  return res.json({
    reorders: reorders.map((r) => {
      const json = r.toJSON();
      return {
        ...json,
        product: r.product ? r.product.toJSON() : null,
      };
    }),
  });
};

module.exports = { createReorderRequest, listMyReorders };

