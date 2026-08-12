const dotenv = require("dotenv");

dotenv.config();

const DEFAULT_CORS_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5000",
  "http://127.0.0.1:5000",
  "http://localhost:5001",
  "http://127.0.0.1:5001",
  "http://localhost:8081",
  "http://127.0.0.1:8081",
  "http://localhost:19006",
  "http://127.0.0.1:19006",
];

const parseCorsOrigins = (value = "") => {
  if (!value || !String(value).trim()) {
    return [];
  }
  return String(value)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
};

const isPrivateLanOrigin = (origin = "") =>
  /^https?:\/\/(?:(?:localhost|127\.0\.0\.1)|(?:10\.)|(?:192\.168\.)|(?:172\.(?:1[6-9]|2\d|3[01])\.))[^/]*$/i.test(
    origin,
  );

const buildCorsOrigin = () => {
  const configuredOrigins = parseCorsOrigins(process.env.CORS_ORIGIN);
  return (origin, callback) => {
    if (!origin) return callback(null, true);
    if (
      configuredOrigins.includes(origin) ||
      DEFAULT_CORS_ORIGINS.includes(origin) ||
      isPrivateLanOrigin(origin)
    ) {
      return callback(null, origin);
    }
    return callback(new Error(`CORS origin not allowed: ${origin}`));
  };
};

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  host: process.env.HOST || "0.0.0.0",
  port: process.env.PORT || 5000,
  mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/aeropulse",
  mongoDirectHosts: process.env.MONGODB_DIRECT_HOSTS || "",
  mongoReplicaSet: process.env.MONGODB_REPLICA_SET || "",
  jwtSecret: process.env.JWT_SECRET || "dev-secret",
  corsOrigin: buildCorsOrigin(),
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
  backendPublicUrl: process.env.BACKEND_PUBLIC_URL || process.env.PAYMONGO_RETURN_BASE_URL || "",
  mobileUrlScheme: process.env.MOBILE_URL_SCHEME || "coldair",
  paymongoMode: process.env.PAYMONGO_MODE || "",
  paymongoSecretKey: process.env.PAYMONGO_SECRET_KEY || "",
  paymongoWebhookSecret: process.env.PAYMONGO_WEBHOOK_SECRET || "",
  paymongoApiBaseUrl: process.env.PAYMONGO_API_BASE_URL || "https://api.paymongo.com",
  openAiApiKey: process.env.OPENAI_API_KEY || "",
  openAiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  openAiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRedirectUri:
    process.env.GOOGLE_REDIRECT_URI ||
    "http://localhost:5000/api/auth/google/callback",
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpSecure:
    String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  smtpFrom: process.env.SMTP_FROM || "",
  passwordResetTokenSecret:
    process.env.PASSWORD_RESET_TOKEN_SECRET ||
    process.env.JWT_SECRET ||
    "dev-secret",
  passwordResetTokenTtlMinutes: Number(
    process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES || 20,
  ),
  accountDeleteMode: process.env.ACCOUNT_DELETE_MODE || "soft",
  infobipApiKey: process.env.INFOBIP_API_KEY || "",
  infobipBaseUrl: process.env.INFOBIP_BASE_URL || "",
  infobipSender: process.env.INFOBIP_SENDER || "",
};

module.exports = env;
