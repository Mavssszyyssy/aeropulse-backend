const NON_RETAIL_CATALOG_MARKER =
  /(?:^|[\s_-])(?:test|demo|sample|e2e|qa)(?:$|[\s_-])/i;

const isNonRetailCatalogProduct = (product = {}) =>
  [product.name, product.sku, product.brand].some((value) =>
    NON_RETAIL_CATALOG_MARKER.test(String(value || "")),
  );

const isCustomerCatalogProduct = (product = {}) => product.isActive !== false && !isNonRetailCatalogProduct(product);

module.exports = { NON_RETAIL_CATALOG_MARKER, isNonRetailCatalogProduct, isCustomerCatalogProduct };
