const cleanBranch = (value) => String(value || "").trim();
const sameBranch = (left, right) => cleanBranch(left).localeCompare(cleanBranch(right), undefined, { sensitivity: "accent" }) === 0;

const resolveServiceVisitBranch = ({
  requestBranch,
  taskBranch,
  unitBranch,
  routedBranch,
  inventoryBranch,
  technicianBranch,
} = {}) => {
  const request = cleanBranch(requestBranch);
  const task = cleanBranch(taskBranch);
  const unit = cleanBranch(unitBranch);
  const routed = cleanBranch(routedBranch);
  const inventory = cleanBranch(inventoryBranch);
  const technician = cleanBranch(technicianBranch);

  if (request && task && !sameBranch(request, task)) {
    return {
      branch: request,
      conflict: "The service request and work order are assigned to different branches. Ask an administrator to correct the booking.",
      technicianMismatch: false,
    };
  }

  const bookedBranch = request || task;
  if (bookedBranch && unit && !sameBranch(bookedBranch, unit)) {
    return {
      branch: bookedBranch,
      conflict: "The booked branch and the AC unit's registered service branch do not match. Ask an administrator to correct the assignment.",
      technicianMismatch: false,
    };
  }

  // The branch saved on the current booking/work order is authoritative for
  // this visit. The installed-unit and original inventory branches are only
  // fallbacks for older records that do not have a booking branch.
  const branch = bookedBranch || unit || routed || inventory;
  return {
    branch,
    conflict: "",
    technicianMismatch: Boolean(branch && technician && !sameBranch(branch, technician)),
  };
};

module.exports = { resolveServiceVisitBranch, sameBranch };
