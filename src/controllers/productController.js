const Product = require("../models/Product");
const Order = require("../models/Order");
const Unit = require("../models/Unit");
const crypto = require("crypto");
const { BRANCHES } = require("../domain/branchRouting");
const { validateProductUniqueness } = require("../utils/productValidation");

// A licensed stock photo used only when an administrator has not uploaded a
// product image yet. Uploaded product images always take precedence.
const DEFAULT_CATALOG_IMAGE_URL =
  "https://images.pexels.com/photos/16592625/pexels-photo-16592625/free-photo-of-air-conditioner-in-a-house.jpeg?auto=compress&dpr=1&h=750&w=1260";

// Seed items are model families, so each family gets a matching product photo
// instead of every card showing the same generic air-conditioner image.
const CATALOG_IMAGE_BY_SKU_PREFIX = [
  [
    "AHAC-MINV",
    "https://ansons.ph/wp-content/uploads/2024/12/29_AHAC-MINV1023EHW-480x480.jpg",
  ],
  [
    "TAC09-CWI",
    "https://www.kimstore.com/cdn/shop/files/DHMETCL0005.png?v=1757586903&width=1946",
  ],
  [
    "TAC12-CWI",
    "https://www.kimstore.com/cdn/shop/files/DHMETCL0005.png?v=1757586903&width=1946",
  ],
  [
    "TAC18-CWI",
    "https://www.kimstore.com/cdn/shop/files/DHMETCL0005.png?v=1757586903&width=1946",
  ],
  [
    "TAC24-CWI",
    "https://www.kimstore.com/cdn/shop/files/DHMETCL0005.png?v=1757586903&width=1946",
  ],
  [
    "TAC-",
    "https://images.pexels.com/photos/1571453/pexels-photo-1571453.jpeg?auto=compress&dpr=1&h=750&w=1260",
  ],
  [
    "MSCE-",
    "https://web-res.midea.com/content/dam/midea-aem/my/my-new/pdp/air-conditioner/residential/msce-25crfn8-id--msce-25crfn8-od/PD-air-conditioner-residential-MSCE-25CRFN8-ID%20%20MSCE-25CRFN8-OD-EF1-front-close-1040x1040.jpg",
  ],
  [
    "AR",
    "https://dienmayabc.com/media/product/3579_samsung_ar09tyhqasinsv_a_1_org.jpg",
  ],
  [
    "HSN",
    "https://www.lg.com/content/dam/channel/wcms/ph/images/residential-air-conditioners/hsn09ipx_attglcp_eacm_ph_c/gallery/Zoom_01.jpg?w=800",
  ],
  [
    "53CNV",
    "https://images.pexels.com/photos/1571459/pexels-photo-1571459.jpeg?auto=compress&dpr=1&h=750&w=1260",
  ],
  [
    "53CLV",
    "https://images.pexels.com/photos/1571459/pexels-photo-1571459.jpeg?auto=compress&dpr=1&h=750&w=1260",
  ],
];

const getCatalogImage = (item = {}) => {
  const sku = String(item.sku || "").toUpperCase();
  const match = CATALOG_IMAGE_BY_SKU_PREFIX.find(([prefix]) =>
    sku.startsWith(prefix),
  );
  return match?.[1] || DEFAULT_CATALOG_IMAGE_URL;
};

