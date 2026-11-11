const normalizeCatalogImageUrl = (value) => {
  const image = String(value || "").trim();
  if (!image) return "";
  if (image.length > 2048) return null;
  try {
    const url = new URL(image);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    if (/^(?:www\.)?google\.com$/i.test(url.hostname) && url.pathname.startsWith("/aclk")) return null;
    return url.href;
  } catch {
    return null;
  }
};

module.exports = { normalizeCatalogImageUrl };
