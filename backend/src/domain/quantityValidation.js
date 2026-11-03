const parsePositiveWholeQuantity = (value) => {
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
};

const parseNonnegativeWholeQuantity = (value) => {
  if (value === 0 || value === "0") return 0;
  return parsePositiveWholeQuantity(value);
};

module.exports = { parsePositiveWholeQuantity, parseNonnegativeWholeQuantity };
