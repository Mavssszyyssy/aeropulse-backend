const mongoose = require("mongoose");
const {
  normalizeOptionalIdentity,
} = require("../utils/optionalIdentity");
const { buildEmailIdentityKey } = require("../domain/demoStaffPolicy");

const addressSchema = new mongoose.Schema(
  {
    label: { type: String, default: "" },
    type: { type: String, enum: ["home", "office", "other"], default: "home" },
    name: { type: String, default: "", trim: true },
    phone: { type: String, default: "", trim: true },
    region: { type: String, default: "", trim: true },
    regionCode: { type: String, default: "", trim: true },
    province: { type: String, default: "", trim: true },
    provinceCode: { type: String, default: "", trim: true },
    street: { type: String, default: "", trim: true },
    barangay: { type: String, default: "", trim: true },
    submunicipalityCode: { type: String, default: "", trim: true },
    city: { type: String, default: "", trim: true },
    municipalityCode: { type: String, default: "", trim: true },
    postalCode: { type: String, default: "", trim: true },
    isDefault: { type: Boolean, default: false },
  },
  { _id: true },
);

const billingAddressSchema = new mongoose.Schema(
  {
    region: { type: String, default: "", trim: true },
    regionCode: { type: String, default: "", trim: true },
    province: { type: String, default: "", trim: true },
    provinceCode: { type: String, default: "", trim: true },
    city: { type: String, default: "", trim: true },
    municipalityCode: { type: String, default: "", trim: true },
    barangay: { type: String, default: "", trim: true },
    submunicipalityCode: { type: String, default: "", trim: true },
    street: { type: String, default: "", trim: true },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    legalConsent: {
      type: new mongoose.Schema({
        version: { type: String, required: true },
        acceptedAt: { type: Date, required: true },
        app: { type: Boolean, required: true },
        service: { type: Boolean, required: true },
        warranty: { type: Boolean, required: true },
        privacy: { type: Boolean, required: true },
      }, { _id: false }),
      default: undefined,
    },
    name: { type: String, trim: true },
    name_first: { type: String, required: true, trim: true },
    name_last: { type: String, required: true, trim: true },
    email: {
      type: String,
      // Staff and legacy accounts may not have an email; public signup requires email verification.
      required: false,
      lowercase: true,
      trim: true,
      set: normalizeOptionalIdentity,
    },
    // Normal accounts store email:<normalized address>. The five named demo
    // accounts store separate shared-demo:<account alias> keys, so the
    // database still rejects duplicate customer/ordinary staff email values.
    emailIdentityKey: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      select: false,
    },
    username: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      minlength: 2,
      maxlength: 30,
      match: /^[a-z0-9_.-]+$/,
      set: normalizeOptionalIdentity,
    },
    alias: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      set: normalizeOptionalIdentity,
    },
    phone: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      set: normalizeOptionalIdentity,
    },
    passwordHash: { type: String },
    authProvider: {
      type: String,
      enum: ["local", "google"],
      default: "local",
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true,
      set: normalizeOptionalIdentity,
    },
    avatarUrl: { type: String, default: "" },
    role: {
      type: String,
      enum: ["customer", "technician", "manager", "owner", "admin", "superadmin"],
      default: "customer",
    },
    address: { type: String, default: "" },
    municipality: { type: String, default: "", trim: true },
    municipality_code: { type: String, default: "", trim: true },
    submunicipality: { type: String, default: "", trim: true },
    submunicipality_code: { type: String, default: "", trim: true },
    thoroughfare: { type: String, default: "", trim: true },
    property_block_lot: { type: String, default: "", trim: true },
    apartment_unit: { type: String, default: "", trim: true },
    landmark: { type: String, default: "", trim: true },
    plus_code: { type: String, default: "", trim: true },
    contact_method: { type: String, default: "", trim: true },
    messenger_handle: { type: String, default: "", trim: true },
    delivery_instructions: { type: String, default: "", trim: true },
    billingAddress: { type: billingAddressSchema, default: () => ({}) },
    addresses: [addressSchema],
    preferences: {
      language: { type: String, default: "English" },
      currency: { type: String, default: "PHP" },
      timezone: { type: String, default: "Asia/Manila" },
      theme: { type: String, enum: ["light", "dark"], default: "light" },
      darkMode: { type: Boolean, default: false },
      autoBook: { type: Boolean, default: true },
    },
    privacy: {
      profileVisibility: {
        type: String,
        enum: ["public", "private", "role_based"],
        default: "public",
      },
      dataSharing: { type: Boolean, default: false },
      showEmail: { type: Boolean, default: false },
      showPhone: { type: Boolean, default: false },
      activityStatus: { type: Boolean, default: true },
    },
    notifications: {
      email: { type: Boolean, default: true },
      inApp: { type: Boolean, default: true },
      push: { type: Boolean, default: true },
      sms: { type: Boolean, default: false },
      accountUpdates: { type: Boolean, default: true },
      orderUpdates: { type: Boolean, default: true },
      systemAlerts: { type: Boolean, default: true },
      promotions: { type: Boolean, default: true },
      serviceUpdates: { type: Boolean, default: true },
    },
    expoPushTokens: [{ type: String, trim: true }],
    skills: [{ type: String }],
    serviceQuota: { type: Number, min: 1, default: null },
    permissions: [{ type: String }],
    department: { type: String },
    assignedBranch: { type: String, default: "" },
    activeBranch: { type: String, default: "" },
    sourceOfAcquisition: {
      type: String,
      enum: ["social_media", "google", "friend_referral", "walk_in", "other"],
      default: "other",
    },
    lastLogin: { type: Date },
    failedLoginAttempts: { type: Number, default: 0 },
    lockoutUntil: { type: Date, default: null },
    security: {
      sessionVersion: { type: Number, default: 0 },
    },
    accountStatus: {
      type: String,
      enum: ["active", "disabled", "deleted"],
      default: "active",
      index: true,
    },
    location: {
      coordinates: {
        latitude: { type: Number, min: -90, max: 90 },
        longitude: { type: Number, min: -180, max: 180 },
        accuracy: { type: Number, min: 0 }, // meters
        timestamp: { type: Date },
      },
      address: {
        region: { type: String, default: "", trim: true },
        regionCode: { type: String, default: "", trim: true },
        province: { type: String, default: "", trim: true },
        provinceCode: { type: String, default: "", trim: true },
        city: { type: String, default: "", trim: true },
        municipalityCode: { type: String, default: "", trim: true },
        barangay: { type: String, default: "", trim: true },
        submunicipalityCode: { type: String, default: "", trim: true },
        street: { type: String, default: "", trim: true },
        postalCode: { type: String, default: "", trim: true },
      },
      capturedAt: { type: Date },
      source: {
        type: String,
        enum: ["gps", "manual", "ip"],
        default: "manual",
      },
    },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },

    isFirstLogin: { type: Boolean, default: false }, // For staff onboarding
    technicianOnboardedAt: { type: Date, default: null },
    customerOnboardedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.pre("validate", function assignEmailIdentityKey() {
  this.emailIdentityKey = buildEmailIdentityKey(this, this.email);
});

userSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    delete ret.passwordHash;
    delete ret.emailIdentityKey;
    delete ret.failedLoginAttempts;
    delete ret.lockoutUntil;
    return ret;
  },
});

module.exports = mongoose.model("User", userSchema);
