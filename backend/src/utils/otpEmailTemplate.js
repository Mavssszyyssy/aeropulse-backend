const OTP_CONTENT = {
  register_email: {
    subject: "Confirm your Cold Air ACT email",
    eyebrow: "WELCOME TO AEROPULSE",
    title: "Verify your email address",
    introduction:
      "Enter this verification code in Cold Air ACT to finish creating your account.",
  },
  password_reset: {
    subject: "Reset your Cold Air ACT password",
    eyebrow: "SECURE ACCOUNT RECOVERY",
    title: "Reset your password",
    introduction:
      "Enter this verification code in Cold Air ACT to continue resetting your password.",
  },
  login_verification: {
    subject: "Verify your Cold Air ACT sign-in",
    eyebrow: "SECURE SIGN-IN",
    title: "Verify your sign-in",
    introduction:
      "Enter this verification code in Cold Air ACT to finish signing in to your account.",
  },
};

const buildOtpEmail = ({ code, action, expiresInMinutes }) => {
  const content = OTP_CONTENT[action] || {
    subject: "Your Cold Air ACT verification code",
    eyebrow: "SECURE VERIFICATION",
    title: "Verify your identity",
    introduction: "Enter this verification code in Cold Air ACT to continue.",
  };
  const safeCode = String(code || "").replace(/\D/g, "").slice(0, 6);
  const minutes = Math.max(1, Number(expiresInMinutes) || 5);
  const expiryLabel = `${minutes} minute${minutes === 1 ? "" : "s"}`;

  const text = [
    "COLD AIR ACT | AEROPULSE",
    "",
    content.title,
    content.introduction,
    "",
    `Verification code: ${safeCode}`,
    `This code expires in ${expiryLabel}.`,
    "",
    "For your security, never share this code with anyone. Cold Air ACT staff will never ask for it.",
    "If you did not request this code, you can safely ignore this email.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <title>${content.subject}</title>
    <style>
      @media only screen and (max-width: 620px) {
        .email-shell { padding: 20px 12px !important; }
        .email-card { border-radius: 18px !important; }
        .email-header, .email-body { padding-left: 24px !important; padding-right: 24px !important; }
        .otp-code { font-size: 32px !important; letter-spacing: 7px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#eff6ff;font-family:Arial,'Helvetica Neue',sans-serif;color:#0f172a;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Your Cold Air ACT code is ${safeCode}. It expires in ${expiryLabel}.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#eff6ff;">
      <tr>
        <td class="email-shell" align="center" style="padding:40px 16px;">
          <table role="presentation" class="email-card" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #dbeafe;border-radius:24px;overflow:hidden;box-shadow:0 16px 40px rgba(30,136,229,0.12);">
            <tr>
              <td class="email-header" style="padding:30px 40px;background:#0f2744;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td width="56" height="56" align="center" valign="middle" style="width:56px;height:56px;">
                      <img src="https://coldair-act.online/Cold%20Air%20Logo.jpg" width="56" height="56" alt="Cold Air ACT logo" style="display:block;width:56px;height:56px;border:0;border-radius:50%;background:#ffffff;">
                    </td>
                    <td style="padding-left:14px;">
                      <div style="font-size:20px;line-height:26px;font-weight:800;color:#ffffff;">Cold Air ACT</div>
                      <div style="font-size:12px;line-height:18px;font-weight:700;letter-spacing:1.2px;color:#93c5fd;">AEROPULSE</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td class="email-body" style="padding:38px 40px 34px;">
                <div style="font-size:11px;line-height:16px;font-weight:800;letter-spacing:1.4px;color:#1e88e5;">${content.eyebrow}</div>
                <h1 style="margin:8px 0 12px;font-size:28px;line-height:36px;color:#0f172a;">${content.title}</h1>
                <p style="margin:0;font-size:16px;line-height:26px;color:#475569;">${content.introduction}</p>

                <div style="margin:28px 0 20px;padding:24px 16px;text-align:center;background:#f8fbff;border:2px solid #bfdbfe;border-radius:18px;">
                  <div style="margin-bottom:9px;font-size:11px;line-height:16px;font-weight:800;letter-spacing:1.3px;color:#64748b;">YOUR ONE-TIME CODE</div>
                  <div class="otp-code" style="font-family:'Courier New',monospace;font-size:38px;line-height:46px;font-weight:800;letter-spacing:10px;color:#1565c0;">${safeCode}</div>
                </div>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-bottom:24px;">
                  <tr>
                    <td style="padding:13px 16px;background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;font-size:14px;line-height:21px;color:#9a3412;">
                      <strong>Time-sensitive:</strong> this code expires in ${expiryLabel}.
                    </td>
                  </tr>
                </table>

                <p style="margin:0 0 8px;font-size:14px;line-height:22px;color:#475569;"><strong style="color:#0f172a;">Keep your account secure.</strong> Never share this code with anyone. Cold Air ACT staff will never ask for it.</p>
                <p style="margin:0;font-size:13px;line-height:21px;color:#64748b;">If you did not request this code, you can safely ignore this email.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 40px;background:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;font-size:12px;line-height:18px;color:#64748b;">
                Cold Air ACT &bull; Airconditioning Trading<br>
                This is an automated security message. Please do not reply.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject: content.subject, text, html };
};

module.exports = { buildOtpEmail };
