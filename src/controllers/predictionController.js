const { predictLikelyFailingParts } = require("../domain/partsPredictionService");

const getPredictedParts = async (req, res) => {
  try {
    const unitId = req.query.unitId || req.query.unit_id;
    if (!unitId) {
      return res.status(400).json({ message: "unitId is required." });
    }

    const result = await predictLikelyFailingParts({ unitId });
    return res.json(result);
  } catch (error) {
    console.error("Failed to predict likely failing parts:", error);
    return res.status(error.status || 500).json({
      message: error.message || "Unable to load predicted parts.",
    });
  }
};

module.exports = { getPredictedParts };
