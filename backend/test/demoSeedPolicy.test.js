const test = require('node:test');
const assert = require('node:assert/strict');
const { isLocalMongoUri, shouldSeedDemoData } = require('../src/seed/demoSeedPolicy');

test('only loopback MongoDB URIs count as local', () => {
  assert.equal(isLocalMongoUri('mongodb://localhost:27017/aeropulse_demo'), true);
  assert.equal(isLocalMongoUri('mongodb://127.0.0.1:27017/aeropulse_demo'), true);
  assert.equal(isLocalMongoUri('mongodb+srv://cluster.example.com/aeropulse'), false);
  assert.equal(isLocalMongoUri('mongodb://cluster.example.com/aeropulse'), false);
});

test('demo seeding is opt-in and never runs on remote or production databases', () => {
  assert.equal(shouldSeedDemoData({ mongoUri: 'mongodb://localhost:27017/aeropulse_demo', nodeEnv: 'development' }), false);
  assert.equal(shouldSeedDemoData({ mongoUri: 'mongodb+srv://cluster.example.com/staging', nodeEnv: 'development' }), false);
  assert.equal(shouldSeedDemoData({ flag: 'true', mongoUri: 'mongodb://localhost:27017/aeropulse_demo', nodeEnv: 'development' }), true);
  assert.throws(() => shouldSeedDemoData({ flag: 'true', mongoUri: 'mongodb+srv://cluster.example.com/production', nodeEnv: 'development' }), /requires a local MongoDB URI/);
  assert.throws(() => shouldSeedDemoData({ flag: 'true', mongoUri: 'mongodb://localhost:27017/aeropulse_demo', nodeEnv: 'production' }), /non-production/);
});
