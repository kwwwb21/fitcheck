// Virtual try-on web app: serves the frontend and proxies to Replicate.
const express = require("express");
const dns = require("dns").promises;
const net = require("net");
const path = require("path");

const PORT = process.env.PORT || 3000;
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const MODEL = process.env.TRYON_MODEL || "cuuupid/idm-vton";
const REPLICATE = "https://api.replicate.com/v1";
const ACCESS_CODE = process.env.ACCESS_CODE || ""; // optional password for the try-on button
const TRYONS_PER_DAY = Number(process.env.TRYONS_PER_IP_PER_DAY || 10);
const TRYONS_TOTAL_PER_DAY = Number(process.env.TRYONS_TOTAL_PER_DAY || 100);

const app = express();
app.set("trust proxy", 1); // behind the hosting provider's load balancer
app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => res.json({ needsCode: Boolean(ACCESS_CODE) }));

// Simple in-memory daily limits so a public link can't run up the Replicate bill.
const usage = { day: "", total: 0, byIp: new Map() };
function checkLimit(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (usage.day !== today) Object.assign(usage, { day: today, total: 0, byIp: new Map() });
  if (usage.total >= TRYONS_TOTAL_PER_DAY) return "The app has reached its daily limit. Please come back tomorrow.";
  const n = usage.byIp.get(ip) || 0;
  if (n >= TRYONS_PER_DAY) return `You've used all ${TRYONS_PER_DAY} try-ons for today. Please come back tomorrow.`;
  usage.byIp.set(ip, n + 1);
  usage.total++;
  return null;
}

// ---------- Shirt link -> product image ----------

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

// Refuse links that point at internal/private addresses.
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("That doesn't look like a valid link."); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only http and https links are supported.");
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error("Couldn't find that website.");
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error("That link isn't allowed.");
  return u;
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x2F;/g, "/");
}

function findProductImage(html, base) {
  const candidates = [];
  const metaRe = /<meta\s+[^>]*>/gi;
  for (const tag of html.match(metaRe) || []) {
    const key = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const content = (tag.match(/content\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!key || !content) continue;
    if (/^(og:image(:secure_url|:url)?|twitter:image(:src)?)$/i.test(key)) candidates.push(content);
  }
  // JSON-LD Product data
  const ldRe = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRe.exec(html))) {
    try {
      const stack = [JSON.parse(m[1].trim())];
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== "object") continue;
        if (Array.isArray(node)) { stack.push(...node); continue; }
        if (node["@graph"]) stack.push(node["@graph"]);
        const type = [].concat(node["@type"] || []);
        if (type.includes("Product") && node.image) {
          const img = [].concat(node.image)[0];
          candidates.unshift(typeof img === "string" ? img : img.url || img.contentUrl);
        }
      }
    } catch { /* ignore malformed JSON-LD */ }
  }
  for (const c of candidates) {
    if (!c) continue;
    try { return new URL(decodeEntities(c), base).href; } catch {}
  }
  return null;
}

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchLimited(url, maxBytes) {
  await assertPublicUrl(url);
  const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow", signal: AbortSignal.timeout(15000) });
  await assertPublicUrl(res.url); // re-check after redirects
  if (!res.ok) throw new Error(`The shop returned an error (${res.status}). Try uploading the shirt image instead.`);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { reader.cancel(); break; }
    chunks.push(value);
  }
  return { res, buf: Buffer.concat(chunks) };
}

app.post("/api/extract-shirt", async (req, res) => {
  try {
    const link = String(req.body?.url || "").trim();
    const { res: page, buf } = await fetchLimited(link, 4 * 1024 * 1024);
    const type = page.headers.get("content-type") || "";

    let imageUrl;
    if (type.startsWith("image/")) {
      imageUrl = page.url; // the link was already a direct image
    } else {
      imageUrl = findProductImage(buf.toString("utf8"), page.url);
      if (!imageUrl) throw new Error("Couldn't find a product image on that page. Try uploading the shirt image instead.");
    }

    // Download the image so the browser can preview it and we can send it on to the model.
    const { res: imgRes, buf: imgBuf } = await fetchLimited(imageUrl, 10 * 1024 * 1024);
    const imgType = (imgRes.headers.get("content-type") || "image/jpeg").split(";")[0];
    if (!imgType.startsWith("image/")) throw new Error("The product image couldn't be downloaded. Try uploading it instead.");
    res.json({ image: `data:${imgType};base64,${imgBuf.toString("base64")}`, source: imageUrl });
  } catch (err) {
    res.status(400).json({ error: err.message || "Couldn't read that link." });
  }
});

// ---------- Try-on via Replicate ----------

let cachedVersion = null;
async function modelVersion() {
  if (cachedVersion) return cachedVersion;
  const r = await fetch(`${REPLICATE}/models/${MODEL}`, { headers: { Authorization: `Bearer ${REPLICATE_TOKEN}` } });
  if (!r.ok) throw new Error(`Couldn't look up the try-on model (${r.status}).`);
  const data = await r.json();
  cachedVersion = data.latest_version?.id;
  if (!cachedVersion) throw new Error("The try-on model has no published version.");
  return cachedVersion;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.post("/api/tryon", async (req, res) => {
  if (!REPLICATE_TOKEN) return res.status(500).json({ error: "The server has no REPLICATE_API_TOKEN set." });
  const { person, garment, description, category } = req.body || {};
  const isImg = (s) => typeof s === "string" && /^data:image\/[a-z+.-]+;base64,/.test(s);
  if (!isImg(person) || !isImg(garment)) return res.status(400).json({ error: "Both a photo and a shirt image are required." });
  if (ACCESS_CODE && req.body.code !== ACCESS_CODE) return res.status(401).json({ error: "Wrong access code." });
  const limited = checkLimit(req.ip);
  if (limited) return res.status(429).json({ error: limited });

  try {
    const version = await modelVersion();
    const headers = { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json", Prefer: "wait=55" };
    const create = await fetch(`${REPLICATE}/predictions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        version,
        input: {
          human_img: person,
          garm_img: garment,
          garment_des: String(description || "a shirt").slice(0, 200),
          category: ["upper_body", "lower_body", "dresses"].includes(category) ? category : "upper_body",
          crop: false,
          steps: 30,
          seed: 42,
        },
      }),
    });
    let pred = await create.json();
    if (!create.ok) throw new Error(pred.detail || `Replicate error (${create.status}).`);

    const deadline = Date.now() + 4 * 60 * 1000;
    while (!["succeeded", "failed", "canceled"].includes(pred.status)) {
      if (Date.now() > deadline) throw new Error("The try-on took too long. Please try again.");
      await sleep(2000);
      const poll = await fetch(pred.urls.get, { headers: { Authorization: `Bearer ${REPLICATE_TOKEN}` } });
      pred = await poll.json();
    }
    if (pred.status !== "succeeded") throw new Error(pred.error ? `The try-on failed: ${pred.error}` : "The try-on failed.");

    const output = Array.isArray(pred.output) ? pred.output[0] : pred.output;
    res.json({ image: output });
  } catch (err) {
    res.status(502).json({ error: err.message || "Something went wrong." });
  }
});

module.exports = { findProductImage, isPrivateIp };

if (require.main === module) app.listen(PORT, () => {
  console.log(`Try-on app running at http://localhost:${PORT}`);
  if (!REPLICATE_TOKEN) console.warn("Warning: REPLICATE_API_TOKEN is not set; try-on requests will fail.");
});
