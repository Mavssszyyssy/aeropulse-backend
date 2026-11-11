const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCatalogImageUrl } = require("../src/domain/catalogImageUrl");
const { createProduct } = require("../src/controllers/productController");

test("catalog image links accept direct HTTPS photos, including query-based thumbnails", () => {
  assert.equal(normalizeCatalogImageUrl(""), "");
  assert.equal(normalizeCatalogImageUrl(" https://images.example.com/ac.png "), "https://images.example.com/ac.png");
  assert.equal(normalizeCatalogImageUrl("https://images.example.com/photo?id=42"), "https://images.example.com/photo?id=42");
});

test("catalog image links reject insecure, malformed, credentialed and advertising URLs", () => {
  for (const value of [
    "http://images.example.com/ac.jpg",
    "javascript:alert(1)",
    "not a URL",
    "https://user:pass@images.example.com/ac.jpg",
    "https://www.google.com/aclk?ad=1",
    `https://images.example.com/${"x".repeat(2049)}`,
  ]) assert.equal(normalizeCatalogImageUrl(value), null);
});

test("product creation rejects an invalid linked image before changing inventory", async () => {
  const response = {
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await createProduct({
    authUser: { role: "superadmin" },
    body: { name: "New AC", sku: "NEW-AC-1", image: "https://www.google.com/aclk?ad=1" },
  }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.field, "image");
});
