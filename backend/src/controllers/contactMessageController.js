const crypto = require("crypto");
const ContactMessage = require("../models/ContactMessage");
const User = require("../models/User");
const { buildOperationalContactFilter } = require("../domain/operationalContactMessages");
const { resolvePreferredBranch } = require("../domain/branchRouting");
const {
  createDedupedNotification,
  notifyOperationalStaff,
} = require("../services/operationalNotificationService");
const { validateEmailAddress } = require("../services/emailDomainPolicyService");

const VALID_CATEGORIES = new Set([
  "general",
  "product",
  "order",
  "service",
  "warranty",
  "consultation",
  "other",
]);
const VALID_STATUSES = new Set(["new", "in_progress", "resolved", "closed"]);

const clean = (value, maxLength = 3000) =>
  String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);

const displayName = (user = {}) =>
  clean(user.name, 120) ||
  clean(`${user.name_first || ""} ${user.name_last || ""}`, 120) ||
  clean(user.email || user.phone, 120) ||
  "Customer";

const ticketCode = () => {
  const date = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  return `MSG-${date}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
};

const defaultAddressFor = (user = {}) => {
  const addresses = Array.isArray(user.addresses) ? user.addresses : [];
  const selected = addresses.find((address) => address?.isDefault) || addresses[0];
  if (selected) return selected;
  return {
    street: user.address || user.thoroughfare || "",
    barangay: user.submunicipality || "",
    city: user.municipality || "",
    province: user.billingAddress?.province || "",
  };
};

const categoryLabel = (category = "general") => ({
  general: "General question",
  product: "Product question",
  order: "Order help",
  service: "Service or repair",
  warranty: "Warranty help",
  consultation: "Appointment request",
  other: "Other concern",
}[category] || "Customer message");

const createContactMessage = async (req, res) => {
  try {
    const user = req.authUser;
    const payload = req.body || {};
    const category = clean(payload.category, 30);
    if (!VALID_CATEGORIES.has(category)) return res.status(400).json({ message: "Choose a valid support topic." });
    if (typeof payload.subject !== "string" || typeof payload.message !== "string") {
      return res.status(400).json({ message: "Subject and message are required." });
    }
    if (payload.subject.trim().length > 160) return res.status(400).json({ message: "Subject must be 160 characters or fewer." });
    if (payload.message.trim().length > 3000) return res.status(400).json({ message: "Message must be 3000 characters or fewer." });
    const subject = clean(payload.subject, 160);
    const message = clean(payload.message, 3000);
    if (!subject || !message) {
      return res.status(400).json({ message: "Subject and message are required." });
    }
    if (subject.length < 3) return res.status(400).json({ message: "Subject must be at least 3 characters." });
    if (message.length < 10) {
      return res.status(400).json({ message: "Please add a little more detail so the support team can help." });
    }
    const submittedEmail = clean(req.body.email, 180) || clean(user.email, 180);
    const emailValidation = await validateEmailAddress(submittedEmail);
    if (!emailValidation.ok) {
      return res.status(400).json({ message: emailValidation.message });
    }

    const idempotencyKey = clean(
      req.headers["idempotency-key"] || req.body.idempotencyKey,
      120,
    );
    if (idempotencyKey) {
      const existing = await ContactMessage.findOne({ customer: user._id, idempotencyKey });
      if (existing) return res.status(200).json({ message: existing, duplicate: true });
    }

    const branch = await resolvePreferredBranch(defaultAddressFor(user));
    const item = await ContactMessage.create({
      ticketCode: ticketCode(),
      customer: user._id,
      customerName: clean(req.body.customerName, 120) || displayName(user),
      email: emailValidation.email,
      phone: clean(req.body.phone, 30) || clean(user.phone, 30),
      category,
      subject,
      message,
      branch,
      source: req.body.source === "mobile" ? "mobile" : "web",
      idempotencyKey,
      timeline: [{
        status: "new",
        note: "Message received from customer.",
        actorId: user._id,
        actorName: displayName(user),
      }],
    });

    const notificationResults = await Promise.allSettled([
      notifyOperationalStaff({
        branch,
        title: `New customer message · ${item.ticketCode}`,
        message: `${item.customerName}: ${categoryLabel(category)} — ${item.subject}`,
        type: "service",
        category: "contact_message",
        targetId: String(item._id),
        targetType: "contact_message",
        dedupeKey: `contact:new:${item._id}`,
      }),
      createDedupedNotification({
        user: user._id,
        type: "service",
        category: "contact_message",
        title: "Your message was received",
        message: `Reference ${item.ticketCode}. Our support team will review it and reply through your notifications.`,
        route: item.source === "mobile" ? "/customer/contact" : "/contact",
        targetId: String(item._id),
        targetType: "contact_message",
        dedupeKey: `contact:received:${item._id}`,
      }),
    ]);
    notificationResults
      .filter((result) => result.status === "rejected")
      .forEach((result) => console.error("Failed to send contact message notification:", result.reason));

    return res.status(201).json({ message: item });
  } catch (error) {
    if (error?.code === 11000) {
      const existing = req.body.idempotencyKey
        ? await ContactMessage.findOne({ customer: req.authUser._id, idempotencyKey: clean(req.body.idempotencyKey, 120) })
        : null;
      if (existing) return res.status(200).json({ message: existing, duplicate: true });
    }
    console.error("Failed to create contact message:", error);
    return res.status(500).json({ message: "Unable to send your message right now." });
  }
};

const staffScope = (req) => {
  if (req.authUser.role === "superadmin") return {};
  const branch = clean(req.activeBranch, 80);
  return branch ? { $or: [{ branch }, { branch: "" }] } : null;
};

const deletedCustomerIds = () => User.distinct("_id", {
  role: "customer",
  $or: [{ isDeleted: true }, { accountStatus: "deleted" }],
});

const listContactMessages = async (req, res) => {
  try {
    const scope = staffScope(req);
    if (!scope) return res.status(403).json({ message: "A valid branch is required to access customer messages." });
    const status = clean(req.query.status, 30);
    const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
    const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 20));
    const base = { scope, deletedCustomerIds: await deletedCustomerIds() };
    const filter = buildOperationalContactFilter({
      ...base,
      status: VALID_STATUSES.has(status) ? status : "",
      search: req.query.search,
    });
    const messages = await ContactMessage.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);
    const [total, all, needsReview, inProgress, resolved, closed] = await Promise.all([
      ContactMessage.countDocuments(filter),
      ContactMessage.countDocuments(buildOperationalContactFilter(base)),
      ...["new", "in_progress", "resolved", "closed"].map((item) =>
        ContactMessage.countDocuments(buildOperationalContactFilter({ ...base, status: item }))),
    ]);
    return res.json({
      messages,
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
      counts: { total: all, new: needsReview, active: inProgress, resolved: resolved + closed },
    });
  } catch (error) {
    console.error("Failed to list contact messages:", error);
    return res.status(500).json({ message: "Unable to load customer messages." });
  }
};

const listMyContactMessages = async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, Number.parseInt(req.query?.limit, 10) || 20));
    const before = String(req.query?.before || "");
    let cursor = null;
    if (before) {
      const [dateText, id] = before.split("|");
      const date = new Date(dateText);
      if (!dateText || Number.isNaN(date.getTime()) || !require("mongoose").isValidObjectId(id)) {
        return res.status(400).json({ message: "Invalid support history cursor." });
      }
      cursor = { date, id };
    }
    const filter = { customer: req.authUser._id };
    if (cursor) filter.$or = [
      { createdAt: { $lt: cursor.date } },
      { createdAt: cursor.date, _id: { $lt: cursor.id } },
    ];
    const rows = await ContactMessage.find(filter)
      .select("ticketCode category subject message branch status adminReply repliedAt createdAt updatedAt timeline")
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1);
    const messages = rows.slice(0, limit);
    const last = messages.at(-1);
    return res.json({ messages, pagination: {
      hasMore: rows.length > limit,
      nextCursor: rows.length > limit && last ? `${new Date(last.createdAt).toISOString()}|${last._id}` : "",
    } });
  } catch (error) {
    console.error("Failed to load customer support history:", error);
    return res.status(500).json({ message: "Unable to load your support messages." });
  }
};

const getMyContactMessage = async (req, res) => {
  try {
    if (!require("mongoose").isValidObjectId(req.params.id)) return res.status(404).json({ message: "Support message not found." });
    const message = await ContactMessage.findOne({ _id: req.params.id, customer: req.authUser._id })
      .select("ticketCode category subject message branch status adminReply repliedAt createdAt updatedAt timeline");
    if (!message) return res.status(404).json({ message: "Support message not found." });
    return res.json({ message });
  } catch (_error) {
    return res.status(500).json({ message: "Unable to load this support message." });
  }
};

const updateContactMessage = async (req, res) => {
  try {
    const scope = staffScope(req);
    if (!scope) return res.status(403).json({ message: "A valid branch is required to access customer messages." });
    const item = await ContactMessage.findOne(buildOperationalContactFilter({
      scope: { _id: req.params.id, ...scope },
      deletedCustomerIds: await deletedCustomerIds(),
    }));
    if (!item) return res.status(404).json({ message: "Customer message not found." });

    const requestedStatus = clean(req.body.status, 30);
    const nextStatus = VALID_STATUSES.has(requestedStatus) ? requestedStatus : item.status;
    const replyProvided = Object.prototype.hasOwnProperty.call(req.body, "adminReply");
    const reply = replyProvided ? clean(req.body.adminReply, 3000) : item.adminReply;
    if (replyProvided && !reply) {
      return res.status(400).json({ message: "Write a reply before sending it to the customer." });
    }

    const actor = displayName(req.authUser);
    const statusChanged = nextStatus !== item.status;
    const replyChanged = replyProvided && reply !== item.adminReply;
    item.status = nextStatus;
    item.adminReply = reply;
    item.updatedBy = req.authUser._id;
    if (replyChanged) item.repliedAt = new Date();
    if (nextStatus === "resolved" || nextStatus === "closed") item.resolvedAt = new Date();
    else item.resolvedAt = null;
    if (statusChanged || replyChanged) {
      item.timeline.push({
        status: nextStatus,
        note: replyChanged ? reply : `Status changed to ${nextStatus.replace(/_/g, " ")}.`,
        actorId: req.authUser._id,
        actorName: actor,
      });
    }
    await item.save();

    if (statusChanged || replyChanged) {
      const customerMessage = replyChanged
        ? `${actor} replied to ${item.ticketCode}: ${reply}`
        : `${item.ticketCode} is now ${nextStatus.replace(/_/g, " ")}.`;
      try {
        await createDedupedNotification({
          user: item.customer,
          type: "service",
          category: "contact_message",
          title: replyChanged ? "Support replied to your message" : "Support message updated",
          message: customerMessage,
          route: item.source === "mobile" ? "/customer/contact" : "/contact",
          targetId: String(item._id),
          targetType: "contact_message",
          dedupeKey: `contact:update:${item._id}:${item.updatedAt.getTime()}`,
        });
      } catch (notificationError) {
        console.error("Failed to notify customer about contact message update:", notificationError);
      }
    }

    return res.json({ message: item });
  } catch (error) {
    console.error("Failed to update contact message:", error);
    return res.status(500).json({ message: "Unable to update this customer message." });
  }
};

module.exports = { createContactMessage, listContactMessages, listMyContactMessages, getMyContactMessage, updateContactMessage };
