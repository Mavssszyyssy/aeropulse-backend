const Product = require("../models/Product");

/**
 * Checks if a product with the same SKU exists (case-insensitive)
 * @param {string} sku - SKU to check
 * @param {string} excludeId - Product ID to exclude from search (for updates)
 * @returns {Promise<Object|null>} - Existing product or null
 */
const checkDuplicateSku = async (sku, excludeId = null) => {
  if (!sku) return null;
  
  const query = {
    sku: { $regex: new RegExp(`^${String(sku).trim()}$`, 'i') }
  };
  
  if (excludeId) {
    query._id = { $ne: excludeId };
  }
  
  return await Product.findOne(query);
};

/**
 * Checks if a product with the same name and specs exists (case-insensitive)
 * @param {string} name - Product name
 * @param {string} specs - Product specs
 * @param {string} excludeId - Product ID to exclude from search (for updates)
 * @returns {Promise<Object|null>} - Existing product or null
 */
const checkDuplicateNameSpecs = async (name, specs, excludeId = null) => {
  if (!name) return null;
  
  const normalizedName = String(name).trim();
  const normalizedSpecs = String(specs || '').trim();
  
  const query = {
    name: { $regex: new RegExp(`^${normalizedName}$`, 'i') },
    specs: { $regex: new RegExp(`^${normalizedSpecs}$`, 'i') }
  };
  
  if (excludeId) {
    query._id = { $ne: excludeId };
  }
  
  return await Product.findOne(query);
};

/**
 * Comprehensive duplicate check for product creation/update
 * Checks SKU and name+specs combination
 * @param {Object} productData - Product data to check
 * @param {string} productData.sku - Product SKU (required)
 * @param {string} productData.name - Product name (required)
 * @param {string} productData.specs - Product specs
 * @param {string} excludeId - Product ID to exclude from search (for updates)
 * @returns {Promise<{isDuplicate: boolean, duplicateType: string|null, existingProduct: Object|null}>}
 */
const validateProductUniqueness = async (productData, excludeId = null) => {
  const { sku, name, specs } = productData;
  
  if (!sku || !name) {
    return {
      isDuplicate: false,
      duplicateType: null,
      existingProduct: null,
      error: "SKU and name are required"
    };
  }
  
  try {
    // Check for duplicate SKU
    const duplicateSku = await checkDuplicateSku(sku, excludeId);
    if (duplicateSku) {
      return {
        isDuplicate: true,
        duplicateType: 'sku',
        existingProduct: {
          id: duplicateSku._id,
          name: duplicateSku.name,
          sku: duplicateSku.sku,
          specs: duplicateSku.specs
        }
      };
    }
    
    // Check for duplicate name+specs combination
    const duplicateNameSpecs = await checkDuplicateNameSpecs(name, specs, excludeId);
    if (duplicateNameSpecs) {
      return {
        isDuplicate: true,
        duplicateType: 'name_specs',
        existingProduct: {
          id: duplicateNameSpecs._id,
          name: duplicateNameSpecs.name,
          sku: duplicateNameSpecs.sku,
          specs: duplicateNameSpecs.specs
        }
      };
    }
    
    return {
      isDuplicate: false,
      duplicateType: null,
      existingProduct: null
    };
  } catch (error) {
    throw new Error(`Validation error: ${error.message}`);
  }
};

/**
 * Finds all products with potential duplicates
 * Useful for cleanup operations
 * @returns {Promise<Array>} - Array of potential duplicate groups
 */
const findPotentialDuplicates = async () => {
  try {
    const products = await Product.find({}).sort({ name: 1, specs: 1 });
    const duplicates = [];
    const seen = new Map();
    
    for (const product of products) {
      const key = `${(product.name || '').toLowerCase()}::${(product.specs || '').toLowerCase()}`;
      const skuKey = `${(product.sku || '').toLowerCase()}`;
      
      if (seen.has(key)) {
        const group = seen.get(key);
        group.products.push(product);
      } else {
        seen.set(key, {
          key,
          products: [product]
        });
      }
      
      if (seen.has(skuKey) && skuKey.trim() !== '') {
        const group = seen.get(skuKey);
        if (!group.products.some(p => p._id.toString() === product._id.toString())) {
          group.products.push(product);
        }
      } else if (skuKey.trim() !== '') {
        seen.set(skuKey, {
          key: skuKey,
          products: [product]
        });
      }
    }
    
    // Filter to only groups with actual duplicates
    for (const [key, group] of seen.entries()) {
      if (group.products.length > 1) {
        duplicates.push({
          type: key.includes('::') ? 'name_specs' : 'sku',
          key,
          count: group.products.length,
          products: group.products.map(p => ({
            id: p._id,
            name: p.name,
            sku: p.sku,
            specs: p.specs,
            stock: p.stock
          }))
        });
      }
    }
    
    return duplicates;
  } catch (error) {
    throw new Error(`Error finding duplicates: ${error.message}`);
  }
};

module.exports = {
  checkDuplicateSku,
  checkDuplicateNameSpecs,
  validateProductUniqueness,
  findPotentialDuplicates
};