const SAMPLE_PRODUCTS = [
  {
    name: "PayMongo Test AC",
    sku: "TEST-PAYMONGO-001",
    brand: "AeroPulse Test",
    category: "split",
    specs: "Test Unit",
    price: 1,
    threshold: 1,
    stock: 6,
  },
  {
    name: "American Home Inverter AC",
    sku: "AHAC-MINV1023EHW",
    brand: "American Home",
    category: "split",
    specs: "1.0HP",
    price: 18499,
    threshold: 3,
    stock: 16,
  },
  {
    name: "American Home Inverter AC",
    sku: "AHAC-MINV1523EHW",
    brand: "American Home",
    category: "split",
    specs: "1.5HP",
    price: 21999,
    threshold: 3,
    stock: 15,
  },
  {
    name: "American Home Inverter AC",
    sku: "AHAC-MINV2023EHW",
    brand: "American Home",
    category: "split",
    specs: "2.0HP",
    price: 28499,
    threshold: 3,
    stock: 14,
  },
  {
    name: "American Home Inverter AC",
    sku: "AHAC-MINV2523EHW",
    brand: "American Home",
    category: "split",
    specs: "2.5HP",
    price: 31499,
    threshold: 2,
    stock: 12,
  },
  {
    name: "American Home Inverter AC",
    sku: "AHAC-MINV3023EHW",
    brand: "American Home",
    category: "split",
    specs: "3.0HP",
    price: 43999,
    threshold: 2,
    stock: 10,
  },

  {
    name: "TCL Full DC Inverter AC",
    sku: "TAC-10CSD-KEI-S-2",
    brand: "TCL",
    category: "split",
    specs: "1.0HP",
    price: 21500,
    threshold: 3,
    stock: 16,
  },
  {
    name: "TCL Full DC Inverter AC",
    sku: "TAC-13CSD-KEI-S-2",
    brand: "TCL",
    category: "split",
    specs: "1.5HP",
    price: 22500,
    threshold: 3,
    stock: 15,
  },
  {
    name: "TCL Full DC Inverter AC",
    sku: "TAC-19CSD-KEI-S-2",
    brand: "TCL",
    category: "split",
    specs: "2.0HP",
    price: 28700,
    threshold: 3,
    stock: 14,
  },
  {
    name: "TCL Full DC Inverter AC",
    sku: "TAC-25CSD-KEI-S-2",
    brand: "TCL",
    category: "split",
    specs: "2.5HP",
    price: 33600,
    threshold: 2,
    stock: 12,
  },
  {
    name: "TCL Full DC Inverter AC",
    sku: "TAC-30CSD-KEI-S-2",
    brand: "TCL",
    category: "split",
    specs: "3.0HP",
    price: 48999,
    threshold: 2,
    stock: 10,
  },

  {
    name: "Midea Celest Pro AC",
    sku: "MSCE-10CRFN8",
    brand: "Midea",
    category: "split",
    specs: "1.0HP",
    price: 22999,
    threshold: 3,
    stock: 14,
  },
  {
    name: "Midea Celest Pro AC",
    sku: "MSCE-13CRFN8",
    brand: "Midea",
    category: "split",
    specs: "1.5HP",
    price: 23999,
    threshold: 3,
    stock: 14,
  },
  {
    name: "Midea Celest Pro AC",
    sku: "MSCE-19CRFN8",
    brand: "Midea",
    category: "split",
    specs: "2.0HP",
    price: 30499,
    threshold: 3,
    stock: 13,
  },
  {
    name: "Midea Celest Pro AC",
    sku: "MSCE-22CRFN8",
    brand: "Midea",
    category: "split",
    specs: "2.5HP",
    price: 35499,
    threshold: 2,
    stock: 11,
  },
  {
    name: "Midea Celest Pro AC",
    sku: "MSCE-25CRFN8",
    brand: "Midea",
    category: "split",
    specs: "3.0HP",
    price: 51499,
    threshold: 2,
    stock: 9,
  },

  {
    name: "Samsung Digital Inverter AC",
    sku: "AR09TYHYE",
    brand: "Samsung",
    category: "split",
    specs: "1.0HP",
    price: 22999,
    threshold: 2,
    stock: 12,
  },
  {
    name: "Samsung Digital Inverter AC",
    sku: "AR12TYHYE",
    brand: "Samsung",
    category: "split",
    specs: "1.5HP",
    price: 25999,
    threshold: 2,
    stock: 11,
  },
  {
    name: "Samsung Digital Inverter AC",
    sku: "AR18TYHYE",
    brand: "Samsung",
    category: "split",
    specs: "2.0HP",
    price: 30999,
    threshold: 2,
    stock: 10,
  },
  {
    name: "Samsung Digital Inverter AC",
    sku: "AR24TYHYE",
    brand: "Samsung",
    category: "split",
    specs: "2.5HP",
    price: 35999,
    threshold: 2,
    stock: 9,
  },

  {
    name: "LG Premium Dual Inverter AC",
    sku: "HSN09IPX3",
    brand: "LG",
    category: "split",
    specs: "1.0HP",
    price: 31499,
    threshold: 2,
    stock: 11,
  },
  {
    name: "LG Premium Dual Inverter AC",
    sku: "HSN12IPX3",
    brand: "LG",
    category: "split",
    specs: "1.5HP",
    price: 33499,
    threshold: 2,
    stock: 11,
  },
  {
    name: "LG Premium Dual Inverter AC",
    sku: "HSN18IPX3",
    brand: "LG",
    category: "split",
    specs: "2.0HP",
    price: 41499,
    threshold: 2,
    stock: 10,
  },
  {
    name: "LG Premium Dual Inverter AC",
    sku: "HSN24IPX3",
    brand: "LG",
    category: "split",
    specs: "2.5HP",
    price: 46499,
    threshold: 2,
    stock: 9,
  },
  {
    name: "LG Premium Dual Inverter AC",
    sku: "HSN30IPC",
    brand: "LG",
    category: "split",
    specs: "3.0HP",
    price: 82999,
    threshold: 1,
    stock: 7,
  },

  {
    name: "TCL Full DC Inverter Window AC",
    sku: "TAC09-CWI-UJE2",
    brand: "TCL",
    category: "window",
    specs: "1.0HP",
    price: 21995,
    threshold: 2,
    stock: 13,
  },
  {
    name: "TCL Full DC Inverter Window AC",
    sku: "TAC12-CWI-UJE2",
    brand: "TCL",
    category: "window",
    specs: "1.5HP",
    price: 23995,
    threshold: 2,
    stock: 12,
  },
  {
    name: "TCL Full DC Inverter Window AC",
    sku: "TAC18-CWI-UJE2",
    brand: "TCL",
    category: "window",
    specs: "2.0HP",
    price: 31995,
    threshold: 2,
    stock: 10,
  },
  {
    name: "TCL Full DC Inverter Window AC",
    sku: "TAC24-CWI-UJE2",
    brand: "TCL",
    category: "window",
    specs: "2.5HP",
    price: 35995,
    threshold: 2,
    stock: 9,
  },

  {
    name: "Carrier Opus Inverter Floor Mounted",
    sku: "53CNV030WTHP",
    brand: "Carrier",
    category: "floor",
    specs: "3.0HP",
    price: 95000,
    threshold: 1,
    stock: 6,
  },
  {
    name: "Carrier Slim Floor Mounted",
    sku: "53CLV036308",
    brand: "Carrier",
    category: "floor",
    specs: "4.0HP",
    price: 100000,
    threshold: 1,
    stock: 5,
  },
];

