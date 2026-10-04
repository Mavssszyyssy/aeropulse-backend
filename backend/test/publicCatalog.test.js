const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isCustomerCatalogProduct,
  toPublicProduct,
  toRoleAwareProduct,
} = require("../src/controllers/productController");
const { isNonRetailCatalogProduct } = require("../src/domain/catalogVisibility");

const product = {
  _id: "product-1",
  name: "Inverter Split Type",
  sku: "AC-100",
  brand: "Cold Air",
  category: "split",
  description: "Efficient cooling",
  specs: "1.0HP",
  features: ["Inverter"],
  image: "https://example.invalid/ac.jpg",
  price: 20000,
  stock: 5,
  branchStock: new Map([["Cavite", 2], ["Bulacan", 3]]),
  serialUnits: [{ serialNumber: "PRIVATE-SERIAL", qrUnitId: "PRIVATE-QR" }],
};

test("public catalog exposes only ecommerce-safe product fields", () => {
  const result = toPublicProduct(product);
  assert.equal(result.stock, 5);
  assert.equal(result.stockScope, "all_branches");
  assert.equal("serialUnits" in result, false);
  assert.equal("branchStock" in result, false);
  assert.equal("qrCode" in result, false);
});

test("branch-scoped catalog reports only the selected branch quantity", () => {
  const result = toPublicProduct(product, "Cavite");
  assert.equal(result.stock, 2);
  assert.equal(result.totalStock, 5);
  assert.equal(result.inventoryBranch, "Cavite");
});

test("branch Admin inventory can monitor another requested branch", () => {
  const roleAwareProduct = {
    ...product,
    serialUnits: [
      { serialNumber: "CAVITE-SERIAL", branch: "Cavite" },
      { serialNumber: "BULACAN-SERIAL", branch: "Bulacan" },
    ],
    toJSON() {
      return { ...this };
    },
  };
  const result = toRoleAwareProduct(roleAwareProduct, {
    authUser: { role: "admin" },
    activeBranch: "Cavite",
    query: { branch: "Bulacan" },
  });

  assert.equal(result.activeBranch, "Bulacan");
  assert.equal(result.stock, 3);
  assert.deepEqual(result.branchStock, { Bulacan: 3 });
  assert.deepEqual(result.serialUnits, [
    { serialNumber: "BULACAN-SERIAL", branch: "Bulacan" },
  ]);
});

test("known seeded models use their verified storefront image", () => {
  const result = toPublicProduct({
    ...product,
    sku: "53CNV030WTHP",
    image: "https://images.pexels.com/old-room-photo.jpg",
  });
  assert.equal(
    result.image,
    "https://www.coldair-act.online/catalog/ac/carrier-opus-53cnv.jpg",
  );
});

test("unknown products keep their uploaded catalog image", () => {
  const result = toPublicProduct(product);
  assert.equal(result.image, "https://example.invalid/ac.jpg");
});

test("customer catalog excludes test, demo, QA, and E2E inventory", () => {
  assert.equal(isCustomerCatalogProduct(product), true);
  assert.equal(isCustomerCatalogProduct({ ...product, name: "Installed Unit E2E 123" }), false);
  assert.equal(isCustomerCatalogProduct({ ...product, sku: "TEST-PAYMENT-001" }), false);
  assert.equal(isCustomerCatalogProduct({ ...product, brand: "AeroPulse QA" }), false);
  assert.equal(isCustomerCatalogProduct({ ...product, name: "Demo Window Unit" }), false);
  assert.equal(isNonRetailCatalogProduct({ ...product, brand: "AeroPulse QA" }), true);
  assert.equal(isNonRetailCatalogProduct(product), false);
});

test("authenticated inventory uses the same non-retail marker for internal QR lists", () => {
  assert.equal(isNonRetailCatalogProduct({ ...product, sku: "QA-INTERNAL-001" }), true);
  assert.equal(isNonRetailCatalogProduct({ ...product, name: "Installed Unit E2E 123" }), true);
  assert.equal(isNonRetailCatalogProduct({ ...product, name: "LG Premium Dual Inverter" }), false);
});
