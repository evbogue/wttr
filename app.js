import { apds } from "https://esm.sh/gh/evbogue/apds/apds.js";

const isHomePage = typeof window !== "undefined" &&
  window.location &&
  window.location.pathname === "/";

const escapeHtml = (str = "") =>
  String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

async function ensureKeypair() {
  async function currentKeypair() {
    if (typeof apds.keypair === "function") {
      try {
        const kp = await apds.keypair();
        if (kp) return kp;
      } catch {
        // ignore
      }
    }
    return "";
  }

  const existing = await currentKeypair();
  if (existing) return existing;

  const generator =
    typeof apds.generate === "function"
      ? apds.generate
      : typeof apds.generete === "function"
        ? apds.generete
        : null;

  if (!generator) return "";

  try {
    const kp = await generator();
    if (kp) {
      await apds.put("keypair", kp);
      await apds.put("secret", kp.substring(44));
      return kp;
    }
  } catch {
    // ignore generation failure
  }

  return "";
}

async function getSecretKey() {
  const kp = await ensureKeypair();
  if (kp?.substring) {
    return kp.substring(44);
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

function formatReplyCount(count = 0) {
  const value = Number(count) || 0;
  const label = value === 1 ? "reply" : "replies";
  return `${value} ${label}`;
}

function imageSrc(image) {
  if (!image) return "";
  if (typeof image === "string" && image.startsWith("data:")) return image;
  return `/blob/${image}`;
}

function updateReplyCountDisplay(target, delta = 0) {
  if (!target) return;
  const current = Number(target.dataset?.count || 0);
  const next = Math.max(0, current + delta);
  if (target.dataset) {
    target.dataset.count = String(next);
  }
  target.textContent = formatReplyCount(next);
}

function setReplyCountValue(hash = "", count = 0) {
  if (!hash) return;
  const el = document.getElementById(`reply-count-${hash}`);
  if (!el) return;
  const value = Math.max(0, Number(count) || 0);
  el.dataset.count = String(value);
  el.textContent = formatReplyCount(value);
}

let latestFeedTimestamp = 0;
let feedPollTimer = null;
let feedPollInFlight = false;

function commitLatestTimestamp(ts) {
  const numeric = Number(ts);
  if (!Number.isFinite(numeric)) return latestFeedTimestamp;
  if (numeric <= (latestFeedTimestamp || 0)) return latestFeedTimestamp;
  latestFeedTimestamp = numeric;
  const feedEl = document.getElementById("feed");
  if (feedEl) {
    feedEl.dataset.latestTs = String(numeric);
  }
  if (typeof window !== "undefined") {
    window.bttrLatestTs = latestFeedTimestamp;
  }
  return latestFeedTimestamp;
}

function updateLatestTimestampFromFeed() {
  if (typeof document === "undefined") return latestFeedTimestamp;
  const feedEl = document.getElementById("feed");
  if (!feedEl) return latestFeedTimestamp;
  let maxTs = latestFeedTimestamp || 0;
  feedEl.querySelectorAll(".message[data-ts]").forEach((node) => {
    const ts = Number(node.getAttribute("data-ts") || node.dataset.ts || 0);
    if (ts > maxTs) {
      maxTs = ts;
    }
  });
  if (maxTs) {
    commitLatestTimestamp(maxTs);
  }
  return latestFeedTimestamp;
}

function getLatestFeedTimestamp() {
  if (latestFeedTimestamp) return latestFeedTimestamp;
  return updateLatestTimestampFromFeed();
}

function createMessageElement({
  name = "anon",
  image = "",
  body = "",
  reply = "",
  replyto = "",
  timeHuman = "",
  blobHash = "",
  author = "",
  timestamp = "",
  replyCount = 0,
} = {}) {
  const wrapper = document.createElement("div");
  const isReply = Boolean(reply);
  wrapper.className = `message${isReply ? " reply" : ""} inline-generated`;
  wrapper.dataset.msgHash = blobHash || "";
  wrapper.dataset.author = author || "";
  wrapper.dataset.authorName = name || "anon";
  if (timestamp) {
    wrapper.dataset.ts = String(timestamp);
  }

  let avatar;
  if (image) {
    avatar = document.createElement("img");
    avatar.className = "avatar";
    avatar.src = imageSrc(image);
    avatar.alt = `${name}'s avatar`;
  } else {
    avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.style.background = "#ccc";
  }

  const content = document.createElement("div");
  content.className = "message-content";

  const header = document.createElement("div");
  header.className = "message-header";
  let nameNode;
  if (author) {
    const link = document.createElement("a");
    link.href = `/profile/${author}`;
    nameNode = link;
  } else {
    nameNode = document.createElement("span");
  }
  const strong = document.createElement("strong");
  strong.textContent = name || "anon";
  nameNode.appendChild(strong);

  const timeLink = document.createElement("a");
  timeLink.className = "pubkey";
  timeLink.href = blobHash ? `/message/${blobHash}` : "#";
  timeLink.textContent = timeHuman || "just now";

  header.appendChild(nameNode);
  header.appendChild(timeLink);

  const bodyDiv = document.createElement("div");
  bodyDiv.className = "body";
  bodyDiv.textContent = body;

  const replyMeta =
    reply
      ? (() => {
        const ref = document.createElement("div");
        ref.className = "message-reply-ref";
        const text = document.createTextNode("Replying to ");
        const link = document.createElement("a");
        link.href = `/message/${reply}`;
        link.textContent = (reply || "").slice(0, 8);
        ref.appendChild(text);
        ref.appendChild(link);
        if (replyto) {
          const sep = document.createTextNode(" · ");
          const span = document.createElement("span");
          span.className = "pubkey";
          span.textContent = replyto.slice(0, 10);
          ref.appendChild(sep);
          ref.appendChild(span);
        }
        return ref;
      })()
      : null;

  const actions = document.createElement("div");
  actions.className = "message-actions";
  const countLink = document.createElement("a");
  const initialCount = Math.max(0, Number(replyCount) || 0);
  countLink.className = "reply-count";
  countLink.dataset.count = String(initialCount);
  countLink.href = blobHash ? `/message/${blobHash}` : "#";
  countLink.textContent = formatReplyCount(initialCount);
  if (blobHash) {
    countLink.id = `reply-count-${blobHash}`;
  }

  const rawLink = document.createElement("a");
  rawLink.className = "raw-link";
  rawLink.href = blobHash ? `/blob/${blobHash}` : "#";
  rawLink.target = "_blank";
  rawLink.rel = "noopener noreferrer";
  rawLink.textContent = "Raw";

  const replyButton = document.createElement("button");
  replyButton.className = "reply-btn";
  replyButton.textContent = "Reply";
  replyButton.dataset.msgHash = blobHash || "";
  replyButton.dataset.author = author || "";
  replyButton.dataset.authorName = name || "anon";

  actions.appendChild(countLink);
  actions.appendChild(rawLink);
  actions.appendChild(replyButton);

  content.appendChild(header);
  if (replyMeta) content.appendChild(replyMeta);
  content.appendChild(bodyDiv);
  content.appendChild(actions);

  wrapper.appendChild(avatar);
  wrapper.appendChild(content);
  return wrapper;
}

function prependMessageToFeed(message = {}) {
  if (typeof document === "undefined") return;
  const list = document.getElementById("message-list");
  if (!list || !message?.blobHash) return;
  const existing = Array.from(list.querySelectorAll(".message")).find(
    (node) => node.dataset?.msgHash === message.blobHash,
  );
  if (existing) return;
  const element = createMessageElement(message);
  list.insertAdjacentElement("afterbegin", element);
  const empty = document.getElementById("feed-empty-state");
  empty?.remove();
  updateLatestTimestampFromFeed();
}

async function fetchFeedUpdates() {
  if (feedPollInFlight) return;
  if (typeof document === "undefined") return;
  const feedEl = document.getElementById("feed");
  if (!feedEl) return;
  const since = getLatestFeedTimestamp() || 0;
  feedPollInFlight = true;
  try {
    const response = await fetch(`/feed?format=json&since=${since}`);
    if (!response.ok) return;
    const data = await response.json();
    if (Array.isArray(data?.messages)) {
      data.messages
        .slice()
        .reverse()
        .forEach((msg) => prependMessageToFeed(msg));
    }
    if (Array.isArray(data?.replyCounts)) {
      data.replyCounts.forEach(({ hash, count }) => {
        setReplyCountValue(hash, count);
      });
    }
    commitLatestTimestamp(data?.latest);
  } catch {
    // ignore fetch errors
  } finally {
    feedPollInFlight = false;
  }
}

function startFeedPolling(intervalMs = 5000) {
  if (typeof window === "undefined") return;
  if (feedPollTimer) return;
  if (!document.getElementById("feed")) return;
  feedPollTimer = window.setInterval(fetchFeedUpdates, intervalMs);
}

// --- Avatar behavior (from wiredove) ---
async function avatarSpan() {
  await ensureKeypair();
  let pubkey = "";
  try {
    pubkey = (await apds.pubkey()) || "";
  } catch {
    pubkey = "";
  }

  let avatarImg = null;
  if (pubkey && typeof apds.visual === "function") {
    try {
      avatarImg = await apds.visual(pubkey);
    } catch {
      avatarImg = null;
    }
  }

  if (!avatarImg) {
    avatarImg = new Image();
    avatarImg.src =
      "data:image/gif;base64,R0lGODlhAQABAIAAAP///////ywAAAAAAQABAAACAUwAOw==";
  }
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
  await ensureKeypair();
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

let activeInlineReply = null;

function setActiveInlineReply(meta) {
  if (meta && meta.hash) {
    activeInlineReply = {
      hash: meta.hash,
      author: meta.author || "",
      authorName: meta.authorName || "",
    };
  } else {
    activeInlineReply = null;
  }
}

async function publishPayload(body, replyMeta = null) {
  if (!body) return { ok: false };
  let authorPub = "";
  let cachedName = "anon";
  try {
    await ensureKeypair();
    authorPub = (await apds.pubkey()) || "";
    cachedName = (await apds.get("name")) || cachedName;
  } catch {
    // ignore missing identity
  }
  let msghash = null;
  if (replyMeta?.reply) {
    try {
      msghash = await apds.compose(body, {
        reply: replyMeta.reply,
        replyto: replyMeta.replyto || "",
      });
    } catch {
      msghash = null;
    }
  }
  if (!msghash) {
    try {
      msghash = await apds.compose(body);
    } catch {
      return { ok: false };
    }
  }
  let sig = "";
  let blob = "";
  let blobHash = "";
  let ts = "";
  try {
    sig = await apds.get(msghash);
    const opened = await apds.open(sig);
    ts = opened.substring(0, 13);
    blobHash = opened.substring(13);
    blob = await apds.get(blobHash);
  } catch {
    return { ok: false };
  }

  try {
    await fetch("/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sig, blob }),
    });
  } catch {
    return { ok: false };
  }

  let parsed = {};
  try {
    parsed = await apds.parseYaml(blob);
  } catch {
    parsed = {};
  }
  let humanTime = "";
  try {
    humanTime = await apds.human(ts);
  } catch {
    humanTime = "just now";
  }

  return {
    ok: true,
    message: {
      blobHash,
      author: authorPub,
      name: parsed.name || cachedName,
      image: parsed.image || "",
      body: typeof parsed.body === "string" ? parsed.body : body,
      reply: replyMeta?.reply || parsed.reply || "",
      replyto: replyMeta?.replyto || parsed.replyto || "",
      timeHuman: humanTime || "just now",
      timestamp: ts || "",
      replyCount: 0,
    },
  };
}

function wireDefaultComposer() {
  const textarea = document.getElementById("msg");
  const button = document.getElementById("publishBtn");
  if (!textarea || !button) return;
  button.onclick = async () => {
    const body = textarea.value.trim();
    if (!body) return alert("Please write something.");
    const result = await publishPayload(body);
    if (result?.ok) {
      textarea.value = "";
      prependMessageToFeed(result.message);
      fetchFeedUpdates();
    }
  };
}

async function main() {
  await apds.start("wttr-lite");
  if (!isHomePage) return;
  const identityEl = document.getElementById("identity");
  if (!identityEl) return;
  await renderIdentity();
  wireDefaultComposer();
}

function createReplyComposer(meta = {}, targetMessage = null) {
  const wrapper = document.createElement("div");
  wrapper.className = "inline-reply-wrapper";
  wrapper.dataset.for = meta.hash || "";

  const composeBox = document.createElement("div");
  composeBox.className = "compose-box inline-reply-composer";

  const replyContext = document.createElement("div");
  replyContext.className = "reply-context";
  const label = document.createElement("span");
  const authorName = meta.authorName?.trim();
  const fallback =
    authorName || (meta.author || "").slice(0, 10) ||
    (meta.hash || "").slice(0, 8) ||
    "post";
  label.textContent = `Replying to ${fallback}`;

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel reply";
  cancelBtn.addEventListener("click", () => {
    wrapper.remove();
    if (activeInlineReply?.hash === meta.hash) {
      setActiveInlineReply(null);
    }
  });

  replyContext.appendChild(label);
  replyContext.appendChild(cancelBtn);

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Write a reply...";

  const publishBtn = document.createElement("button");
  publishBtn.type = "button";
  publishBtn.textContent = "Reply";
  publishBtn.addEventListener("click", async () => {
    const body = textarea.value.trim();
    if (!body) return alert("Please write something.");
    const result = await publishPayload(body, {
      reply: meta.hash,
      replyto: meta.author || "",
    });
    if (result?.ok) {
      textarea.value = "";
      const newMessageEl = createMessageElement(result.message);
      const parentCountEl = targetMessage?.querySelector(".reply-count");
      if (parentCountEl) {
        updateReplyCountDisplay(parentCountEl, 1);
      }
      if (wrapper.parentElement) {
        wrapper.replaceWith(newMessageEl);
      } else {
        wrapper.remove();
      }
      if (activeInlineReply?.hash === meta.hash) {
        setActiveInlineReply(null);
      }
    }
  });

  composeBox.appendChild(replyContext);
  composeBox.appendChild(textarea);
  composeBox.appendChild(publishBtn);
  wrapper.appendChild(composeBox);

  setActiveInlineReply(meta);

  return wrapper;
}

function ensureSiblingReplyContainer(messageEl) {
  if (!messageEl?.parentElement) return null;
  let next = messageEl.nextSibling;
  while (next && next.nodeType !== 1) {
    next = next.nextSibling;
  }
  if (next?.classList?.contains("reply-children")) {
    return next;
  }
  const container = document.createElement("div");
  container.className = "reply-children inline-replies";
  messageEl.parentElement.insertBefore(container, next || null);
  return container;
}

function getReplyInsertionContainer(messageEl) {
  if (!messageEl) return null;
  const nestedThread = messageEl.closest(".reply-thread");
  if (nestedThread && messageEl.classList.contains("reply")) {
    return ensureSiblingReplyContainer(messageEl);
  }
  const globalThread = document.querySelector(".reply-thread");
  if (globalThread && globalThread.previousElementSibling === messageEl) {
    globalThread.classList.remove("empty");
    if (!globalThread.querySelector("h3")) {
      globalThread.innerHTML = "<h3>Replies</h3>";
    }
    let container = globalThread.querySelector(".reply-children");
    if (!container) {
      container = document.createElement("div");
      container.className = "reply-children inline-replies";
      globalThread.appendChild(container);
    }
    return container;
  }
  if (nestedThread) {
    return ensureSiblingReplyContainer(messageEl);
  }
  return null;
}

function openInlineComposer(messageEl, meta) {
  if (!messageEl || !meta?.hash) return;
  const existing = Array.from(
    document.querySelectorAll(".inline-reply-wrapper"),
  ).find((node) => node.dataset?.for === meta.hash);
  if (existing) {
    const textarea = existing.querySelector("textarea");
    textarea?.focus();
    return;
  }
  const container = getReplyInsertionContainer(messageEl);
  const wrapper = createReplyComposer(meta, messageEl);
  if (container) {
    container.insertAdjacentElement("afterbegin", wrapper);
  } else {
    messageEl.insertAdjacentElement("afterend", wrapper);
  }
  const textarea = wrapper.querySelector("textarea");
  textarea?.focus();
}

function clearInlineReplyState() {
  document.querySelectorAll(".inline-reply-wrapper").forEach((node) =>
    node.remove()
  );
  setActiveInlineReply(null);
}

function reattachInlineComposer() {
  if (!activeInlineReply?.hash) return;
  const messageEl = Array.from(document.querySelectorAll(".message")).find(
    (el) => el.dataset?.msgHash === activeInlineReply.hash,
  );
  if (!messageEl) {
    clearInlineReplyState();
    return;
  }
  openInlineComposer(messageEl, activeInlineReply);
}

function handleReplyButtonClick(event) {
  const target = event?.target?.closest?.(".reply-btn");
  if (!target) return;
  event.preventDefault();
  const meta = {
    hash: target.dataset?.msgHash || target.getAttribute("data-msg-hash") || "",
    author: target.dataset?.author || target.getAttribute("data-author") || "",
    authorName: target.dataset?.authorName ||
      target.getAttribute("data-author-name") || "",
  };
  const messageEl = target.closest(".message");
  if (!meta.hash || !messageEl) return;
  openInlineComposer(messageEl, meta);
}

if (typeof document !== "undefined") {
  document.addEventListener("click", handleReplyButtonClick);
  document.body?.addEventListener("htmx:afterSwap", (event) => {
    const target = event?.target;
    if (target?.id === "feed" || target?.closest?.("#feed")) {
      startFeedPolling();
    }
    if (target?.id === "message-list" || target?.closest?.("#feed")) {
      updateLatestTimestampFromFeed();
    }
    if (!activeInlineReply?.hash) return;
    if (!target) return;
    const feedEl = document.getElementById("feed");
    if (!feedEl) return;
    if (target === feedEl || feedEl.contains(target)) {
      reattachInlineComposer();
    }
  });
}

main();
updateLatestTimestampFromFeed();
