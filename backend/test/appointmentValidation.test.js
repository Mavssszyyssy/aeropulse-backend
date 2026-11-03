const test = require("node:test");
const assert = require("node:assert/strict");
const { getScheduledAppointmentError, getServiceAppointmentError, getServiceBookingMaxDateKey } = require("../src/utils/scheduling");

test("appointment validation uses Manila date and rejects expired or malformed slots", () => {
  const now = new Date("2026-10-26T04:00:00.000Z"); // 12:00 in Manila
  assert.match(getScheduledAppointmentError("2026-10-25", "1:00 PM - 2:00 PM", "Service date", now), /past/i);
  assert.match(getScheduledAppointmentError("2026-10-26", "9:00 AM - 11:00 AM", "Service date", now), /passed/i);
  assert.match(getScheduledAppointmentError("2026-10-26", "1:00 PM - 9:00 AM", "Service date", now), /valid appointment/i);
  assert.equal(getScheduledAppointmentError("2026-10-26", "1:00 PM - 2:00 PM", "Service date", now), "");
  assert.equal(getScheduledAppointmentError("2026-10-27", "9:00 AM - 11:00 AM", "Service date", now), "");
});

test("service bookings use inclusive Manila calendar days and reject elapsed times", () => {
  const now = new Date("2026-10-26T04:00:00.000Z");
  assert.equal(getServiceBookingMaxDateKey(now), "2027-01-24");
  assert.equal(getServiceAppointmentError("2026-10-26", "1:00 PM - 2:00 PM", "Service date", now), "");
  assert.equal(getServiceAppointmentError("2027-01-24", "9:00 AM - 11:00 AM", "Service date", now), "");
  assert.match(getServiceAppointmentError("2027-01-25", "9:00 AM - 11:00 AM", "Service date", now), /90 calendar days/);
  assert.match(getServiceAppointmentError("2026-10-25", "1:00 PM - 2:00 PM", "Service date", now), /past/);
  assert.match(getServiceAppointmentError("2026-10-26", "9:00 AM - 11:00 AM", "Service date", now), /passed/);
  assert.equal(getScheduledAppointmentError("2027-01-25", "9:00 AM - 11:00 AM", "Installation date", now), "");
});

test("Manila midnight rolls the booking window by a local calendar day", () => {
  const beforeMidnight = new Date("2026-10-26T15:59:59.000Z");
  const afterMidnight = new Date("2026-10-26T16:00:00.000Z");
  assert.equal(getServiceBookingMaxDateKey(beforeMidnight), "2027-01-24");
  assert.equal(getServiceBookingMaxDateKey(afterMidnight), "2027-01-25");
  assert.match(getServiceAppointmentError("2026-10-26", "11:00 PM - 11:30 PM", "Service date", afterMidnight), /past/);
  assert.equal(getServiceAppointmentError("2027-01-25", "9:00 AM - 11:00 AM", "Service date", afterMidnight), "");
});
