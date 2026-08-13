const nodemailer = require("nodemailer");
const env = require("../config/env");

let cachedTransporter = null;

const canSendEmail = () => {
  return Boolean(
    (env.infobipApiKey && env.infobipBaseUrl && env.infobipEmailSender) ||
    (env.smtpHost && env.smtpUser && env.smtpPass && env.smtpFrom),
  );
};

const getInfobipEmailConfiguration = () => ({
  apiKey: Boolean(env.infobipApiKey),
  baseUrl: Boolean(env.infobipBaseUrl),
  sender: Boolean(env.infobipEmailSender),
});

const getMissingInfobipSettings = () =>
  Object.entries(getInfobipEmailConfiguration())
    .filter(([, configured]) => !configured)
    .map(
      ([key]) =>
        ({
          apiKey: "INFOBIP_API_KEY",
          baseUrl: "INFOBIP_BASE_URL",
          sender: "INFOBIP_EMAIL_SENDER",
        }[key]),
    );

const infobipBaseUrl = () =>
  String(env.infobipBaseUrl || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");

const getTransporter = () => {
  if (!env.smtpHost || !env.smtpUser || !env.smtpPass || !env.smtpFrom)
    return null;
  if (cachedTransporter) return cachedTransporter;

  cachedTransporter = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpSecure,
    auth: {
      user: env.smtpUser,
      pass: env.smtpPass,
    },
  });

  return cachedTransporter;
};

const sendEmailViaInfobip = async ({ to, subject, text, html }) => {
  const url = `https://${infobipBaseUrl()}/email/4/messages`;
  const headers = {
    Authorization: `App ${env.infobipApiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const body = JSON.stringify({
    messages: [
      {
        sender: env.infobipEmailSender,
        destinations: [
          {
            to: [{ destination: to }],
          },
        ],
        content: {
          subject,
          text,
          html,
        },
      },
    ],
  });

  const res = await fetch(url, {
    method: "POST",
    headers,
    body,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `Infobip Email failed: ${data.message || JSON.stringify(data)}`,
    );
  }

  return data;
};

const sendEmail = async ({ to, subject, text, html }) => {
  // 1. Try Infobip first if API Key is present
  let infobipError = null;
  if (env.infobipApiKey && env.infobipBaseUrl && env.infobipEmailSender) {
    try {
      await sendEmailViaInfobip({ to, subject, text, html });
      console.log(`[INFOBIP] Email dispatched to ${to}`);
      return;
    } catch (err) {
      console.error("[INFOBIP] Email dispatch error:", err.message);
      infobipError = err;
      // Fall through to SMTP if configured
    }
  }

  // 2. Fallback to Nodemailer SMTP
  const transporter = getTransporter();
  if (!transporter) {
    if (infobipError) {
      throw new Error(
        `Infobip rejected the email request: ${infobipError.message}. ` +
          "Check the API key's email:message:send permission, account status, and verified email sender.",
      );
    }
    const missing = getMissingInfobipSettings();
    throw new Error(
      missing.length
        ? `Email delivery is not configured. In Vercel, set: ${missing.join(", ")}.`
        : "No email transport configured. Set Infobip Email or SMTP settings in Vercel.",
    );
  }

  await transporter.sendMail({
    from: env.smtpFrom,
    to,
    subject,
    text,
    html,
  });
  console.log(`[SMTP] Email dispatched to ${to}`);
};

module.exports = {
  canSendEmail,
  getInfobipEmailConfiguration,
  sendEmail,
};
