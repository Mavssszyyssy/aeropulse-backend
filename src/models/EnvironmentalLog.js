const mongoose = require("mongoose");

const environmentalLogSchema = new mongoose.Schema(
  {
    zipCode: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    date: {
      type: Date,
      required: true,
      index: true,
    },

    source: {
      provider: { type: String, default: "unknown", trim: true },
      providerLocationId: { type: String, default: "", trim: true },
      fetchedAt: { type: Date, default: Date.now },
    },

    weather: {
      minTempC: { type: Number, default: null },
      maxTempC: { type: Number, default: null },
      avgTempC: { type: Number, default: null },
      avgHumidityPercent: { type: Number, default: null, min: 0, max: 100 },
      rainfallMm: { type: Number, default: 0, min: 0 },
      airQualityIndex: { type: Number, default: null, min: 0 },
    },

    stress: {
      // Precomputed environmental multiplier. If absent, AMP derives it from weather.
      degradationMultiplier: { type: Number, default: null, min: 0 },

      // Human-readable flags for managers and audit trails.
      flags: [{ type: String, trim: true }],
    },
  },
  { timestamps: true },
);

environmentalLogSchema.index({ zipCode: 1, date: 1 }, { unique: true });

environmentalLogSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("EnvironmentalLog", environmentalLogSchema);