let sampleSeedPromise = null;
let sampleSeedDone = false;

const DISTRIBUTION_FALLBACK_STOCK = 6;

const distributeStockToBranches = (total) => {
  const safeTotal = Math.max(0, Number(total) || 0);
  const base = Math.floor(safeTotal / BRANCHES.length);
  let remainder = safeTotal % BRANCHES.length;
  return BRANCHES.reduce((acc, branch) => {
    const next = base + (remainder > 0 ? 1 : 0);
    acc[branch] = next;
    if (remainder > 0) remainder -= 1;
    return acc;
  }, {});
};

const getBranchValue = (branchStock, branch) => {
  if (!branchStock) return 0;
  if (typeof branchStock.get === "function") {
    return Number(branchStock.get(branch) || 0);
  }
  return Number(branchStock?.[branch] || 0);
};

const getBranchTotal = (product) =>
  BRANCHES.reduce(
    (sum, branch) => sum + getBranchValue(product.branchStock, branch),
    0,
  );

const randomSerialToken = () =>
  Math.random().toString(36).slice(2, 8).toUpperCase();

const buildSerialNumber = (product) => {
  const skuPart = String(product?.sku || "AC")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 8)
    .toUpperCase();
  const timePart = Date.now().toString(36).toUpperCase();
  return `CAACT-${skuPart || "AC"}-${timePart}-${randomSerialToken()}`;
};

const buildQrUnitId = () => `QRU-${crypto.randomUUID().replace(/-/g, "").slice(0, 18).toUpperCase()}`;

const buildSerialQrCode = (product, serialNumber, qrUnitId = "") =>
  [
    qrUnitId ? `QR_UNIT:${qrUnitId}` : `AC_UNIT:${serialNumber}`,
    `PRODUCT:${product?._id || product?.id || ""}`,
    `SKU:${product?.sku || ""}`,
    `MODEL:${String(product?.name || "").replace(/[|\r\n]+/g, " ").trim()}`,
  ].join("|");

const normalizeManufacturerSerial = (value = "") =>
  String(value || "").trim().toUpperCase();

const isValidManufacturerSerial = (value = "") =>
  /^[A-Z0-9][A-Z0-9._/-]{3,79}$/.test(value);

