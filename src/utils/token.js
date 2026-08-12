const jwt = require("jsonwebtoken");
const env = require("../config/env");

const signAccessToken = (payload) => {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: "7d" });
};

module.exports = { signAccessToken };
