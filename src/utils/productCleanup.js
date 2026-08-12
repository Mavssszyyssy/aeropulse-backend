const Product = require("../models/Product");

/**
 * Cleans up duplicate products from the database
 * Keeps the product with the most stock and latest created date as the primary
 * @param {Object} options - Configuration options
 * @param {boolean} options.dryRun - If true, only reports what would be deleted
 * @param {boolean} options.verbose - If true, logs detailed information
 * @returns {Promise<Object>} - Cleanup report
 */
const cleanupDuplicateProducts = async (options = {}) => {
  const { dryRun = true, verbose = false } = options;
  
  const report = {
    dryRun,
    timestamp: new Date().toISOString(),
    duplicateGroups: [],
    deletedCount: 0,
    keptCount: 0,
    errors: []
  };

  try {
    const products = await Product.find({}).sort({ createdAt: -1 });
    
    const seenNameSpecs = new Map();
    const seenSKU = new Map();
    const toDelete = [];
    
    // Group products by name+specs and by SKU
    for (const product of products) {
      const nameSpecsKey = `${(product.name || '').toLowerCase()}::${(product.specs || '').toLowerCase()}`;
      const skuKey = `${(product.sku || '').toLowerCase()}`;
      
      // Track by name+specs
      if (!seenNameSpecs.has(nameSpecsKey)) {
        seenNameSpecs.set(nameSpecsKey, []);
      }
      seenNameSpecs.get(nameSpecsKey).push(product);
      
      // Track by SKU
      if (skuKey.trim()) {
        if (!seenSKU.has(skuKey)) {
          seenSKU.set(skuKey, []);
        }
        seenSKU.get(skuKey).push(product);
      }
    }
    
    // Process name+specs duplicates
    for (const [key, duplicates] of seenNameSpecs.entries()) {
      if (duplicates.length > 1) {
        // Sort by stock (descending) then by createdAt (descending)
        duplicates.sort((a, b) => {
          const stockDiff = (Number(b.stock) || 0) - (Number(a.stock) || 0);
          if (stockDiff !== 0) return stockDiff;
          return new Date(b.createdAt) - new Date(a.createdAt);
        });
        
        const primary = duplicates[0];
        const secondaries = duplicates.slice(1);
        
        const groupReport = {
          type: 'name_specs',
          key,
          primaryId: primary._id.toString(),
          primaryName: primary.name,
          primarySku: primary.sku,
          primaryStock: primary.stock,
          deleteCount: secondaries.length,
          toDelete: secondaries.map(p => ({
            id: p._id.toString(),
            name: p.name,
            sku: p.sku,
            stock: p.stock,
            createdAt: p.createdAt
          }))
        };
        
        report.duplicateGroups.push(groupReport);
        
        secondaries.forEach(p => {
          if (!toDelete.find(d => d._id.toString() === p._id.toString())) {
            toDelete.push(p);
          }
        });
      }
    }
    
    // Process SKU duplicates
    for (const [key, duplicates] of seenSKU.entries()) {
      if (duplicates.length > 1) {
        duplicates.sort((a, b) => {
          const stockDiff = (Number(b.stock) || 0) - (Number(a.stock) || 0);
          if (stockDiff !== 0) return stockDiff;
          return new Date(b.createdAt) - new Date(a.createdAt);
        });
        
        const primary = duplicates[0];
        const secondaries = duplicates.slice(1);
        
        const groupReport = {
          type: 'sku',
          key,
          primaryId: primary._id.toString(),
          primaryName: primary.name,
          primarySku: primary.sku,
          primaryStock: primary.stock,
          deleteCount: secondaries.length,
          toDelete: secondaries.map(p => ({
            id: p._id.toString(),
            name: p.name,
            sku: p.sku,
            stock: p.stock,
            createdAt: p.createdAt
          }))
        };
        
        report.duplicateGroups.push(groupReport);
        
        secondaries.forEach(p => {
          if (!toDelete.find(d => d._id.toString() === p._id.toString())) {
            toDelete.push(p);
          }
        });
      }
    }
    
    // Remove duplicates
    if (toDelete.length > 0) {
      if (!dryRun) {
        for (const product of toDelete) {
          await Product.deleteOne({ _id: product._id });
          if (verbose) {
            console.log(`Deleted duplicate product: ${product.name} (SKU: ${product.sku})`);
          }
        }
      }
      report.deletedCount = toDelete.length;
    }
    
    report.keptCount = products.length - toDelete.length;
    
    if (verbose) {
      console.log('Cleanup Report:', JSON.stringify(report, null, 2));
    }
    
    return report;
  } catch (error) {
    report.errors.push({
      message: error.message,
      stack: error.stack
    });
    throw error;
  }
};

/**
 * Validates that all products have unique SKU and name+specs
 * @returns {Promise<Object>} - Validation report
 */
const validateProductUniqueness = async () => {
  const report = {
    timestamp: new Date().toISOString(),
    totalProducts: 0,
    uniqueSkuCount: 0,
    uniqueNameSpecsCount: 0,
    duplicateSkus: [],
    duplicateNameSpecs: [],
    isValid: true
  };

  try {
    const products = await Product.find({});
    report.totalProducts = products.length;
    
    const skuMap = new Map();
    const nameSpecsMap = new Map();
    
    for (const product of products) {
      const skuKey = (product.sku || '').toLowerCase();
      const nameSpecsKey = `${(product.name || '').toLowerCase()}::${(product.specs || '').toLowerCase()}`;
      
      // Track SKU duplicates
      if (skuKey) {
        if (skuMap.has(skuKey)) {
          skuMap.get(skuKey).push(product);
        } else {
          skuMap.set(skuKey, [product]);
        }
      }
      
      // Track name+specs duplicates
      if (nameSpecsMap.has(nameSpecsKey)) {
        nameSpecsMap.get(nameSpecsKey).push(product);
      } else {
        nameSpecsMap.set(nameSpecsKey, [product]);
      }
    }
    
    // Count and report duplicates
    for (const [key, group] of skuMap.entries()) {
      if (group.length === 1) {
        report.uniqueSkuCount++;
      } else {
        report.isValid = false;
        report.duplicateSkus.push({
          sku: key,
          count: group.length,
          products: group.map(p => ({
            id: p._id.toString(),
            name: p.name,
            stock: p.stock,
            createdAt: p.createdAt
          }))
        });
      }
    }
    
    for (const [key, group] of nameSpecsMap.entries()) {
      if (group.length === 1) {
        report.uniqueNameSpecsCount++;
      } else {
        report.isValid = false;
        report.duplicateNameSpecs.push({
          nameSpecs: key,
          count: group.length,
          products: group.map(p => ({
            id: p._id.toString(),
            name: p.name,
            sku: p.sku,
            stock: p.stock,
            createdAt: p.createdAt
          }))
        });
      }
    }
    
    return report;
  } catch (error) {
    report.errors = [{ message: error.message }];
    throw error;
  }
};

module.exports = {
  cleanupDuplicateProducts,
  validateProductUniqueness
};
