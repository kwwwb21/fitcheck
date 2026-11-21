// Virtual try-on web app: serves the frontend and calls a free try-on model on Hugging Face.
const express = require("express");
const dns = require("dns").promises;
const net = require("net");
const path = require("path");

const PORT = process.env.PORT || 3000;
const HF_SPACE = process.env.HF_SPACE || "yisol/IDM-VTON"; // free public try-on demo
const HF_TOKEN = process.env.HF_TOKEN || ""; // optional free Hugging Face token for a bigger daily allowance
// If a Replicate token is set, try-ons use Replicate (paid per use, no daily cap) instead of Hugging Face.
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const REPLICATE_MODEL = process.env.REPLICATE_MODEL || "cuuupid/idm-vton";
const REPLICATE = "https://api.replicate.com/v1";
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

// ---------- Try-on via Replicate (paid per use) ----------

let replicateVersion = null;
async function getReplicateVersion() {
  if (replicateVersion) return replicateVersion;
  const r = await fetch(`${REPLICATE}/models/${REPLICATE_MODEL}`, { headers: { Authorization: `Bearer ${REPLICATE_TOKEN}` } });
  if (!r.ok) throw new Error(`Replicate model lookup failed (${r.status})`);
  replicateVersion = (await r.json()).latest_version?.id;
  if (!replicateVersion) throw new Error("Replicate model has no published version");
  return replicateVersion;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryOnReplicate(person, garment, description) {
  const auth = { Authorization: `Bearer ${REPLICATE_TOKEN}` };
  const create = await fetch(`${REPLICATE}/predictions`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", Prefer: "wait=55" },
    body: JSON.stringify({
      version: await getReplicateVersion(),
      input: {
        human_img: person,
        garm_img: garment,
        garment_des: description,
        category: "upper_body",
        crop: false, // the browser already pads the photo to 3:4
        steps: 30,
        seed: 42,
      },
    }),
  });
  let pred = await create.json();
  if (!create.ok) {
    const err = new Error(`Replicate ${create.status}: ${pred.detail || pred.title || "error"}`);
    err.status = create.status;
    throw err;
  }
  const deadline = Date.now() + 4 * 60 * 1000;
  while (!["succeeded", "failed", "canceled"].includes(pred.status)) {
    if (Date.now() > deadline) throw new Error("Replicate timed out");
    await sleep(2000);
    pred = await (await fetch(pred.urls.get, { headers: auth })).json();
  }
  if (pred.status !== "succeeded") throw new Error(`Replicate prediction ${pred.status}: ${pred.error || ""}`);
  const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  if (!out) throw new Error("No image returned");
  return { url: out, headers: {} };
}

async function tryOnHuggingFace(person, garment, description) {
  const { handle_file } = await import("@gradio/client");
  const client = await tryonClient();
  const result = await client.predict("/tryon", {
    dict: { background: handle_file(dataUrlToBlob(person)), layers: [], composite: null },
    garm_img: handle_file(dataUrlToBlob(garment)),
    garment_des: description,
    is_checked: true, // auto-mask the clothing area
    is_checked_crop: false, // the browser already pads the photo to 3:4, so the model sees the whole outfit
    denoise_steps: 30,
    seed: 42,
  });
  const out = Array.isArray(result.data) ? result.data[0] : result.data;
  const url = typeof out === "string" ? out : out?.url;
  if (!url) throw new Error("No image returned");
  return { url, headers: HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {} };
}

function replicateError(err) {
  const msg = String(err?.message || "");
  if (err?.status === 401) return "The try-on service isn't set up correctly (bad Replicate token).";
  if (err?.status === 402 || /billing|credit|payment/i.test(msg)) return "The try-on service needs billing set up on Replicate.";
  if (err?.status === 429) return "The try-on service is busy. Please try again in a minute.";
  if (/timed out/i.test(msg)) return "The try-on took too long. Please try again.";
  return "The try-on didn't work. Please try a different photo or try again later.";
}

app.post("/api/tryon", async (req, res) => {
  const { person, garment, description } = req.body || {};
  const isImg = (s) => typeof s === "string" && /^data:image\/[a-z+.-]+;base64,/.test(s);
  if (!isImg(person) || !isImg(garment)) return res.status(400).json({ error: "Both a photo and a shirt image are required." });
  if (ACCESS_CODE && req.body.code !== ACCESS_CODE) return res.status(401).json({ error: "Wrong access code." });
  const limited = checkLimit(req.ip);
  if (limited) return res.status(429).json({ error: limited });

  const desc = String(description || "a shirt").slice(0, 200);
  try {
    const { url, headers } = REPLICATE_TOKEN
      ? await tryOnReplicate(person, garment, desc)
      : await tryOnHuggingFace(person, garment, desc);

    // Download the result so the browser gets a lasting image (and can trim it), not a temporary link.
    const img = await fetch(url, { headers });
    if (!img.ok) throw new Error(`Result download failed (${img.status})`);
    const type = (img.headers.get("content-type") || "image/png").split(";")[0];
    const buf = Buffer.from(await img.arrayBuffer());
    res.json({ image: `data:${type};base64,${buf.toString("base64")}` });
  } catch (err) {
    console.error("Try-on failed:", err?.message || err);
    res.status(502).json({ error: REPLICATE_TOKEN ? replicateError(err) : friendlyError(err) });
  }
});

module.exports = { findProductImage, isPrivateIp };

if (require.main === module) app.listen(PORT, () => {
  console.log(`Try-on app running at http://localhost:${PORT}`);
  if (REPLICATE_TOKEN) console.log(`Try-on service: Replicate (${REPLICATE_MODEL}), token found`);
  else console.log(HF_TOKEN ? "Try-on service: Hugging Face, token found (using your account's free allowance)" : "Try-on service: Hugging Face, token NOT SET (using the small anonymous allowance)");
});
