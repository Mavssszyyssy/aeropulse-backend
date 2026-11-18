const BranchCoverage = require("../models/BranchCoverage");
const Product = require("../models/Product");
const { isCustomerCatalogProduct } = require("../domain/catalogVisibility");
const { isCustomerChatBlocked, isCustomerChatInScope, isFilipinoQuestion, resolveCustomerChatQuestion } = require("../domain/customerChatKnowledge");

const words = (value) => String(value || "").normalize("NFKC").toLowerCase()
  .replace(/['’]/g, "").replace(/[^\p{L}\p{N}.]+/gu, " ").trim().replace(/\s+/g, " ");
const contains = (text, phrase) => Boolean(phrase) && ` ${text} `.includes(` ${phrase} `);
const normalizeQuestion = (value) => words(value).replace(/\.$/, "");
const stockQuestion = /\b(?:stocks?|availability|available|inventory|on hand|natitirang?|suplay|mayron|mayroon)\b/;
const priceQuestion = /\b(?:price|prices|magkano|presyo|how much)\b/;
const recommendationQuestion = /\b(?:recommend\w*|suggest\w*|best(?:\s*seller)?|bestseller|best selling|suitable|which one|choose|budget|affordable|cheapest|pinakamaganda|pinakamura|rekomenda|bagay|alin.*maganda)\b/;
const detailsQuestion = /\b(?:compare|comparison|difference|differences|specs|specifications|features|details|kumpara|pagkakaiba|detalye)\b/;
const coverageQuestion = /\b(?:branches|coverage|service area|covered|sakop|sangay)\b|\b(?:where|location|address|nasaan|saan)\b.*\bbranch\b|\bdeliver\w*\s+(?:to|in)\b/;
const otherWorkflow = /\b(?:orders?|cart|checkout|payments?|paymongo|gcash|account|password|login|notifications?|contact|support|service requests?|appointments?|bookings?|schedules?|slots?|technicians?|maintenance|service fees?|service cost|delivery fee|shipping fee|installation fee|refund|warranty claim|not cooling|leaking|leak|smoke|sparks|burning|breaker|tagas|tumutulo|maingay|noise|amoy sunog)\b/;
const followUp = /^(?:how about|what about|and in|and|sa|paano naman (?:sa|ang)|(?:model|sku)\b)/;
const genericWords = new Set(("which what where is are has have a the for of this that it there your you do in at and or vs versus between more most " +
  "highest higher fewer less lowest least many much left any still current currently number total count all overall show me tell check please does " +
  "branch branches stock stocks inventory availability available not out on hand units unit ac a c air conditioner conditioners aircon airconditioning aircon air con shop catalog catalogue cold trading act " +
  "items products product sell buy buying ali aling alin ano anong pinaka pinakamaraming pinakamarami pinakakaunti maraming marami madaming madami mas sa " +
  "sangay may meron mayroon mayron ng ang mga ba lang po ilan natitira natitirang saan kumpara kaysa kay kesa dito lahat pang para magkano presyo price prices how").split(" "));

const intentOf = (question) => {
  if (otherWorkflow.test(question)) return "";
  if (/\b(?:inverter vs|inverter versus|non inverter)\b/.test(question)) return "";
  const asksStock = stockQuestion.test(question) || /\b(?:do you have|may available|may stock|may tinda|may binebenta)\b/.test(question)
    || /\b(?:which branch|aling branch|aling sangay|saan)\b.*\b(?:have|has|may|meron|buy|bili|more|most|marami|madami)\b/.test(question);
  return recommendationQuestion.test(question) ? "recommendation"
    : asksStock ? "stock"
    : detailsQuestion.test(question) ? "details"
    : priceQuestion.test(question) ? "price"
    : coverageQuestion.test(question) ? "coverage" : "";
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
const priceOf = (product) => product.price != null && Number.isFinite(Number(product.price)) && Number(product.price) >= 0
  ? Number(product.price) : null;

const budgetOf = (question) => {
  const match = question.match(/\b(?:under|below|up to|maximum|max|budget(?:\s+is)?|within|hanggang|badyet)\s*(?:of\s*|is\s*|ko\s*|ay\s*)?(?:php\s*|pesos?\s*|p\s*)?(\d[\d\s,]*(?:\.\d+)?)\s*(k)?\b/i)
    || question.match(/^(?:php\s*)?(\d[\d\s,]*(?:\.\d+)?)\s*(k)?(?:\s*pesos)?$/i);
  if (!match) return null;
  const budget = Number(match[1].replace(/[\s,]/g, "")) * (match[2] ? 1000 : 1);
  return Number.isFinite(budget) && budget > 0 ? budget : null;
};

function productFacts(product, branches, filipino) {
  const details = [];
  const price = priceOf(product);
  if (price != null) details.push(peso.format(price));
  if (product.category) details.push(String(product.category));
  const features = (Array.isArray(product.features) ? product.features : []).filter((feature) => typeof feature === "string").slice(0, 2);
  if (features.length) details.push(features.join(", "));
  const stock = branches.map((name) => ({ name, stock: readBranchStock(product, name) })).filter(({ stock }) => stock > 0);
  details.push(stock.length
    ? stock.slice(0, 4).map(({ name, stock }) => `${name} (${stock})`).join(", ")
    : filipino ? "walang available na stock sa mga branch na tiningnan" : "no available stock at the branches checked");
  return `${modelLabel(product)} — ${details.join(" · ")}`;
}

async function answerCustomerCatalogQuestion(message, history = [], language) {
  if (isCustomerChatBlocked(message)) return null;
  const question = normalizeQuestion(message);
  const turns = (Array.isArray(history) ? history : []).slice(-10);
  const previous = turns.findLast((entry) => entry?.role === "user");
  const context = resolveCustomerChatQuestion(String(previous?.content || "").slice(0, 700), turns.slice(0, turns.lastIndexOf(previous)));
  const previousQuestion = isCustomerChatBlocked(context) ? "" : normalizeQuestion(context);
  const directIntent = intentOf(question);
  const previousIntent = intentOf(previousQuestion);
  const contextual = !directIntent && previousIntent && !otherWorkflow.test(question)
    && normalizeQuestion(resolveCustomerChatQuestion(message, turns)) !== question && question.split(" ").length <= 10;
  if (!directIntent && !contextual) return null;

  const filipino = isFilipinoQuestion(message) || (contextual && isFilipinoQuestion(context)) || language === "Filipino";
  const reply = (english, tagalog) => ({ text: filipino ? tagalog : english, route: "/shop" });
  const intent = directIntent || previousIntent;
  if (intent === "recommendation" && !isCustomerChatInScope(resolveCustomerChatQuestion(message, turns))) return null;
  try {
    const [catalog, activeBranches] = await Promise.all([
      intent === "coverage" ? [] : Product.find({ isActive: { $ne: false } }).select("name brand sku specs category features price branchStock isActive").lean(),
      intent !== "price" ? BranchCoverage.find({ active: true }).select("name coverageAreas").lean() : [],
    ]);
    const products = catalog.filter(isCustomerCatalogProduct);
    const branches = activeBranches.map(({ name }) => name).sort((a, b) => a.localeCompare(b));
    const namedBranches = mentionedBranches(question, branches);
    const latestMatches = findModels(question, products);
    const resolved = normalizeQuestion(resolveCustomerChatQuestion(message, turns));
    if (directIntent && !isCustomerChatInScope(resolved) && !latestMatches.length && !namedBranches.length) return null;
    const namedBrand = products.some(({ brand }) => contains(question, normalizeQuestion(brand)));
    if (contextual && !latestMatches.length && !namedBranches.length && !namedBrand
      && !followUp.test(question) && !/^\d+(?:\.\d+)?\s*hp\b/.test(question)
      && !(previousIntent === "recommendation" && budgetOf(question) != null)) return null;

    const inheritModel = !latestMatches.length && !namedBrand && previousIntent && (contextual || generalStockQuestion(question, branches) || resolved !== question);
    const matches = inheritModel ? findModels(`${previousQuestion} ${question}`, products) : latestMatches;
    const previousBranches = inheritModel || contextual || resolved !== question ? mentionedBranches(previousQuestion, branches) : [];
    const checkedBranches = namedBranches.length ? namedBranches : previousBranches.length ? previousBranches : branches;

    if (intent === "coverage") {
      const served = activeBranches.filter((branch) => namedBranches.includes(branch.name)
        || (branch.coverageAreas || []).some((area) => contains(question, normalizeQuestion(area))));
      const listed = served.length ? served : activeBranches;
      if (!listed.length) return reply("I couldn’t verify the active branches right now. Please contact support.", "Hindi ko ma-verify ang mga aktibong branch ngayon. Makipag-ugnayan sa support.");
      const summary = listed.slice(0, 6).map((branch) => `${branch.name}${branch.coverageAreas?.length ? ` — ${branch.coverageAreas.slice(0, 8).join(", ")}` : ""}`).join("\n");
      return {
        text: filipino
          ? `Mga aktibong branch at nakatalang service area:\n${summary}\nPiliin ang delivery address sa Shop para makumpirma ang branch at coverage. Para sa eksaktong address ng opisina, makipag-ugnayan sa support.`
          : `Active branches and their listed service areas:\n${summary}\nChoose your delivery address in Shop to confirm the branch and coverage. Contact support for an exact office address.`,
        route: "/shop",
      };
    }

    if (intent === "recommendation" || intent === "details") {
      const criteria = `${previousIntent && resolved !== question ? previousQuestion : ""} ${question}`;
      const capacity = capacityOf(question) || (resolved !== question ? capacityOf(previousQuestion) : null);
      const budget = budgetOf(question) ?? (resolved !== question ? budgetOf(previousQuestion) : null);
      const knownBrands = [...new Set(products.map(({ brand }) => brand).filter(Boolean))];
      const latestBrands = knownBrands.filter((brand) => contains(question, normalizeQuestion(brand)));
      const brands = latestBrands.length ? latestBrands : knownBrands.filter((brand) => contains(criteria, normalizeQuestion(brand)));
      const categories = ["split", "window", "floor", "portable"];
      const category = categories.find((value) => contains(question, value)) || categories.find((value) => contains(criteria, value));
      if (!matches.length && /\b(?:model|sku)\s+[a-z0-9]*\d[a-z0-9]*\b/.test(question)) {
        return reply("Which AC model or SKU do you mean? I couldn’t match that model to the current catalog.", "Aling modelo o SKU ng aircon ang tinutukoy mo? Hindi ko ito maitugma sa kasalukuyang katalogo.");
      }
      let candidates = matches.length ? matches : products;
      candidates = candidates.filter((product) => (!capacity || Number(capacityOf(product.specs) || product.specs) === Number(capacity))
        && (!brands.length || brands.includes(product.brand))
        && (!category || normalizeQuestion(product.category) === category)
        && (budget == null || (priceOf(product) != null && priceOf(product) <= budget)));
      if (intent === "details" && !matches.length && !brands.length && !capacity && !category) {
        return reply("Which AC models or SKUs would you like to compare? I can check their listed capacity, features, prices, and branch availability.", "Aling mga modelo o SKU ng aircon ang gusto mong ikumpara? Maaari kong tingnan ang nakatalang capacity, features, presyo, at stock sa mga branch.");
      }
      if (intent === "recommendation") {
        candidates = candidates.filter((product) => checkedBranches.some((branch) => readBranchStock(product, branch) > 0))
          .sort((a, b) => (priceOf(a) ?? Infinity) - (priceOf(b) ?? Infinity) || modelLabel(a).localeCompare(modelLabel(b)));
      }
      if (!candidates.length) return reply(
        "I couldn’t find an available AC matching those model, branch, and budget requirements. You can change a filter in Shop or tell me another budget, capacity, or branch.",
        "Wala akong nakitang available na aircon na tumutugma sa modelo, branch, at badyet na iyon. Baguhin ang filter sa Shop o magbigay ng ibang badyet, capacity, o branch.",
      );
      const facts = candidates.slice(0, 3).map((product) => productFacts(product, checkedBranches, filipino)).join("\n");
      return reply(
        `${intent === "details" ? "Here are the listed AC details" : "These available AC options are listed from lowest price"}:\n${facts}\n${intent === "recommendation" ? "The best fit depends on your room and usage. What room size, budget, and delivery area do you have? These are catalog suggestions; I do not have verified best-seller rankings." : "Prices and stock reflect the current catalog. Tell me the features that matter to you so I can narrow the comparison."}`,
        `${intent === "details" ? "Narito ang nakatalang detalye ng mga aircon" : "Mga available na aircon, mula sa pinakamababang presyo"}:\n${facts}\n${intent === "recommendation" ? "Depende sa silid at paggamit ang pinakamabagay. Ano ang laki ng silid, badyet, at delivery area mo? Mga mungkahi mula sa katalogo ito; wala akong verified na best-seller ranking." : "Mula sa kasalukuyang katalogo ang presyo at stock. Sabihin ang features na mahalaga sa iyo para mas mapaliit ang pagpipilian."}`,
      );
    }
    if (matches.length > 1) {
      const options = matches.slice(0, 4).map(modelLabel).join("; ");
      return reply(`I found several matching AC models. Which SKU do you mean? ${options}`, `May ilang tumugmang modelo ng aircon. Aling SKU ang tinutukoy mo? ${options}`);
    }
    const product = matches[0];
    if (intent === "price") {
      if (!product || priceOf(product) == null) return reply("Which AC model or SKU would you like me to price? I need a valid listed price to confirm it.", "Aling modelo o SKU ng aircon ang gusto mong malaman ang presyo? Kailangan ng valid na nakalistang presyo para makumpirma ito.");
      const price = peso.format(priceOf(product));
      return reply(`${modelLabel(product)} is listed at ${price} per unit in the Shop.`, `Ang nakalistang presyo ng ${modelLabel(product)} sa Shop ay ${price} bawat unit.`);
    }

    if (!product && !generalStockQuestion(question, branches) && !(contextual && namedBranches.length)) {
      return reply("Which AC model or SKU should I check? I can compare its available stock by branch.", "Aling modelo o SKU ng aircon ang gusto mong tingnan? Maaari kong ikumpara ang available na stock sa bawat branch.");
    }
    if (!branches.length || !products.length) return reply("I couldn’t verify branch stock right now. Check the Shop or try again shortly.", "Hindi ko ma-verify ang stock ng mga branch ngayon. Tingnan ang Shop o subukang muli mamaya.");

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
    return (directIntent && isCustomerChatInScope(resolveCustomerChatQuestion(message, turns))) || (contextual && followUp.test(question))
      ? reply("I couldn’t check the live catalogue right now. Open the Shop or try again shortly.", "Hindi ko makita ang kasalukuyang katalogo ngayon. Buksan ang Shop o subukang muli mamaya.")
      : null;
  }
}

module.exports = { answerCustomerCatalogQuestion };
