const nodemailer = require("nodemailer");
const env = require("../config/env");

let cachedTransporter = null;

const canSendEmail = () => {
  return Boolean(
    (env.infobipApiKey && env.infobipBaseUrl && env.infobipEmailSender) ||
    (env.smtpHost && env.smtpUser && env.smtpPass && env.smtpFrom),
  );
};

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
  if (env.infobipApiKey && env.infobipBaseUrl && env.infobipEmailSender) {
    try {
      await sendEmailViaInfobip({ to, subject, text, html });
      console.log(`[INFOBIP] Email dispatched to ${to}`);
      return;
    } catch (err) {
      console.error("[INFOBIP] Email dispatch error:", err.message);
      // Fall through to SMTP if configured
    }
  }

  // 2. Fallback to Nodemailer SMTP
  const transporter = getTransporter();
  if (!transporter) {
    throw new Error("No email transport configured (Infobip or SMTP).");
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
  sendEmail,
};
