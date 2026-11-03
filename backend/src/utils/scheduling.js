const getManilaDateKey = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const addCalendarDays = (dateKey, days) => {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};
const getServiceBookingMaxDateKey = (now = new Date()) => addCalendarDays(getManilaDateKey(now), 90);

const getScheduledDateError = (value, label = "Scheduled date", now = new Date(), { maxCalendarDays } = {}) => {
  const date = String(value || "").trim();
  if (!date || date.toLowerCase() === "tbd") return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return `${label} must use a valid calendar date.`;
  }

  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  const normalized = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
  if (normalized !== date) return `${label} must use a valid calendar date.`;
  if (date < getManilaDateKey(now)) return `${label} cannot be in the past.`;
  if (Number.isInteger(maxCalendarDays) && date > addCalendarDays(getManilaDateKey(now), maxCalendarDays)) {
    return `${label} must be within ${maxCalendarDays} calendar days from today.`;
  }
  return "";
};

const getScheduledAppointmentError = (date, slot, label = "Scheduled date", now = new Date(), options = {}) => {
  const dateError = getScheduledDateError(date, label, now, options);
  if (dateError) return dateError;
  const normalizedSlot = String(slot || "").trim();
  if (!date || !normalizedSlot || normalizedSlot.toLowerCase() === "tbd") return "";
  const { parseTimeSlot } = require("../domain/taskScheduleConflict");
  const window = parseTimeSlot(normalizedSlot);
  if (!window) return "Choose a valid appointment time range with an end after the start.";
  if (String(date) !== getManilaDateKey(now)) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
  if (window.end <= hour * 60 + minute) return `${label} time slot has already passed.`;
  return "";
};

const getServiceDateError = (value, label = "Service date", now = new Date()) =>
  getScheduledDateError(value, label, now, { maxCalendarDays: 90 });
const getServiceAppointmentError = (date, slot, label = "Service date", now = new Date()) =>
  getScheduledAppointmentError(date, slot, label, now, { maxCalendarDays: 90 });

module.exports = { getManilaDateKey, getServiceBookingMaxDateKey, getScheduledDateError, getScheduledAppointmentError, getServiceDateError, getServiceAppointmentError };
