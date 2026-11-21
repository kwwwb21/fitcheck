// Virtual try-on web app: serves the frontend and calls a free try-on model on Hugging Face.
const express = require("express");
const dns = require("dns").promises;
const net = require("net");
const path = require("path");

const PORT = process.env.PORT || 3000;
const HF_SPACE = process.env.HF_SPACE || "yisol/IDM-VTON"; // free public try-on demo
const HF_TOKEN = process.env.HF_TOKEN || ""; // optional free Hugging Face token for a bigger daily allowance
const ACCESS_CODE = process.env.ACCESS_CODE || ""; // optional password for the try-on button
const TRYONS_PER_DAY = Number(process.env.TRYONS_PER_IP_PER_DAY || 10);
const TRYONS_TOTAL_PER_DAY = Number(process.env.TRYONS_TOTAL_PER_DAY || 100);

const app = express();
app.set("trust proxy", 1); // behind the hosting provider's load balancer
app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => res.json({ needsCode: Boolean(ACCESS_CODE) }));

// Simple in-memory daily limits so one visitor can't use up the shared free allowance.
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

// ---------- Try-on via the free IDM-VTON demo on Hugging Face ----------

let clientPromise = null;
function tryonClient() {
  if (!clientPromise) {
    clientPromise = import("@gradio/client")
      .then(({ Client }) => Client.connect(HF_SPACE, HF_TOKEN ? { hf_token: HF_TOKEN } : {}))
      .catch((err) => { clientPromise = null; throw err; });
  }
  return clientPromise;
}

function dataUrlToBlob(dataUrl) {
  const [, type, b64] = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
  return new Blob([Buffer.from(b64, "base64")], { type });
}

function friendlyError(err) {
  const msg = String(err?.message || err || "");
  if (/quota|exceeded|ZeroGPU/i.test(msg)) return "The free try-on service has hit its usage limit for now. Please try again later.";
  if (/queue|busy|timeout|timed out/i.test(msg)) return "The free try-on service is busy right now. Please try again in a few minutes.";
  if (/sleep|paused|building|not running|503/i.test(msg)) return "The free try-on service is starting up or unavailable. Please try again in a minute.";
  return "The try-on didn't work. Please try a different photo or try again later.";
}

app.post("/api/tryon", async (req, res) => {
  const { person, garment, description } = req.body || {};
  const isImg = (s) => typeof s === "string" && /^data:image\/[a-z+.-]+;base64,/.test(s);
  if (!isImg(person) || !isImg(garment)) return res.status(400).json({ error: "Both a photo and a shirt image are required." });
  if (ACCESS_CODE && req.body.code !== ACCESS_CODE) return res.status(401).json({ error: "Wrong access code." });
  const limited = checkLimit(req.ip);
  if (limited) return res.status(429).json({ error: limited });

  try {
    const { handle_file } = await import("@gradio/client");
    const client = await tryonClient();
    const result = await client.predict("/tryon", {
      dict: { background: handle_file(dataUrlToBlob(person)), layers: [], composite: null },
      garm_img: handle_file(dataUrlToBlob(garment)),
      garment_des: String(description || "a shirt").slice(0, 200),
      is_checked: true, // auto-mask the clothing area
      is_checked_crop: false,
      denoise_steps: 30,
      seed: 42,
    });
    const out = Array.isArray(result.data) ? result.data[0] : result.data;
    const url = typeof out === "string" ? out : out?.url;
    if (!url) throw new Error("No image returned");

    // Download the result so the browser gets a lasting image, not a temporary link.
    const img = await fetch(url, { headers: HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {} });
    if (!img.ok) throw new Error(`Result download failed (${img.status})`);
    const type = (img.headers.get("content-type") || "image/png").split(";")[0];
    const buf = Buffer.from(await img.arrayBuffer());
    res.json({ image: `data:${type};base64,${buf.toString("base64")}` });
  } catch (err) {
    console.error("Try-on failed:", err?.message || err);
    res.status(502).json({ error: friendlyError(err) });
  }
});

module.exports = { findProductImage, isPrivateIp };

if (require.main === module) app.listen(PORT, () => {
  console.log(`Try-on app running at http://localhost:${PORT}`);
});
