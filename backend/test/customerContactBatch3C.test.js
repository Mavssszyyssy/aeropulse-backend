const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const ContactMessage = require("../src/models/ContactMessage");
const { countInquiryWords, validateContactInquiry, validateContactReply, validateContactName } = require("../src/domain/contactInquiryValidation");
const { createContactMessage, listMyContactMessages, getMyContactMessage } = require("../src/controllers/contactMessageController");

const respond = () => {
  const result = { statusCode: 200 };
  result.res = {
    status(code) { result.statusCode = code; return this; },
    json(body) { result.body = body; return this; },
  };
  return result;
};

test("invalid support inquiries are rejected before database writes or notifications", async (t) => {
  const write = t.mock.method(ContactMessage, "create", async () => assert.fail("Invalid inquiry reached persistence"));
  const cases = [
    [{ category: "unknown", subject: "Help", message: "Need help with my AC" }, /topic/],
    [{ category: "general", subject: "  ", message: "Need help with my AC" }, /required/],
    [{ category: "general", subject: "Hi", message: "Need help with my AC" }, /at least 3/],
    [{ category: "general", subject: "X".repeat(81), message: "Need help with my AC" }, /80/],
    [{ category: "general", subject: "Help", message: "  " }, /required/],
    [{ category: "general", subject: "Help", message: "X".repeat(1001) }, /1000/],
    [{ category: "general", subject: "Help", message: "short" }, /more detail/],
    [{ category: "general", subject: "Enjdhdhshsh", message: "Need help with my AC" }, /clear subject/],
    [{ category: "general", subject: "Help", message: "Jshshshshshsh" }, /Describe your concern/],
    [{ category: "general", subject: "Help", message: "“LOREM-IPSUM dolor sit amet, consectetur adipiscing elit.”" }, /placeholder/],
    [{ category: "general", subject: "Help", message: "Leak leak leak leak" }, /repeated text/],
    [{ category: "general", subject: "Help", message: "Need help now ".repeat(5) }, /repeated text/],
    [{ category: "general", subject: "Help", message: "123456 789000" }, /Describe your concern/],
    [{ category: "general", subject: "AC ".repeat(12) + "leak", message: "Need help with my AC" }, /12 words/],
    [{ category: "general", subject: "Help", message: "May tagas ".repeat(75) + "po" }, /150 words/],
    [{ category: "general", subject: "Help", message: "Need help with my AC", customerName: "LIMIT TESTING ".repeat(6) + "Reynaldo" }, /60 characters/],
    [{ category: "general", subject: "Help", message: "Need help with my AC", customerName: "Ana Ana Ana Ana Ana" }, /Enter your name/],
  ];
  for (const [body, expected] of cases) {
    const response = respond();
    await createContactMessage({ body, authUser: { _id: new mongoose.Types.ObjectId() } }, response.res);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, expected);
  }
  assert.equal(write.mock.callCount(), 0);
});

test("inquiry limits keep concise Filipino text, acronyms, and order identifiers valid", () => {
  const cases = [
    { subject: "AC E7", message: "Ayaw lumamig." },
    { subject: "GCash", message: "May bayad na po ang ORD-1794464233703-X27; paki-check ang resibo." },
    { subject: "Échec de paiement", message: "Hindi pa rin makita ang payment reference." },
    { subject: "Broken shop text", message: "The Shop shows “Lorem ipsum” as the product description." },
    {
      subject: "My AC stops cooling at night and shows an E7 error code",
      message: Array.from({ length: 15 }, (_, index) => `At check ${index + 1} my AC showed E7 after starting again.`).join(" "),
    },
  ];
  for (const inquiry of cases) assert.equal(validateContactInquiry(inquiry), "");
  assert.equal(countInquiryWords(cases.at(-1).subject), 12);
  assert.equal(countInquiryWords(cases.at(-1).message), 150);
});

test("support text blocks keyboard patterns, invisible filler and padded repetition", () => {
  for (const message of [
    "jhjhjh jhjhjh", "JHJHJH JHJHJH", "E h j d h d h s h s h", "help jshshshshshsh", "help jhjhjh1",
    "Jshshshshshsh\u200b Jshshshshshsh", "ｊｈｊｈｊｈ ｊｈｊｈｊｈ",
    "May tagas ".repeat(12) + "please", "Please check this AC unit. ".repeat(15) + "thanks", ".... !!! ???", "123456 789000",
    "Lorem ipsum dolor sit amet", "asdfgh-qwerty zxcvbn",
  ]) {
    assert.notEqual(validateContactInquiry({ subject: "AC concern", message }), "", message);
    assert.notEqual(validateContactReply(message), "", message);
  }
  for (const reply of ["Noted po.", "OK po.", "Noted, thank you.", "Salamat po, ipapa-check namin ang unit bukas.",
    "Your WA70F13E4LTC unit is available in Bulacan.", "The unit reports E7; please book an inspection.",
    "Na-forward na po sa branch. Hintayin ang update sa Alerts."]) {
    assert.equal(validateContactReply(reply), "", reply);
  }
});

