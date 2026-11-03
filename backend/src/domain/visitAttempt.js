const { hasVerifiedTaskCheckIn } = require('./taskWorkflow');
const { getScheduledAppointmentError, getServiceAppointmentError } = require('../utils/scheduling');

const awaitingVisitFollowUp = task => Boolean(task?.payload?.visitAttempt?.awaitingAdmin);
const FOLLOW_UP_REQUIRED = 'This visit is closed. Admin must confirm the next visit using Visit follow-up before work can continue.';
const VISIT_TIME_SLOTS = ['8:00 AM – 10:00 AM', '10:00 AM – 12:00 PM', '1:00 PM – 3:00 PM', '3:00 PM – 5:00 PM', '9:00 AM - 12:00 PM', '1:00 PM - 4:00 PM', '4:00 PM - 6:00 PM'];

function visitAttemptError(task, input = {}) {
  if (awaitingVisitFollowUp(task)) return FOLLOW_UP_REQUIRED;
  if (task?.status !== 'in-progress' || !hasVerifiedTaskCheckIn(task)) return 'Record your GPS arrival before reporting an unattended visit.';
  if (input.checkedInAt !== task.payload.checkIn.checkedInAt) return 'This arrival record changed. Reopen the work order before submitting a visit attempt.';
  if (!['close', 'reschedule'].includes(input.outcome)) return 'Choose Close visit or Request reschedule.';
  if (typeof input.note !== 'string' || !input.note.trim() || input.note.trim().length > 500) return 'Enter a short visit note (up to 500 characters).';
  const uri = input.photo?.uri;
  if (typeof uri !== 'string' || uri.length > 3_200_000 || !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+={0,2}$/.test(uri)) return 'Capture a valid proof photo before submitting the visit.';
  return '';
}

function nextVisitError(input = {}, { service = false, now = new Date() } = {}) {
  if (!input.scheduledDate || input.scheduledDate === 'TBD') return 'Choose the next visit date.';
  if (!VISIT_TIME_SLOTS.includes(input.timeSlot)) return 'Choose a valid time slot.';
  return (service ? getServiceAppointmentError : getScheduledAppointmentError)(input.scheduledDate, input.timeSlot, 'Next visit date', now);
}

module.exports = { awaitingVisitFollowUp, FOLLOW_UP_REQUIRED, VISIT_TIME_SLOTS, visitAttemptError, nextVisitError };
