const BranchCoverage = require("../models/BranchCoverage");
const Product = require("../models/Product");
const { isCustomerCatalogProduct } = require("../domain/catalogVisibility");
const { isCustomerChatBlocked, isCustomerChatInScope, isFilipinoQuestion } = require("../domain/customerChatKnowledge");

const words = (value) => String(value || "").normalize("NFKC").toLowerCase()
  .replace(/['’]/g, "").replace(/[^\p{L}\p{N}.]+/gu, " ").trim().replace(/\s+/g, " ");
const contains = (text, phrase) => Boolean(phrase) && ` ${text} `.includes(` ${phrase} `);
const normalizeQuestion = (value) => words(value).replace(/\.$/, "");
const stockQuestion = /\b(?:stocks?|availability|available|inventory|on hand|natitirang?|suplay|mayron|mayroon)\b/;
const priceQuestion = /\b(?:price|prices|magkano|presyo|how much)\b/;
const otherWorkflow = /\b(?:appointments?|bookings?|schedules?|slots?|technicians?|maintenance|service fees?|service cost|delivery fee|shipping fee|installation fee|refund|warranty claim|payment status)\b/;
const followUp = /^(?:how about|what about|and in|and|sa|paano naman (?:sa|ang)|(?:model|sku)\b)/;
const genericWords = new Set(("which what where is are has have a the for of this that it there your you do in at and or vs versus between more most " +
  "highest higher fewer less lowest least many much left any still current currently number total count all overall show me tell check please does " +
  "branch branches stock stocks inventory availability available not out on hand units unit ac a c air conditioner conditioners aircon airconditioning aircon air con shop catalog catalogue cold trading act " +
  "items products product sell buy buying ali aling alin ano anong pinaka pinakamaraming pinakamarami pinakakaunti maraming marami madaming madami mas sa " +
  "sangay may meron mayroon mayron ng ang mga ba lang po ilan natitira natitirang saan kumpara kaysa kay kesa dito lahat pang para magkano presyo price prices how").split(" "));

const intentOf = (question) => {
  if (otherWorkflow.test(question)) return "";
  const asksStock = stockQuestion.test(question) || /\b(?:do you have|may available|may stock|may tinda|may binebenta)\b/.test(question)
    || /\b(?:which branch|aling branch|aling sangay|saan)\b.*\b(?:have|has|may|meron|buy|bili|more|most|marami|madami)\b/.test(question);
  return asksStock ? "stock" : priceQuestion.test(question) ? "price" : "";
};

const capacityOf = (value) => normalizeQuestion(value).match(/\b(\d+(?:\.\d+)?)\s*(?:hp|horsepower)\b/)?.[1];

function findModels(question, products) {
  const exactSku = products.filter((product) => {
    const sku = normalizeQuestion(product.sku);
    return contains(question, sku) || (sku.includes(" ") && contains(question, sku.replaceAll(" ", "")));
  });
  if (exactSku.length) return exactSku;
  const requestedCapacity = capacityOf(question);
  const candidates = products.filter((product) => !requestedCapacity || Number(capacityOf(product.specs) || product.specs) === Number(requestedCapacity));
  const exactNames = candidates.filter((product) => contains(question, normalizeQuestion(product.name)));
  if (exactNames.length) return exactNames;
  return candidates.filter((product) => {
    const name = normalizeQuestion(product.name);
    const brand = normalizeQuestion(product.brand);
    const modelWords = name.startsWith(`${brand} `) ? name.slice(brand.length + 1).split(" ") : name.split(" ");
    return Boolean(brand && modelWords[0] && contains(question, `${brand} ${modelWords[0]}`));
  });
}

const mentionedBranches = (question, branches) => branches.filter((branch) => contains(question, normalizeQuestion(branch)));
const generalStockQuestion = (question, branches) => {
  const branchWords = new Set(branches.flatMap((branch) => normalizeQuestion(branch).split(" ")));
  return question.split(" ").every((word) => genericWords.has(word) || branchWords.has(word));
};

const readBranchStock = (product, branch) => {
  const stock = product.branchStock instanceof Map ? product.branchStock.get(branch) : product.branchStock?.[branch];
  const quantity = Number(stock ?? 0);
  return Number.isSafeInteger(quantity) && quantity >= 0 ? quantity : 0;
};

const modelLabel = (product) => [product.name, product.specs, product.sku].filter(Boolean).join(" · ");
const peso = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

async function answerCustomerCatalogQuestion(message, history = [], language) {
  if (isCustomerChatBlocked(message)) return null;
  const question = normalizeQuestion(message);
  const previous = (Array.isArray(history) ? history : []).slice(-10).findLast((entry) => entry?.role === "user");
  const context = String(previous?.content || "").slice(0, 700);
  const previousQuestion = isCustomerChatBlocked(context) ? "" : normalizeQuestion(context);
  const directIntent = intentOf(question);
  const previousIntent = intentOf(previousQuestion);
  const contextual = !directIntent && previousIntent && !otherWorkflow.test(question) && question.split(" ").length <= 10;
  if (!directIntent && !contextual) return null;

  const filipino = isFilipinoQuestion(message) || (contextual && isFilipinoQuestion(context)) || language === "Filipino";
  const reply = (english, tagalog) => ({ text: filipino ? tagalog : english, route: "/shop" });
  const intent = directIntent || previousIntent;
  try {
    const [catalog, activeBranches] = await Promise.all([
      Product.find({ isActive: { $ne: false } }).select("name brand sku specs price branchStock isActive").lean(),
      intent === "stock" ? BranchCoverage.find({ active: true }).select("name").lean() : [],
    ]);
    const products = catalog.filter(isCustomerCatalogProduct);
    const branches = activeBranches.map(({ name }) => name).sort((a, b) => a.localeCompare(b));
    const namedBranches = mentionedBranches(question, branches);
    const latestMatches = findModels(question, products);
    if (directIntent && !isCustomerChatInScope(question) && !latestMatches.length && !namedBranches.length) return null;
    if (contextual && !latestMatches.length && !namedBranches.length && !followUp.test(question) && !/^\d+\s*hp\b/.test(question)) return null;

    const inheritModel = !latestMatches.length && previousIntent && (contextual || generalStockQuestion(question, branches));
    const matches = inheritModel ? findModels(`${previousQuestion} ${question}`, products) : latestMatches;
    if (matches.length > 1) {
      const options = matches.slice(0, 4).map(modelLabel).join("; ");
      return reply(`I found several matching AC models. Which SKU do you mean? ${options}`, `May ilang tumugmang modelo ng aircon. Aling SKU ang tinutukoy mo? ${options}`);
    }
    const product = matches[0];
    if (intent === "price") {
      if (!product || product.price == null) return reply("Which AC model or SKU would you like me to price?", "Aling modelo o SKU ng aircon ang gusto mong malaman ang presyo?");
      const price = peso.format(product.price);
      return reply(`${modelLabel(product)} is listed at ${price} per unit in the Shop.`, `Ang nakalistang presyo ng ${modelLabel(product)} sa Shop ay ${price} bawat unit.`);
    }

    if (!product && !generalStockQuestion(question, branches) && !(contextual && namedBranches.length)) {
      return reply("Which AC model or SKU should I check? I can compare its available stock by branch.", "Aling modelo o SKU ng aircon ang gusto mong tingnan? Maaari kong ikumpara ang available na stock sa bawat branch.");
    }
    if (!branches.length || !products.length) return reply("I couldn’t verify branch stock right now. Check the Shop or try again shortly.", "Hindi ko ma-verify ang stock ng mga branch ngayon. Tingnan ang Shop o subukang muli mamaya.");

    const previousBranches = inheritModel || contextual ? mentionedBranches(previousQuestion, branches) : [];
    const checkedBranches = namedBranches.length ? namedBranches : contextual && previousBranches.length ? previousBranches : branches;
    const relevantProducts = product ? [product] : products;
    const totals = checkedBranches.map((name) => ({ name, stock: relevantProducts.reduce((sum, item) => sum + readBranchStock(item, name), 0) }))
      .sort((a, b) => b.stock - a.stock || a.name.localeCompare(b.name));
    const topStock = totals[0].stock;
    const leaders = totals.filter(({ stock }) => stock === topStock).map(({ name }) => name).join(", ");
    const summary = totals.slice(0, 8).map(({ name, stock }) => `${name} (${stock})`).join(", ");
    const scope = product ? modelLabel(product) : "all AC models combined";
    const localScope = product ? scope : "lahat ng modelo ng aircon";
    const note = product ? "" : " Send a model name or SKU for its specific stock.";
    const localNote = product ? "" : " Ibigay ang modelo o SKU para sa stock ng partikular na aircon.";
    if (topStock === 0) return reply(`No available units for ${scope} at the branches checked (${summary}).${note}`, `Walang available na unit para sa ${localScope} sa mga branch na tiningnan (${summary}).${localNote}`);
    if (totals.length === 1) return reply(`${leaders} has ${topStock} available ${topStock === 1 ? "unit" : "units"} for ${scope}.${note}`, `May ${topStock} available na unit sa ${leaders} para sa ${localScope}.${localNote}`);
    const tied = totals.filter(({ stock }) => stock === topStock).length > 1;
    return reply(
      `${tied ? `${leaders} are tied for the most stock` : `${leaders} has the most stock`} for ${scope}, with ${topStock} available ${topStock === 1 ? "unit" : "units"}${tied ? " each" : ""}. Branch counts: ${summary}.${note}`,
      `${tied ? `Tabla sa pinakamaraming stock ang ${leaders}` : `${leaders} ang may pinakamaraming stock`} para sa ${localScope}, na may ${topStock} available na unit${tied ? " bawat branch" : ""}. Bilang sa mga branch: ${summary}.${localNote}`,
    );
  } catch (error) {
    console.warn("Customer catalog chat lookup failed", { name: error?.name });
    return (directIntent && isCustomerChatInScope(question)) || (contextual && followUp.test(question))
      ? reply("I couldn’t check the live catalogue right now. Open the Shop or try again shortly.", "Hindi ko makita ang kasalukuyang katalogo ngayon. Buksan ang Shop o subukang muli mamaya.")
      : null;
  }
}

module.exports = { answerCustomerCatalogQuestion };
