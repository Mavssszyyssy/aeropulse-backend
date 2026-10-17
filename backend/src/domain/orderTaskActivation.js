const ACTIVE_DELIVERY_STATUSES = new Set([
  'dispatched',
  'out for delivery',
  'arrived',
  'installing',
]);

const shouldActivateOrderTask = (order = {}, explicitlyDispatched = false) => {
  if (explicitlyDispatched) return true;
  if (!['to_dispatch', 'to_install'].includes(String(order.workflowStatus || ''))) return false;
  const deliveryStatus = String(order.deliveryStatus || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  if (['failed installation', 'for rescheduling'].includes(deliveryStatus)) return false;
  return ACTIVE_DELIVERY_STATUSES.has(deliveryStatus) || Boolean(order.dispatchedAt);
};

module.exports = { shouldActivateOrderTask };
