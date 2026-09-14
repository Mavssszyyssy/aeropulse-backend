const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const connectDb = require("../src/config/db");

test("concurrent serverless requests share one database connection attempt", async (t) => {
  delete global.__aeropulseMongoReadiness;
  global.__aeropulseMongoLastPingAt = 0;
  mongoose.connection.readyState = 0;

  let connectCalls = 0;
  let releaseConnection;
  const connectionGate = new Promise((resolve) => {
    releaseConnection = resolve;
  });

  t.mock.method(mongoose, "connect", async () => {
    connectCalls += 1;
    await connectionGate;
    mongoose.connection.readyState = 1;
    return mongoose;
  });

  const first = connectDb();
  const second = connectDb();
  const third = connectDb();
  await Promise.resolve();

  assert.equal(connectCalls, 1);
  releaseConnection();
  await Promise.all([first, second, third]);
  assert.equal(connectCalls, 1);

  mongoose.connection.readyState = 0;
  delete global.__aeropulseMongoReadiness;
  global.__aeropulseMongoLastPingAt = 0;
});