const normalizeSerialLookupValue = (value = "") => {
  const raw = String(value || "").trim();
  if (!raw) return "";

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      const serial = String(parsed.serialNumber || parsed.serial || parsed.qrUnitId || parsed.unitId || "").trim();
      if (serial) return serial;
    } catch (_error) {
      // Fall through to tag parsing.
    }
  }

  const urlSerial = raw.match(/[?&](?:serialNumber|serial)=([^&#]+)/i);
  if (urlSerial?.[1]) {
    return decodeURIComponent(urlSerial[1]).trim();
  }

  const pathSerial = raw.match(/\/serial\/([^/?#]+)/i);
  if (pathSerial?.[1]) {
    return decodeURIComponent(pathSerial[1]).trim();
  }

  const acUnitPart = raw
    .split("|")
    .map((part) => part.trim())
    .find((part) => part.toUpperCase().startsWith("AC_UNIT:"));

  if (acUnitPart) {
    return acUnitPart.slice("AC_UNIT:".length).trim();
  }

  const qrUnitPart = raw
    .split("|")
    .map((part) => part.trim())
    .find((part) => part.toUpperCase().startsWith("QR_UNIT:"));

  if (qrUnitPart) {
    return qrUnitPart.slice("QR_UNIT:".length).trim();
  }

  const serialPart = raw
    .split("|")
    .map((part) => part.trim())
    .find((part) => part.toUpperCase().startsWith("SERIAL:"));

  if (serialPart) {
    return serialPart.slice("SERIAL:".length).trim();
  }

  if (raw.toUpperCase().startsWith("AC_UNIT:")) {
    return raw.slice("AC_UNIT:".length).trim();
  }

  if (raw.toUpperCase().startsWith("QR_UNIT:")) {
    return raw.slice("QR_UNIT:".length).trim();
  }

  if (raw.toUpperCase().startsWith("SERIAL:")) {
    return raw.slice("SERIAL:".length).trim();
  }

  return raw;
};

const escapeRegExp = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isOrderOngoing = (status = "") =>
  ["to_pay", "to_deliver", "to_install"].includes(String(status || ""));

const fulfillmentLabel = (state) => {
  switch (state) {
    case "ongoing_order":
      return "Reserved for an ongoing order";
    case "fulfilled_registered_order":
      return "Fulfilled / registered order";
    default:
      return "Available branch stock";
  }
};

const buildOrderSummary = (order, serialNumber) => {
  if (!order) return null;
  const orderJson = order.toJSON();
  const matchedItem = (order.items || []).find((item) =>
    (item.serialNumbers || []).some(
      (serial) =>
        String(serial || "").toLowerCase() ===
        String(serialNumber || "").toLowerCase(),
    ),
  );

  return {
    id: orderJson.id,
    orderCode: order.orderCode,
    workflowStatus: order.workflowStatus,
    status: order.status,
    customerName: order.customerName,
    customerId: String(order.customer || ""),
    stockSourceBranch: order.stockSourceBranch || "",
    installationDate: order.installationDate || "",
    estimatedDelivery: order.estimatedDelivery || "",
    item: matchedItem
      ? {
          name: matchedItem.name,
          specs: matchedItem.specs || "",
          quantity: matchedItem.quantity,
        }
      : null,
  };
};

const resolveSerialOrderFulfillment = async (serialUnit, serialNumber) => {
  const conditions = [{ "items.serialNumbers": serialNumber }];
  if (serialUnit.assignedOrderCode) {
    conditions.push({ orderCode: serialUnit.assignedOrderCode });
  }

  const order = await Order.findOne({ $or: conditions })
    .sort({ createdAt: -1 })
    .select(
      "orderCode customer customerName items workflowStatus status stockSourceBranch installationDate estimatedDelivery createdAt",
    );

  if (order && isOrderOngoing(order.workflowStatus)) {
    return {
      state: "ongoing_order",
      label: fulfillmentLabel("ongoing_order"),
      isAvailableStock: false,
      isOrderLinked: true,
      isRegistered: false,
      order: buildOrderSummary(order, serialNumber),
    };
  }

  if (
    order?.workflowStatus === "complete" ||
    serialUnit.status === "sold" ||
    serialUnit.registeredAt
  ) {
    return {
      state: "fulfilled_registered_order",
      label: fulfillmentLabel("fulfilled_registered_order"),
      isAvailableStock: false,
      isOrderLinked: Boolean(order),
      isRegistered: true,
      registeredAt: serialUnit.registeredAt || "",
      ampRegistration: serialUnit.ampRegistration || null,
      defectHold: serialUnit.defectHold || null,
      order: buildOrderSummary(order, serialNumber),
    };
  }

  return {
    state: "available_stock",
    label: fulfillmentLabel("available_stock"),
    isAvailableStock: true,
    isOrderLinked: false,
    isRegistered: false,
    order: null,
  };
};

const getDesiredSerialBranches = (product, targetCount) => {
  const branchEntries = BRANCHES.flatMap((branch) =>
    Array.from(
      { length: Math.max(0, getBranchValue(product.branchStock, branch)) },
      () => branch,
    ),
  );

  if (branchEntries.length > 0) {
    return [
      ...branchEntries.slice(0, targetCount),
      ...Array.from(
        { length: Math.max(0, targetCount - branchEntries.length) },
        () => "",
      ),
    ];
  }

  return Array.from({ length: targetCount }, () => "");
};

const generateUniqueSerialNumber = async (product, seen, queryOptions = {}) => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const serialNumber = buildSerialNumber(product);
    if (seen.has(serialNumber)) continue;
    const existsQuery = Product.exists({
      "serialUnits.serialNumber": serialNumber,
    });
    if (queryOptions.session) existsQuery.session(queryOptions.session);
    const exists = await existsQuery;
    if (!exists) {
      seen.add(serialNumber);
      return serialNumber;
    }
  }
  throw new Error("Unable to generate a unique serial number");
};

const ensureProductSerialUnits = async (product, targetCount = null, saveOptions = {}) => {
  const desiredCount = Math.max(
    0,
    Math.floor(
      targetCount === null
        ? Math.max(getBranchTotal(product), Number(product.stock) || 0)
        : Number(targetCount) || 0,
    ),
  );

  if (!Array.isArray(product.serialUnits)) {
    product.serialUnits = [];
  }

  const desiredBranches = getDesiredSerialBranches(product, desiredCount);
  const availableBranchCounts = BRANCHES.reduce((acc, branch) => {
    acc[branch] = 0;
    return acc;
  }, {});
  const desiredBranchCounts = BRANCHES.reduce((acc, branch) => {
    acc[branch] = desiredBranches.filter((item) => item === branch).length;
    return acc;
  }, {});
  const desiredBlankCount = desiredBranches.filter((item) => !item).length;
  let availableBlankCount = 0;
  const seen = new Set();
  let changed = false;

  product.serialUnits.forEach((unit, index) => {
    if (!unit.serialNumber) return;
    seen.add(unit.serialNumber);
    if (!unit.qrUnitId) {
      unit.qrUnitId = buildQrUnitId();
      changed = true;
    }
    const stableQrCode = buildSerialQrCode(product, unit.serialNumber, unit.qrUnitId);
    if (unit.qrCode !== stableQrCode) {
      unit.qrCode = stableQrCode;
      changed = true;
    }
    if (!unit.serialKind) {
      unit.serialKind = "generated";
      changed = true;
    }
    const isAvailable = (unit.status || "available") === "available";
    if (!unit.branch && isAvailable && desiredBranches[index]) {
      unit.branch = desiredBranches[index];
      changed = true;
    }
    // Sold and assigned serials remain as a permanent audit/warranty record,
    // but must never satisfy the count of QR labels for stock that is currently
    // available to sell in a branch.
    if (isAvailable && BRANCHES.includes(unit.branch)) {
      availableBranchCounts[unit.branch] =
        (availableBranchCounts[unit.branch] || 0) + 1;
    } else if (isAvailable) {
      availableBlankCount += 1;
    }
  });

  const addAvailableSerial = async (branch = "") => {
    const serialNumber = await generateUniqueSerialNumber(product, seen, saveOptions);
    product.serialUnits.push({
      qrUnitId: buildQrUnitId(),
      serialNumber,
      serialKind: "generated",
      qrCode: "",
      branch,
      status: "available",
    });
    const added = product.serialUnits[product.serialUnits.length - 1];
    added.qrCode = buildSerialQrCode(product, serialNumber, added.qrUnitId);
    changed = true;
  };

  for (const branch of BRANCHES) {
    while (availableBranchCounts[branch] < desiredBranchCounts[branch]) {
      await addAvailableSerial(branch);
      availableBranchCounts[branch] += 1;
    }
  }
  while (availableBlankCount < desiredBlankCount) {
    await addAvailableSerial();
    availableBlankCount += 1;
  }

  if (changed && !saveOptions.deferSave) {
    await product.save(saveOptions);
  }

  return changed;
};

const ensureSerialUnitsForProducts = async (products) => {
  await Promise.all(
    products.map((product) => ensureProductSerialUnits(product)),
  );
};

const applyBranchStock = (product, stockByBranch) => {
  BRANCHES.forEach((branch) => {
    const value = Math.max(0, Number(stockByBranch?.[branch] || 0));
    product.branchStock.set(branch, value);
  });
  product.stock = BRANCHES.reduce(
    (sum, branch) => sum + Number(product.branchStock?.get(branch) || 0),
    0,
  );
};

const createSampleDoc = (item) => {
  const branchStock = distributeStockToBranches(item.stock);
  const total = Object.values(branchStock).reduce(
    (sum, value) => sum + Number(value || 0),
    0,
  );
  return {
    ...item,
    image: item.image || getCatalogImage(item),
    stock: total,
    branchStock,
    serialUnits: [],
    features: [],
  };
};

const ensureSampleInventory = async () => {
  if (sampleSeedDone) {
    return;
  }
  if (sampleSeedPromise) {
    return sampleSeedPromise;
  }

  sampleSeedPromise = (async () => {
    const sampleBySku = new Map(
      SAMPLE_PRODUCTS.map((item) => [item.sku, item]),
    );
    const existingSamples = await Product.find({
      sku: { $in: Array.from(sampleBySku.keys()) },
    });
    const existingBySku = new Map(
      existingSamples.map((product) => [product.sku, product]),
    );

    const docsToInsert = [];
    for (const item of SAMPLE_PRODUCTS) {
      const existing = existingBySku.get(item.sku);
      if (!existing) {
        docsToInsert.push(createSampleDoc(item));
        continue;
      }

      let touched = false;
      if (!existing.specs && item.specs) {
        existing.specs = item.specs;
        touched = true;
      }
      if (!existing.brand && item.brand) {
        existing.brand = item.brand;
        touched = true;
      }
      if (!existing.category && item.category) {
        existing.category = item.category;
        touched = true;
      }
      const catalogImage = item.image || getCatalogImage(item);
      if (!existing.image || existing.image === DEFAULT_CATALOG_IMAGE_URL) {
        existing.image = catalogImage;
        touched = true;
      }
      if ((Number(existing.price) || 0) <= 0 && Number(item.price) > 0) {
        existing.price = Number(item.price);
        touched = true;
      }
      if (
        (Number(existing.threshold) || 0) <= 0 &&
        Number(item.threshold) > 0
      ) {
        existing.threshold = Number(item.threshold);
        touched = true;
      }

      if (touched) {
        await existing.save();
      }
    }

    if (docsToInsert.length > 0) {
      await Product.insertMany(docsToInsert, { ordered: false });
    }

    const seededSamples = await Product.find({
      sku: { $in: Array.from(sampleBySku.keys()) },
    });
    await ensureSerialUnitsForProducts(seededSamples);

    sampleSeedDone = true;
  })().finally(() => {
    sampleSeedPromise = null;
  });

  return sampleSeedPromise;
};

const toBranchStockObject = (product) =>
  BRANCHES.reduce((acc, branch) => {
    acc[branch] = Number(product.branchStock?.get(branch) || 0);
    return acc;
  }, {});

const toRoleAwareProduct = (product, req) => {
  const base = product.toJSON();
  const branchStock = toBranchStockObject(product);
  if (req.authUser.role === "superadmin" || req.authUser.role === "technician") {
    return { ...base, branchStock };
  }
  const requestedBranch = String(req.query?.branch || "").trim();
  // Admins can monitor another branch, but remain read-only. Stock-changing routes
  // still use the authenticated account's active branch and require SuperAdmin.
  const branch =
    req.authUser.role === "admin" && BRANCHES.includes(requestedBranch)
      ? requestedBranch
      : req.activeBranch;
  return {
    ...base,
    activeBranch: branch,
    stock: Number(branchStock[branch] || 0),
    branchStock: { [branch]: Number(branchStock[branch] || 0) },
    serialUnits: (base.serialUnits || []).filter(
      (unit) => !unit.branch || unit.branch === branch,
    ),
  };
};

const requireAdmin = (req, res) => {
  if (req.authUser.role !== "admin" && req.authUser.role !== "superadmin") {
    res.status(403).json({ message: "Forbidden" });
    return false;
  }
  return true;
};

const requireInventoryOwner = (req, res) => {
  if (req.authUser.role !== "superadmin") {
    res.status(403).json({ message: "Inventory changes are managed by SuperAdmin. Admin access is read-only." });
    return false;
  }
  return true;
};

const listProducts = async (req, res) => {
  res.set("Cache-Control", "no-store");
  await ensureSampleInventory();
  const products = await Product.find({})
    .select("-imageData")
    .sort({ createdAt: -1 });
  await ensureSerialUnitsForProducts(products);
  return res.json({
    products: products.map((p) => toRoleAwareProduct(p, req)),
  });
};

const listPublicProducts = async (req, res) => {
  // Inventory must never be served from a stale CDN/browser response. Stock
  // is reserved atomically by order creation, and clients always re-read this
  // endpoint before checkout.
  res.set("Cache-Control", "no-store");
  await ensureSampleInventory();
  const requestedBranch = String(req.query?.branch || "").trim();
  const scopedBranch = BRANCHES.includes(requestedBranch) ? requestedBranch : "";
  const products = await Product.find({ stock: { $gt: 0 } })
    .select("-imageData")
    .sort({
      createdAt: -1,
    });
  const publicProducts = products.map((product) => {
    const base = product.toJSON();
    const branchStock = toBranchStockObject(product);
    const totalStock = Number(product.stock || 0);

    // A customer shop can ask for its delivery branch. In that case `stock`
    // is deliberately branch-specific, matching what the branch inventory
    // screen shows. Without a branch, retain total stock but label the scope
    // clearly so clients never present it as a single branch quantity.
    return {
      ...base,
      stock: scopedBranch ? Number(branchStock[scopedBranch] || 0) : totalStock,
      totalStock,
      branchStock,
      inventoryBranch: scopedBranch || null,
      stockScope: scopedBranch ? "branch" : "all_branches",
    };
  });

  return res.json({ products: publicProducts });
};

const listLowStockProducts = async (req, res) => {
  const products = await Product.find({
    threshold: { $gt: 0 },
  }).sort({ stock: 1, createdAt: -1 });
  const roleAware = products.map((p) => toRoleAwareProduct(p, req));
  const lowStock = roleAware.filter(
    (p) => Number(p.stock || 0) < Number(p.threshold || 0),
  );
  return res.json({ products: lowStock });
};

const createProduct = async (req, res) => {
  if (!requireInventoryOwner(req, res)) return null;

  const {
    name,
    sku,
    brand = "",
    category = "split",
    specs = "",
    features = [],
    stock = 0,
    threshold = 0,
    price = 0,
    branchStock = {},
  } = req.body || {};

  if (!name || !sku) {
    return res.status(400).json({
      message: "Name and SKU are required",
      fields: { name: "required", sku: "required" },
    });
  }

  // Validate uniqueness before processing
  const uniquenessCheck = await validateProductUniqueness({
    name: name.trim(),
    sku: String(sku).trim(),
    specs: String(specs || "").trim(),
  });

  if (uniquenessCheck.isDuplicate) {
    const errorMessage =
      uniquenessCheck.duplicateType === "sku"
        ? "A product with this SKU already exists"
        : "A product with this name and specs combination already exists";

    return res.status(409).json({
      message: errorMessage,
      field: uniquenessCheck.duplicateType === "sku" ? "sku" : "name",
      duplicateType: uniquenessCheck.duplicateType,
      existingProduct: uniquenessCheck.existingProduct,
    });
  }

  const normalizedBranchStock = BRANCHES.reduce((acc, branch) => {
    const value = Number(branchStock?.[branch]) || 0;
    acc[branch] = Math.max(0, value);
    return acc;
  }, {});

  if (req.authUser.role !== "superadmin") {
    const scoped = req.activeBranch;
    BRANCHES.forEach((branch) => {
      if (branch !== scoped) normalizedBranchStock[branch] = 0;
    });
  }
  const totalStock = Object.values(normalizedBranchStock).reduce(
    (sum, value) => sum + value,
    0,
  );

  try {
    const product = await Product.create({
      name: name.trim(),
      sku: String(sku).trim(),
      brand: String(brand).trim(),
      category,
      specs: String(specs || "").trim(),
      features: Array.isArray(features) ? features.filter(Boolean) : [],
      stock: totalStock || Number(stock) || 0,
      branchStock: normalizedBranchStock,
      threshold: Number(threshold) || 0,
      price: Number(price) || 0,
    });
    await ensureProductSerialUnits(product);
    return res.status(201).json({ product: product.toJSON() });
  } catch (e) {
    // Handle database-level unique constraint violations
    if (e?.code === 11000) {
      const field = Object.keys(e.keyPattern || {})[0] || "unknown";
      const isDuplicateSku = field === "sku";

      return res.status(409).json({
        message: isDuplicateSku
          ? "A product with this SKU already exists"
          : "A product with this name and specs combination already exists",
        field: isDuplicateSku ? "sku" : "name",
        code: "E_DUPLICATE_PRODUCT",
      });
    }

    // Handle validation errors
    if (e.name === "ValidationError") {
      return res.status(400).json({
        message: "Product validation failed",
        errors: Object.entries(e.errors).reduce((acc, [key, val]) => {
          acc[key] = val.message;
          return acc;
        }, {}),
      });
    }

    throw e;
  }
};

const restockProduct = async (req, res) => {
  if (!requireInventoryOwner(req, res)) return null;

  const { productId } = req.params;
  const { quantity = 0, branch, features } = req.body || {};

  const product = await Product.findById(productId);
  if (!product) {
    return res.status(404).json({ message: "Product not found" });
  }

  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return res
      .status(400)
      .json({ message: "quantity must be a positive number" });
  }

  if (req.authUser.role !== "superadmin") {
    const scopedBranch = req.activeBranch;
    const current = Number(product.branchStock?.get(scopedBranch) || 0);
    product.branchStock.set(scopedBranch, current + qty);
  } else if (branch && BRANCHES.includes(branch)) {
    const current = Number(product.branchStock?.get(branch) || 0);
    product.branchStock.set(branch, current + qty);
  } else {
    BRANCHES.forEach((name) => {
      const current = Number(product.branchStock?.get(name) || 0);
      product.branchStock.set(name, current + qty);
    });
  }

  if (Array.isArray(features)) {
    product.features = features.filter(Boolean);
  }

  const summedStock = BRANCHES.reduce(
    (sum, name) => sum + Number(product.branchStock?.get(name) || 0),
    0,
  );
  product.stock = summedStock;
  await ensureProductSerialUnits(product, summedStock);
  await product.save();

  return res.json({ product: toRoleAwareProduct(product, req) });
};

const updateBranchStock = async (req, res) => {
  if (!requireInventoryOwner(req, res)) return null;

  const { productId } = req.params;
  const { branch, action = "set", quantity = 0 } = req.body || {};

  const product = await Product.findById(productId);
  if (!product) {
    return res.status(404).json({ message: "Product not found" });
  }

  const scopedBranch = branch;
  if (!scopedBranch || !BRANCHES.includes(scopedBranch)) {
    return res.status(400).json({ message: "A valid branch is required" });
  }

  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return res
      .status(400)
      .json({ message: "quantity must be a positive number" });
  }

  if (action !== "add") {
    return res
      .status(400)
      .json({ message: "Only stock additions are allowed. Use action=add." });
  }

  const current = Number(product.branchStock?.get(scopedBranch) || 0);
  const next = current + qty;
  product.branchStock.set(scopedBranch, next);
  const summedStock = BRANCHES.reduce(
    (sum, name) => sum + Number(product.branchStock?.get(name) || 0),
    0,
  );
  product.stock = summedStock;
  await ensureProductSerialUnits(product, summedStock);
  await product.save();

  return res.json({ product: toRoleAwareProduct(product, req) });
};

const getProductSerialUnit = async (req, res) => {
  const { serialNumber } = req.params;
  const normalizedSerial = normalizeSerialLookupValue(serialNumber);

  if (!normalizedSerial) {
    return res.status(400).json({ message: "Serial number is required" });
  }

  await ensureSampleInventory();

  const serialRegex = new RegExp(`^${escapeRegExp(normalizedSerial)}$`, "i");
  const product = await Product.findOne({
    serialUnits: { $elemMatch: { $or: [
      { serialNumber: serialRegex },
      { qrUnitId: serialRegex },
      { serialAliases: serialRegex },
    ] } },
  }).select("-imageData");

  if (!product) {
    return res.status(404).json({ message: "AC unit serial not found" });
  }

  await ensureProductSerialUnits(product);

  const serialUnit = (product.serialUnits || []).find(
    (unit) => [unit.serialNumber, unit.qrUnitId, ...(unit.serialAliases || [])]
      .some((value) => String(value || "").toLowerCase() === normalizedSerial.toLowerCase()),
  );

  if (!serialUnit) {
    return res.status(404).json({ message: "AC unit serial not found" });
  }

  const productJson = product.toJSON();
  const model = [product.specs, product.sku].filter(Boolean).join(" / ");
  const orderFulfillment = await resolveSerialOrderFulfillment(
    serialUnit,
    serialUnit.serialNumber,
  );

  return res.json({
    unit: {
      id: serialUnit.qrUnitId || serialUnit.serialNumber,
      qrUnitId: serialUnit.qrUnitId || "",
      unitName: [product.name, product.specs].filter(Boolean).join(" "),
      brand: product.brand || "",
      model: model || product.sku || "",
      serialNumber: serialUnit.serialNumber,
      serialKind: serialUnit.serialKind || "generated",
      status: serialUnit.status || "available",
      inventoryStatus: serialUnit.status || "available",
      orderFulfillmentStatus: orderFulfillment.state,
      orderFulfillmentLabel: orderFulfillment.label,
      orderFulfillment,
      placementArea: serialUnit.branch
        ? `${serialUnit.branch} branch inventory`
        : "Inventory",
      installationDate: "",
      lastMaintenanceDate: "",
      productId: productJson.id,
      productSku: product.sku,
      productName: product.name,
      category: product.category,
      price: product.price,
      registeredAt: serialUnit.registeredAt || "",
      ampRegistration: serialUnit.ampRegistration || null,
      defectHold: serialUnit.defectHold || null,
      qrCode: serialUnit.qrCode || buildSerialQrCode(product, serialUnit.serialNumber, serialUnit.qrUnitId),
    },
    product: productJson,
  });
};

const updateProductSerialUnit = async (req, res) => {
  if (!requireInventoryOwner(req, res)) return null;

  const product = await Product.findById(req.params.productId);
  if (!product) return res.status(404).json({ message: "Product not found" });

  const currentSerial = normalizeSerialLookupValue(req.params.serialNumber);
  const serialUnit = (product.serialUnits || []).find(
    (unit) => String(unit.serialNumber || "").toLowerCase() === currentSerial.toLowerCase(),
  );
  if (!serialUnit) {
    return res.status(404).json({ message: "Inventory unit serial not found" });
  }
  if ((serialUnit.status || "available") !== "available") {
    return res.status(409).json({
      message: "Only an available inventory unit can be assigned a manufacturer serial number.",
    });
  }

  const serialNumber = normalizeManufacturerSerial(req.body?.serialNumber);
  if (!isValidManufacturerSerial(serialNumber)) {
    return res.status(400).json({
      message: "Enter a manufacturer serial using 4-80 letters, numbers, dots, dashes, slashes, or underscores.",
    });
  }

  const serialRegex = new RegExp(`^${escapeRegExp(serialNumber)}$`, "i");
  const [duplicate, installedDuplicate] = await Promise.all([
    Product.exists({
      _id: { $ne: product._id },
      $or: [
        { "serialUnits.serialNumber": serialRegex },
        { "serialUnits.serialAliases": serialRegex },
      ],
    }),
    Unit.exists({ serialNumber: serialRegex }),
  ]);
  const duplicateOnProduct = (product.serialUnits || []).some(
    (unit) =>
      unit !== serialUnit &&
      String(unit.serialNumber || "").toLowerCase() === serialNumber.toLowerCase(),
  );
  if (duplicate || installedDuplicate || duplicateOnProduct) {
    return res.status(409).json({ message: "That serial number is already registered to another AC unit." });
  }

  const previousSerial = String(serialUnit.serialNumber || "").trim();
  serialUnit.serialAliases = Array.from(new Set([
    ...(serialUnit.serialAliases || []),
    previousSerial,
  ].filter(Boolean)));
  serialUnit.qrUnitId = serialUnit.qrUnitId || buildQrUnitId();
  serialUnit.serialNumber = serialNumber;
  serialUnit.serialKind = "manufacturer";
  // The QR Unit ID stays the same while the displayed serial changes. An old
  // printed serial QR remains valid through serialAliases.
  serialUnit.qrCode = buildSerialQrCode(product, serialNumber, serialUnit.qrUnitId);
  await product.save();
  return res.json({ product: toRoleAwareProduct(product, req), serialUnit });
};

const updateProduct = async (req, res) => {
  if (!requireInventoryOwner(req, res)) return null;

  const { productId } = req.params;
  const product = await Product.findById(productId);
  if (!product) {
    return res.status(404).json({ message: "Product not found" });
  }

  const { name, brand, category, specs, features, threshold, price } =
    req.body || {};

  // If updating name or specs, validate uniqueness
  if (name !== undefined || specs !== undefined) {
    const newName = name !== undefined ? String(name).trim() : product.name;
    const newSpecs = specs !== undefined ? String(specs).trim() : product.specs;

    // Only check if values are actually changing
    if (
      newName.toLowerCase() !== String(product.name).trim().toLowerCase() ||
      newSpecs.toLowerCase() !== String(product.specs).trim().toLowerCase()
    ) {
      const uniquenessCheck = await validateProductUniqueness(
        {
          name: newName,
          sku: product.sku,
          specs: newSpecs,
        },
        productId,
      );

      if (uniquenessCheck.isDuplicate) {
        const errorMessage =
          uniquenessCheck.duplicateType === "sku"
            ? "A product with this SKU already exists"
            : "A product with this name and specs combination already exists";

        return res.status(409).json({
          message: errorMessage,
          field: uniquenessCheck.duplicateType === "sku" ? "sku" : "name",
          duplicateType: uniquenessCheck.duplicateType,
          existingProduct: uniquenessCheck.existingProduct,
        });
      }
    }
  }

  if (name !== undefined) product.name = String(name).trim();
  if (brand !== undefined) product.brand = String(brand).trim();
  if (category !== undefined) product.category = String(category).trim();
  if (specs !== undefined) product.specs = String(specs).trim();
  if (Array.isArray(features)) product.features = features.filter(Boolean);
  if (threshold !== undefined)
    product.threshold = Math.max(0, Number(threshold) || 0);
  if (price !== undefined) product.price = Math.max(0, Number(price) || 0);

  try {
    await product.save();
    return res.json({ product: toRoleAwareProduct(product, req) });
  } catch (e) {
    // Handle database-level unique constraint violations
    if (e?.code === 11000) {
      const field = Object.keys(e.keyPattern || {})[0] || "unknown";
      const isDuplicateSku = field === "sku";

      return res.status(409).json({
        message: isDuplicateSku
          ? "A product with this SKU already exists"
          : "A product with this name and specs combination already exists",
        field: isDuplicateSku ? "sku" : "name",
        code: "E_DUPLICATE_PRODUCT",
      });
    }

    // Handle validation errors
    if (e.name === "ValidationError") {
      return res.status(400).json({
        message: "Product validation failed",
        errors: Object.entries(e.errors).reduce((acc, [key, val]) => {
          acc[key] = val.message;
          return acc;
        }, {}),
      });
    }

    throw e;
  }
};

const deleteProduct = async (req, res) => {
  if (!requireInventoryOwner(req, res)) return null;

  const { productId } = req.params;
  const product = await Product.findById(productId);
  if (!product) {
    return res.status(404).json({ message: "Product not found" });
  }

  await product.deleteOne();
  return res.json({ message: "Product deleted successfully" });
};

const getProductImage = async (req, res) => {
  const { productId } = req.params;
  try {
    const product = await Product.findById(productId);
    if (!product || !product.imageData) {
      return res.status(404).json({ message: "Image not found" });
    }
    res.set("Content-Type", product.imageContentType || "image/jpeg");
    return res.send(product.imageData);
  } catch (error) {
    return res.status(500).json({ message: "Internal server error" });
  }
};

module.exports = {
  ensureSampleInventory,
  listProducts,
  listPublicProducts,
  listLowStockProducts,
  getProductImage,
  getProductSerialUnit,
  updateProductSerialUnit,
  createProduct,
  restockProduct,
  updateBranchStock,
  updateProduct,
  deleteProduct,
};
