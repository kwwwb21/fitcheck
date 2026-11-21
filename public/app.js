const $ = (id) => document.getElementById(id);
const state = { person: null, personSend: null, personBox: null, garment: null };

// Shrink images in the browser so uploads stay small and fast.
function resizeImage(src, maxSide = 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; // flatten transparent product images onto white
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.92));
    };
    img.onerror = () => reject(new Error("That image couldn't be opened."));
    img.src = src;
  });
}

// Fit an image inside a 3:4 white frame (768x1024, the model's size) without stretching it.
function padTo3x4(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const W = 768, H = 1024;
      const scale = Math.min(W / img.width, H / img.height) * 0.95; // small margin around the garment
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(img, Math.round((W - w) / 2), Math.round((H - h) / 2), w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.92));
    };
    img.onerror = () => reject(new Error("That image couldn't be opened."));
    img.src = src;
  });
}

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error("That image couldn't be opened."));
  img.src = src;
});

// Widen or heighten the person photo to 3:4 by adding a blurred copy of the photo
// around it (no stretching, nothing cut off). Returns the padded image and where the
// original sits inside it, as fractions, so we can trim the result back afterwards.
async function padPerson(src) {
  const img = await loadImage(src);
  const W = 768, H = 1024;
  const scale = Math.min(W / img.width, H / img.height);
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const x = Math.round((W - w) / 2), y = Math.round((H - h) / 2);
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const cover = Math.max(W / img.width, H / img.height);
  ctx.filter = "blur(24px)";
  ctx.drawImage(img, (W - img.width * cover) / 2, (H - img.height * cover) / 2, img.width * cover, img.height * cover);
  ctx.filter = "none";
  ctx.drawImage(img, x, y, w, h);
  return { image: canvas.toDataURL("image/jpeg", 0.92), box: { x: x / W, y: y / H, w: w / W, h: h / H } };
}

// Cut the padding back off the model's result so it matches the original photo's shape.
async function trimResult(src, box) {
  const img = await loadImage(src);
  const sx = box.x * img.width, sy = box.y * img.height, sw = box.w * img.width, sh = box.h * img.height;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw); canvas.height = Math.round(sh);
  canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.92);
}

const readFile = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = "status " + kind;
}

function updateButton() {
  $("tryBtn").disabled = !(state.person && state.garment);
}

function setGarment(dataUrl) {
  state.garment = dataUrl;
  $("garmentPreview").src = dataUrl;
  $("garmentBox").hidden = false;
  $("garmentDrop").hidden = true;
  $("linkForm").hidden = true;
  updateButton();
}

function clearGarment() {
  state.garment = null;
  $("garmentBox").hidden = true;
  $("garmentPreview").removeAttribute("src");
  $("garmentDrop").hidden = false;
  $("linkForm").hidden = false;
  $("shirtUrl").value = "";
  $("garmentInput").value = "";
  updateButton();
}
$("changeShirt").addEventListener("click", () => { clearGarment(); setStatus(""); });

// Step 1: person photo
$("personInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    state.person = await resizeImage(await readFile(file));
    const padded = await padPerson(state.person);
    state.personSend = padded.image;
    state.personBox = padded.box;
    $("personPreview").src = state.person;
    $("personPreview").hidden = false;
    $("personPlaceholder").hidden = true;
    $("personDrop").classList.add("has-image");
    setStatus("");
  } catch (err) {
    setStatus(err.message, "error");
  }
  updateButton();
});

// Step 2: tabs
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $("tab-link").hidden = tab.dataset.tab !== "link";
    $("tab-upload").hidden = tab.dataset.tab !== "upload";
  });
});

// Step 2a: shirt link
$("linkForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("fetchBtn");
  btn.disabled = true;
  setStatus("Looking for the shirt on that page…");
  try {
    const res = await fetch("/api/extract-shirt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: $("shirtUrl").value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setGarment(await padTo3x4(data.image));
    setStatus("Found it. Check the picture is the right item.");
  } catch (err) {
    setStatus(err.message || "Couldn't read that link.", "error");
  } finally {
    btn.disabled = false;
  }
});

// Step 2b: shirt upload
$("garmentInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    setGarment(await padTo3x4(await readFile(file)));
    setStatus("");
  } catch (err) {
    setStatus(err.message, "error");
  }
});

// Step 3: try on
$("tryBtn").addEventListener("click", async () => {
  const btn = $("tryBtn");
  btn.disabled = true;
  btn.classList.add("loading");
  const started = Date.now();
  const tick = () => {
    const sec = Math.floor((Date.now() - started) / 1000);
    $("tryLabel").textContent = `Dressing you up… ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  };
  tick();
  const timer = setInterval(tick, 1000);
  setStatus("This usually takes 1–3 minutes on the free service. Keep this page open.");
  try {
    const res = await fetch("/api/tryon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        person: state.personSend,
        garment: state.garment,
        description: $("description").value,
        code: $("accessCode").value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    $("beforeImg").src = state.person;
    const after = await trimResult(data.image, state.personBox);
    $("afterImg").src = after;
    $("downloadLink").href = after;
    setSlider(50);
    $("resultCard").hidden = false;
    $("resultCard").scrollIntoView({ behavior: "smooth" });
    setStatus("");
  } catch (err) {
    setStatus(err.message || "Something went wrong.", "error");
  } finally {
    clearInterval(timer);
    btn.classList.remove("loading");
    $("tryLabel").textContent = "Try it on";
    updateButton();
  }
});

// Show the access-code field only if the server asks for one.
fetch("/api/config").then((r) => r.json()).then((c) => { $("codeBox").hidden = !c.needsCode; }).catch(() => {});

// Before/after slider
function setSlider(v) {
  $("slider").value = v;
  $("beforeLayer").style.clipPath = `inset(0 ${100 - v}% 0 0)`;
  $("divider").style.left = v + "%";
}
$("slider").addEventListener("input", (e) => setSlider(e.target.value));

// Start over with a different shirt (keeps the person photo)
$("againBtn").addEventListener("click", () => {
  clearGarment();
  $("description").value = "";
  $("resultCard").hidden = true;
  setStatus("");
  $("shirtUrl").closest(".card").scrollIntoView({ behavior: "smooth", block: "start" });
});

// Drag-and-drop onto the upload boxes
for (const [dropId, inputId] of [["personDrop", "personInput"], ["garmentDrop", "garmentInput"]]) {
  const drop = $(dropId);
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragover"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith("image/")) return setStatus("Please drop an image file.", "error");
    const input = $(inputId);
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change"));
  });
}
