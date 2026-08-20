const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    brand: { type: String, default: "" },
    category: { type: String, default: "split" },
    description: { type: String, default: "", trim: true },
    specs: { type: String, default: "" },
    features: [{ type: String }],
    image: { type: String, default: "", trim: true },
    imageData: { type: Buffer },
    imageContentType: { type: String },
    stock: { type: Number, default: 0 },
    branchStock: {
      type: Map,
      of: Number,
      default: {},
    },
    serialUnits: [
      {
        // Permanent internal identity printed in the QR payload. It never changes
        // when a temporary inventory serial is replaced by a manufacturer serial.
        qrUnitId: { type: String, default: "", trim: true, index: true },
        serialNumber: {
          type: String,
          required: true,
          trim: true,
        },
        serialKind: {
          type: String,
          enum: ["generated", "manufacturer"],
          default: "generated",
        },
        // Previous temporary serials remain searchable so an already printed QR
        // label continues to locate the same physical AC unit after real testing.
        serialAliases: [{ type: String, trim: true }],
        qrCode: { type: String, default: "", trim: true },
        branch: { type: String, default: "", trim: true },
        status: {
          type: String,
          enum: ["available", "assigned", "sold", "service", "retired"],
          default: "available",
        },
        assignedOrderId: { type: String, default: "", trim: true },
        assignedOrderCode: { type: String, default: "", trim: true },
        assignedAt: { type: Date, default: null },
        registeredAt: { type: Date, default: null },
        ampRegistration: {
          type: mongoose.Schema.Types.Mixed,
          default: {},
        },
        defectHold: {
          type: mongoose.Schema.Types.Mixed,
          default: {},
        },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    threshold: { type: Number, default: 0 },
    branchThresholds: {
      type: Map,
      of: Number,
      default: {},
    },
    price: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

productSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

// Database-level unique indexes with case-insensitive collation
// This ensures no duplicates can be created at the database level
productSchema.index(
  { sku: 1 },
  {
    unique: true,
    collation: { locale: "en", strength: 2 },
    name: "idx_sku_unique_case_insensitive",
  },
);

productSchema.index(
  { "serialUnits.qrUnitId": 1 },
  {
    unique: true,
    sparse: true,
    name: "idx_serial_units_qr_unit_id_unique",
  },
);

// Compound index for unique product variants (name + specs combination)
productSchema.index(
  { name: 1, specs: 1 },
  {
    unique: true,
    collation: { locale: "en", strength: 2 },
    name: "idx_name_specs_unique_case_insensitive",
  },
);

// Regular indexes for common queries
productSchema.index({ category: 1, isActive: 1 });
productSchema.index({ brand: 1 });
productSchema.index({ createdAt: -1 });
productSchema.index({ stock: 1 });
productSchema.index(
  { "serialUnits.serialNumber": 1 },
  {
    unique: true,
    sparse: true,
    collation: { locale: "en", strength: 2 },
    name: "idx_serial_units_serial_number_unique",
  },
);

module.exports = mongoose.model("Product", productSchema);