test("reply length and word limits reject excess without truncating and accept the boundaries", () => {
  const atWordLimit = Array.from({ length: 15 }, (_, index) => `At check ${index + 1} my AC showed E7 after starting again.`).join(" ");
  assert.equal(countInquiryWords(atWordLimit), 150);
  assert.equal(validateContactReply(atWordLimit), "");
  assert.match(validateContactReply(atWordLimit + " now"), /150 words/);
  assert.match(validateContactReply("Please inspect the unit. ".repeat(50)), /1000 characters/);
  assert.match(validateContactReply({ message: "Please check" }), /Write a reply/);
  assert.match(validateContactReply(""), /Write a reply/);
  assert.match(validateContactReply("jhjhjh"), /clear reply/);
  const atCharacterLimit = Array.from({ length: 20 }, (_, index) => `The technician inspected compressor ${index + 1} and scheduled maintenance at Bulacan.`).join(" ").slice(0, 1000);
  assert.equal(validateContactReply(atCharacterLimit), "");
  assert.match(validateContactReply(atCharacterLimit + "!"), /1000 characters/);
  assert.notEqual(validateContactReply("Please help with model " + "A".repeat(60) + "1"), "");
});

test("contact names allow real name punctuation but reject oversized and repeated filler", () => {
  for (const name of ["Ana María de la Cruz Jr.", "D’Arcy O'Neil", "Ng", "Jean-Luc", "José Santos III", "Ma. Carmen D. Cruz", "J. P. Reyes"]) {
    assert.equal(validateContactName(name), "", name);
  }
  for (const name of ["LIMIT TESTING ".repeat(6) + "Reynaldo", "asdfgh", "Ana Ana Ana Ana Ana", ".", "123456", "Jshshshshshsh", {}]) {
    assert.notEqual(validateContactName(name), "", String(name));
  }
});

test("schema validates new text but allows handling older over-limit tickets unchanged", async () => {
  const data = { _id: new mongoose.Types.ObjectId(), customer: new mongoose.Types.ObjectId(), ticketCode: "MSG-OLD",
    customerName: "Ana Cruz", subject: "Older ticket", message: "Please inspect the unit. ".repeat(80), status: "new" };
  await assert.rejects(new ContactMessage(data).validate(), (error) => !!error.errors.message);
  const legacy = ContactMessage.hydrate(data);
  legacy.status = "in_progress";
  await legacy.validate();
  legacy.adminReply = "jhjhjh";
  await assert.rejects(legacy.validate(), (error) => !!error.errors.adminReply);
  legacy.adminReply = "Please book an inspection through the mobile app.";
  await legacy.validate();
});

test("customer history cursor is stable and scoped to owner", async (t) => {
  const owner = new mongoose.Types.ObjectId();
  const ids = Array.from({ length: 3 }, () => new mongoose.Types.ObjectId());
  const createdAt = new Date("2026-10-01T00:00:00.000Z");
  let filter;
  let sort;
  let limit;
  t.mock.method(ContactMessage, "find", (value) => {
    filter = value;
    return { select() { return this; }, sort(value) { sort = value; return this; }, limit(value) {
      limit = value;
      return Promise.resolve(ids.map((_id) => ({ _id, createdAt, subject: "Help" })));
    } };
  });
  const first = respond();
  await listMyContactMessages({ authUser: { _id: owner }, query: { limit: "2" } }, first.res);
  assert.equal(limit, 3);
  assert.deepEqual(filter, { customer: owner });
  assert.deepEqual(sort, { createdAt: -1, _id: -1 });
  assert.equal(first.body.messages.length, 2);
  assert.equal(first.body.pagination.nextCursor, `${createdAt.toISOString()}|${ids[1]}`);

  const second = respond();
  await listMyContactMessages({ authUser: { _id: owner }, query: { limit: "2", before: first.body.pagination.nextCursor } }, second.res);
  assert.equal(String(filter.customer), String(owner));
  assert.deepEqual(filter.$or, [
    { createdAt: { $lt: createdAt } },
    { createdAt, _id: { $lt: String(ids[1]) } },
  ]);
});

test("individual conversation details require customer ownership", async (t) => {
  const owner = new mongoose.Types.ObjectId();
  const id = new mongoose.Types.ObjectId();
  let filter;
  t.mock.method(ContactMessage, "findOne", (value) => {
    filter = value;
    return { select: async () => null };
  });
  const response = respond();
  await getMyContactMessage({ authUser: { _id: owner }, params: { id: String(id) } }, response.res);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(filter, { _id: String(id), customer: owner });
});
