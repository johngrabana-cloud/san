import sharp from "sharp";

const MAX_LENS_BYTES = 500_000;

function httpsUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

const shortText = (value, size) => typeof value === "string" ? value.trim().slice(0, size) : "";

async function fetchJson(url, options, signal) {
  const response = await fetch(url, { ...options, signal, redirect: "error" });
  if (!response.ok) {
    const state = {
      401: "key_or_plan", 403: "key_or_plan", 402: "quota_or_plan", 429: "quota_or_plan",
    }[response.status];
    throw new Error(state ?? "unavailable");
  }
  const result = await response.json();
  if (result.error || result.search_metadata?.status === "Error") throw new Error("unavailable");
  return result;
}

async function provider(key, search) {
  if (!key) return { status: "not_configured", results: [] };
  try {
    const results = await search(key, AbortSignal.timeout(10_000));
    return { status: results.length ? "found" : "no_results", results };
  } catch (error) {
    const status = ["key_or_plan", "quota_or_plan", "no_image"].includes(error?.message)
      ? error.message
      : "unavailable";
    return { status, results: [] };
  }
}

async function lens(key, signal, photo) {
  if (!photo) throw new Error("no_image");
  const image = Buffer.from(photo.data, "base64");
  const compressed = await sharp(image, { limitInputPixels: 25_000_000 })
    .rotate().resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 72 }).toBuffer();
  if (compressed.length > MAX_LENS_BYTES) throw new Error("no_image");

  const form = new FormData();
  form.set("api_key", key);
  form.set("image", new Blob([compressed], { type: "image/jpeg" }), "product.jpg");
  const upload = await fetchJson("https://serpapi.com/image", { method: "POST", body: form }, signal);
  const imageId = shortText(upload.image_id, 200);
  if (!imageId) throw new Error("unavailable");

  const url = new URL("https://serpapi.com/search.json");
  url.search = new URLSearchParams({
    api_key: key, engine: "google_lens", image_id: imageId, type: "visual_matches", safe: "active",
  });
  const result = await fetchJson(url, {}, signal);
  const matches = Array.isArray(result.visual_matches) ? result.visual_matches : [];
  return matches.slice(0, 16).map((match) => ({
    title: shortText(match?.title, 180),
    imageUrl: httpsUrl(match?.image) || httpsUrl(match?.thumbnail),
    sourceUrl: httpsUrl(match?.link),
    match: "similar",
  })).filter((match) => match.sourceUrl && match.imageUrl).slice(0, 5);
}

async function brave(key, signal, product) {
  const name = product.referenceName || product.name;
  const brand = product.referenceBrand || product.brand;
  const query = [name, name.toLowerCase().includes(brand.toLowerCase()) ? "" : brand,
    product.category].filter(Boolean).join(" ").slice(0, 350);
  if (!query) return [];
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.search = new URLSearchParams({ q: query, count: "6", result_filter: "web", safesearch: "strict" });
  const result = await fetchJson(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
  }, signal);
  const matches = Array.isArray(result.web?.results) ? result.web.results : [];
  return matches.slice(0, 6).map((match) => ({
    title: shortText(match?.title, 180),
    url: httpsUrl(match?.url),
    excerpt: shortText(match?.description, 480),
  })).filter((match) => match.url);
}

export async function searchProductHistory(product, photo) {
  const [imageSearch, webSearch] = await Promise.all([
    provider(process.env.SERPAPI_API_KEY, (key, signal) => lens(key, signal, photo)),
    provider(process.env.BRAVE_SEARCH_API_KEY, (key, signal) => brave(key, signal, product)),
  ]);
  return {
    imageMatches: imageSearch.results,
    webSources: webSearch.results,
    searchStatus: { lens: imageSearch.status, brave: webSearch.status },
  };
}
