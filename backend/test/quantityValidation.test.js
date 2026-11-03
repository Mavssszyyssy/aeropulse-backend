const test = require("node:test");
const assert = require("node:assert/strict");
const Product = require("../src/models/Product");
const { parsePositiveWholeQuantity, parseNonnegativeWholeQuantity } = require("../src/domain/quantityValidation");
const { updateBranchStock, restockProduct } = require("../src/controllers/productController");

const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test("physical quantities reject decimal, zero, negative, malformed and unsafe values", () => {
  for (const value of [1.5, "1.5", -1, "-1", 0, "0", "", " ", "abc", "1e2", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parsePositiveWholeQuantity(value), null, String(value));
  }
  assert.equal(parsePositiveWholeQuantity(" 12 "), 12);
  assert.equal(parseNonnegativeWholeQuantity(0), 0);
  assert.equal(parseNonnegativeWholeQuantity("2"), 2);
});

test("invalid inventory additions leave product stock unchanged", async (t) => {
  const product = new Product({ name: "AC", sku: "AC-QTY", stock: 4, branchStock: { Bulacan: 4 } });
  t.mock.method(Product, "findById", async () => product);
  const save = t.mock.method(product, "save", async () => product);
  for (const quantity of ["1.5", "-1", "0", "letters", "9007199254740992"]) {
    const req = { authUser: { role: "superadmin" }, params: { productId: String(product._id) }, body: { branch: "Bulacan", action: "add", quantity } };
    const branchRes = response();
    await updateBranchStock(req, branchRes);
    assert.equal(branchRes.statusCode, 400);
    const restockRes = response();
    await restockProduct(req, restockRes);
    assert.equal(restockRes.statusCode, 400);
  }
  assert.equal(product.stock, 4);
  assert.equal(product.branchStock.get("Bulacan"), 4);
  assert.equal(save.mock.callCount(), 0);
});
