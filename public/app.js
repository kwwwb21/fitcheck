const $ = (id) => document.getElementById(id);
const state = { person: null, garment: null };

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
  updateButton();
}

// Step 1: person photo
$("personInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    state.person = await resizeImage(await readFile(file));
    $("personPreview").src = state.person;
    $("personPreview").hidden = false;
    $("personPlaceholder").hidden = true;
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
  setStatus("Looking for the shirt on that page…", "loading");
  try {
    const res = await fetch("/api/extract-shirt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: $("shirtUrl").value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setGarment(await resizeImage(data.image));
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
    setGarment(await resizeImage(await readFile(file)));
    setStatus("");
  } catch (err) {
    setStatus(err.message, "error");
  }
});

// Step 3: try on
$("tryBtn").addEventListener("click", async () => {
  $("tryBtn").disabled = true;
  setStatus("Creating your picture… this usually takes 20–60 seconds.", "loading");
  try {
    const res = await fetch("/api/tryon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        person: state.person,
        garment: state.garment,
        category: $("category").value,
        description: $("description").value,
        code: $("accessCode").value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    $("beforeImg").src = state.person;
    $("afterImg").src = data.image;
    $("downloadLink").href = data.image;
    $("resultCard").hidden = false;
    $("resultCard").scrollIntoView({ behavior: "smooth" });
    setStatus("");
  } catch (err) {
    setStatus(err.message || "Something went wrong.", "error");
  } finally {
    updateButton();
  }
});

// Show the access-code field only if the server asks for one.
fetch("/api/config").then((r) => r.json()).then((c) => { $("codeBox").hidden = !c.needsCode; }).catch(() => {});
