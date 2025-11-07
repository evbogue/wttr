import { apds } from "https://esm.sh/gh/evbogue/apds/apds.js";

const escapeHtml = (str = "") =>
  String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

async function getSecretKey() {
  if (typeof apds.secret === "function") {
    try {
      return await apds.secret();
    } catch {
      // ignore
    }
  }
  if (typeof apds.privkey === "function") {
    try {
      return await apds.privkey();
    } catch {
      // ignore
    }
  }
  return (await apds.get("secret")) || "";
}

// --- Avatar behavior (from wiredove) ---
async function avatarSpan() {
  const avatarImg = await apds.visual(await apds.pubkey());
  const existingImage = await apds.get("image");

  if (existingImage) {
    avatarImg.src = await apds.get(existingImage);
  }

  avatarImg.classList = "avatar";
  const uploader = document.createElement("input");
  uploader.type = "file";
  uploader.style.display = "none";

  avatarImg.onclick = () => uploader.click();

  uploader.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();

    reader.onload = (ev) => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const img = new Image();
      img.onload = async () => {
        const size = 256;
        const maxDim = Math.max(img.width, img.height) || 1;
        const scale = Math.min(1, size / maxDim);
        const targetWidth = Math.round(img.width * scale) || size;
        const targetHeight = Math.round(img.height * scale) || size;
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
        const scaledImage = canvas.toDataURL("image/png");
        avatarImg.src = scaledImage;
        const hash = await apds.make(scaledImage);
        await apds.put("image", hash);
        await fetch("/blob", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ blob: scaledImage }),
        });
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
  return avatarImg;
}

// --- Render identity row ---
async function renderIdentity() {
  const identityRoot = document.getElementById("identity");
  if (!identityRoot) return;
  const name = (await apds.get("name")) || "anon";
  const pubkey = await apds.pubkey();
  const secret = await getSecretKey();
  identityRoot.innerHTML = "";

  const avatar = await avatarSpan();
  identityRoot.appendChild(avatar);

  const input = document.createElement("input");
  input.type = "text";
  input.value = name;
  input.placeholder = "Your name";
  input.onchange = async (e) => {
    await apds.put("name", e.target.value.trim());
  };
  identityRoot.appendChild(input);

  const keypairDiv = document.createElement("div");
  keypairDiv.className = "keypair";
  keypairDiv.innerHTML = `
    <div><strong>Public:</strong> <code>${escapeHtml(pubkey)}</code></div>
    <div><strong>Secret:</strong> <code>${escapeHtml(secret || "unavailable")}</code></div>
  `;
  identityRoot.appendChild(keypairDiv);
}

// --- Publish message (wiredove-style) ---
async function publishMessage() {
  const textarea = document.getElementById("msg");
  if (!textarea) return;
  const body = textarea.value.trim();
  if (!body) return alert("Please write something.");

  // Compose YAML and sign
  const msghash = await apds.compose(body);
  const sig = await apds.get(msghash);
  const opened = await apds.open(sig);
  const blobHash = opened.substring(13);
  const blob = await apds.get(blobHash);

  await fetch("/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sig, blob }),
  });

  textarea.value = "";
  if (window.htmx) {
    window.htmx.trigger(document.body, "refreshFeed");
  }
}

function wirePublishButton() {
  const button = document.getElementById("publishBtn");
  if (!button) return;
  button.onclick = publishMessage;
}

async function main() {
  const identityEl = document.getElementById("identity");
  if (!identityEl) return;
  await apds.start("wttr-lite");
  await renderIdentity();
  wirePublishButton();
}

main();
