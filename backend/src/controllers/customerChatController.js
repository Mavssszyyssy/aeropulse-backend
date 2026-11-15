const { getCustomerChatReply } = require("../services/openAiCustomerChatService");

const sendCustomerChatMessage = async (req, res) => {
  try {
    const result = await getCustomerChatReply({
      message: req.body?.message,
      history: req.body?.history,
      currentPage: req.body?.currentPage,
      language: req.body?.language === "Filipino" ? "Filipino" : "English",
      safetyIdentifier: req.authUser?._id ? String(req.authUser._id) : undefined,
    });
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({
      message: error.message || "The AEROPULSE assistant is unavailable right now.",
    });
  }
};

module.exports = { sendCustomerChatMessage };
