// wttr server — YAML via apds.createYaml/parseYaml, ts from opened
// Run: deno run --allow-net --allow-read --allow-write serve.js

import { apds } from "https://esm.sh/gh/evbogue/apds/apds.js";
import { serveDir } from "https://deno.land/std@0.224.0/http/file_server.ts";

await apds.start("wttr-server");
const PORT = 8000;

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;

  // Serve static frontend
  if (
    req.method === "GET" &&
    (path === "/" ||
      path.endsWith(".html") ||
      path.endsWith(".css") ||
      path.endsWith(".js"))
  ) {
    return serveDir(req, { quiet: true, fsRoot: "." });
  }

  // Blob route: returns whatever blob data is stored (YAML or base64 image)
  if (req.method === "GET" && path.startsWith("/blob/")) {
    const hash = path.slice("/blob/".length);
    const blob = await apds.get(hash);
    if (!blob) return new Response("Not found", { status: 404 });
    if (typeof blob === "string" && blob.startsWith("data:")) {
      const match = blob.match(/^data:([^;]+);base64,(.*)$/);
      if (match) {
        const [, mime, data] = match;
        const binary = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        return new Response(binary, { headers: { "Content-Type": mime } });
      }
    }
    return new Response(blob, { headers: { "Content-Type": "text/plain" } });
  }

  // Store arbitrary blob payloads (e.g., avatars) on the server
  if (req.method === "POST" && path === "/blob") {
    const { blob } = await req.json();
    if (!blob) {
      return new Response(JSON.stringify({ error: "Missing blob" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const hash = await apds.make(blob);
    return new Response(JSON.stringify({ hash }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Atomic publish: store blob, then add sig
  if (req.method === "POST" && path === "/publish") {
    const { sig, blob } = await req.json();
    if (!sig || !blob) {
      return new Response(JSON.stringify({ error: "Missing sig/blob" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    await apds.make(blob);
    const opened = await apds.open(sig);
    const blobHash = opened?.substring?.(13) || "";
    const ok = await apds.add(sig);
    if (ok) {
      let summary = "";
      let pubkeyShort = "unknown";
      try {
        const { name, body } = await parseMessageBlob(blob);
        const preview =
          body.length > 140 ? `${body.slice(0, 137)}…` : body || "<empty>";
        summary = `${name}: ${preview}`;
        const openedLog = await apds.getOpenedLog();
        const entry = openedLog?.find?.(
          (item) => (item.opened || "").substring(13) === blobHash
        );
        const pubkey = entry?.author || "";
        pubkeyShort = pubkey ? pubkey.slice(0, 10) : "unknown";
      } catch {
        summary = "(unparsable message)";
      }
      console.log(`🌤 wttr: stored new message [${pubkeyShort}] — ${summary}`);
    }
    return new Response(JSON.stringify({ ok }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Global feed
  if (req.method === "GET" && path === "/feed") {
    return renderFeed({ request: req });
  }

  // Profile feed
  if (req.method === "GET" && path.startsWith("/profile/")) {
    const pubkey = path.slice("/profile/".length);
    return renderFeed({
      filterAuthor: pubkey,
      heading: `Posts by ${pubkey}`,
      request: req,
    });
  }

  // Single message view
  if (req.method === "GET" && path.startsWith("/message/")) {
    const hash = path.slice("/message/".length);
    return renderMessage(hash);
  }

  return new Response("Not found", { status: 404 });
});

// Helper: given a YAML blob, parse it into { name, image, body }
async function parseMessageBlob(blob) {
  let obj = {};
  try {
    obj = await apds.parseYaml(blob);
  } catch {
    obj = {};
  }
  return {
    name: obj.name || "anon",
    image: obj.image || "",
    body: obj.body || "",
    reply: obj.reply || "",
    replyto: obj.replyto || "",
  };
}

async function collectMessageData() {
  const openedLog = await apds.getOpenedLog();
  const messages = [];
  const replyCounts = new Map();
  const replyChildren = new Map();
  const messageIndex = new Map();

  if (!openedLog?.length) {
    return { openedLog: [], messages, replyCounts, replyChildren, messageIndex };
  }

  for (const entry of openedLog) {
    const openedStr = entry.opened || "";
    const ts = openedStr.substring(0, 13);
    const blobHash = openedStr.substring(13);
    if (!blobHash) continue;

    const blob = await apds.get(blobHash);
    if (!blob) continue;

    const meta = await parseMessageBlob(blob);
    const message = {
      entry,
      blob,
      blobHash,
      meta,
      ts,
      author: entry.author || "",
    };
    messages.push(message);
    messageIndex.set(blobHash, message);

    const parentHash = meta.reply || "";
    if (parentHash) {
      replyCounts.set(parentHash, (replyCounts.get(parentHash) || 0) + 1);
      const children = replyChildren.get(parentHash) || [];
      children.push(message);
      replyChildren.set(parentHash, children);
    }
  }

  return { openedLog, messages, replyCounts, replyChildren, messageIndex };
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatReplyCount(count = 0) {
  const value = Number(count) || 0;
  const label = value === 1 ? "reply" : "replies";
  return `${value} ${label}`;
}

function isHxRequest(request) {
  return request?.headers?.get("hx-request") === "true";
}

function htmlResponse(body) {
  return new Response(body, { headers: { "Content-Type": "text/html" } });
}

function renderPage({ title = "wttr", content = "" } = {}) {
  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${safeTitle}</title>
      <link rel="stylesheet" href="/style.css" />
      <script src="https://unpkg.com/htmx.org@1.9.10"></script>
    </head>
    <body>
      <header>
        <a class="home-link" href="/">wttr 🪶</a>
        <a class="github-link" href="https://github.com/evbogue/wttr" target="_blank" rel="noopener noreferrer">GitHub</a>
      </header>
      <main class="page">
        ${content}
      </main>
      <script type="module" src="/app.js"></script>
    </body>
  </html>`;
}

function imageSrc(image) {
  if (!image) return "";
  if (typeof image === "string" && image.startsWith("data:")) {
    return image;
  }
  return `/blob/${image}`;
}

function appShell({
  feedInner = "",
  feedEndpoint = "/feed",
  enableHx = true,
  showIdentity = false,
  showCompose = false,
} = {}) {
  const safeEndpoint = feedEndpoint ? escapeHtml(feedEndpoint) : "";
  const hxAttrs =
    enableHx && feedEndpoint
      ? `data-feed-endpoint="${safeEndpoint}" hx-get="${safeEndpoint}" hx-trigger="load"`
      : "";
  const identityBlock = showIdentity
    ? `<div id="identity" class="identity"><i>Loading identity...</i></div>`
    : "";
  const composeBlock = showCompose
    ? `<div class="compose-box">
      <textarea id="msg" placeholder="What are you doing in this world?"></textarea><br>
      <button id="publishBtn">Publish</button>
    </div>`
    : "";
  return `
    ${identityBlock}
    ${composeBlock}
    <div id="feed" class="feed" ${hxAttrs}>
      ${feedInner}
    </div>
  `;
}

async function buildFeedMessageHtml(msg, replyCounts) {
  const { meta, blobHash, author, ts } = msg;
  const { name, image, body, reply, replyto } = meta;
  const authorUrl = `/profile/${author}`;
  const timeHuman = ts ? await apds.human(ts) : "";
  const safeName = escapeHtml(name);
  const safeBody = escapeHtml(body);
  const safeTime = escapeHtml(timeHuman);
  const safeAuthor = escapeHtml(author);
  const imgSrc = imageSrc(image);
  const safeMsgHash = escapeHtml(blobHash);
  const safeReplyHash = reply ? escapeHtml(reply) : "";
  const safeReplyPreview = reply ? escapeHtml(reply.slice(0, 8)) : "";
  const safeReplyTo = replyto ? escapeHtml(replyto.slice(0, 10)) : "";
  const replyCount = replyCounts.get(blobHash) || 0;
  const replyCountLabel = escapeHtml(formatReplyCount(replyCount));
  const safeRawUrl = escapeHtml(`/blob/${blobHash}`);
  const safeMsgUrl = escapeHtml(`/message/${blobHash}`);
  const safeAuthorUrl = escapeHtml(authorUrl);
  const safeTs = escapeHtml(ts || "");
  const replyCountId = escapeHtml(`reply-count-${blobHash}`);

  const imgTag = image
    ? `<img src="${escapeHtml(imgSrc)}" class="avatar" alt="${safeName}'s avatar">`
    : `<div class="avatar" style="background:#ccc"></div>`;
  const replyMeta = reply
    ? `<div class="message-reply-ref">
        Replying to <a href="/message/${safeReplyHash}">${safeReplyPreview}</a>${
      replyto ? ` · <span class="pubkey">${safeReplyTo}</span>` : ""
    }
      </div>`
    : "";
  const actions = `
    <div class="message-actions">
      <a
        id="${replyCountId}"
        class="reply-count"
        data-count="${replyCount}"
        href="${safeMsgUrl}"
      >${replyCountLabel}</a>
      <a class="raw-link" href="${safeRawUrl}" target="_blank" rel="noopener noreferrer">Raw</a>
      <button
        class="reply-btn"
        data-msg-hash="${safeMsgHash}"
        data-author="${safeAuthor}"
        data-author-name="${safeName}"
      >Reply</button>
    </div>`;

  return `
    <div class="message" data-msg-hash="${safeMsgHash}" data-author="${safeAuthor}" data-author-name="${safeName}" data-ts="${safeTs}">
      ${imgTag}
      <div class="message-content">
        <div class="message-header">
          <a href="${safeAuthorUrl}"><strong>${safeName}</strong></a>
          <a href="${safeMsgUrl}" class="pubkey">${safeTime}</a>
        </div>
        ${replyMeta}
        <div class="body">${safeBody}</div>
        ${actions}
      </div>
    </div>`;
}

// Feed renderer (global or per-profile)
async function renderFeed({
  filterAuthor = null,
  heading = "wttr feed",
  request = null,
} = {}) {
  const { messages, replyCounts } = await collectMessageData();
  const endpoint = filterAuthor ? `/profile/${filterAuthor}` : "/feed";
  const relevantMessages = filterAuthor
    ? messages.filter((msg) => msg.author === filterAuthor)
    : messages.slice();

  const requestUrl = request ? new URL(request.url) : null;
  const format = requestUrl?.searchParams?.get("format") || "html";
  const sinceParam = requestUrl?.searchParams?.get("since");
  const sinceRaw = sinceParam ? Number(sinceParam) : null;
  const sinceValue = Number.isFinite(sinceRaw) ? sinceRaw : 0;

  if (format === "json") {
    const newMessages = relevantMessages.filter(
      (msg) => Number(msg.ts || 0) > sinceValue,
    );
    const payload = await Promise.all(
      newMessages
        .slice()
        .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
        .map(async (msg) => {
          const { meta, blobHash, author, ts } = msg;
          const {
            name = "anon",
            image = "",
            body = "",
            reply = "",
            replyto = "",
          } = meta;
          const timeHuman = ts ? await apds.human(ts) : "";
          return {
            blobHash,
            author,
            timestamp: ts || "",
            name,
            image,
            body,
            reply,
            replyto,
            timeHuman,
            replyCount: replyCounts.get(blobHash) || 0,
          };
        }),
    );

    const parentUpdates = Array.from(
      newMessages.reduce((map, msg) => {
        const parentHash = msg.meta?.reply;
        if (!parentHash || map.has(parentHash)) return map;
        map.set(parentHash, replyCounts.get(parentHash) || 0);
        return map;
      }, new Map()),
    ).map(([hash, count]) => ({ hash, count }));

    const latestCandidate = payload.reduce(
      (max, item) => Math.max(max, Number(item.timestamp || 0) || 0),
      sinceValue,
    );

    return new Response(
      JSON.stringify({
        latest: latestCandidate,
        messages: payload,
        replyCounts: parentUpdates,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  let feedContent = `
    <section class="feed-container">
      <h2>${escapeHtml(heading)}</h2>
      <div class="message-list" id="message-list">
        <div class="empty-feed" id="feed-empty-state"><i>No posts yet.</i></div>
      </div>
    </section>`;

  if (relevantMessages.length) {
    const htmlParts = await Promise.all(
      relevantMessages
        .slice()
        .reverse()
        .map((msg) => buildFeedMessageHtml(msg, replyCounts)),
    );

    feedContent = `
      <section class="feed-container">
        <h2>${escapeHtml(heading)}</h2>
        <div class="message-list" id="message-list">
          ${htmlParts.join("")}
        </div>
      </section>`;
  }

  if (isHxRequest(request)) {
    return htmlResponse(feedContent);
  }

  return htmlResponse(
    renderPage({
      title: heading,
      content: appShell({
        feedInner: feedContent,
        feedEndpoint: endpoint,
        showIdentity: false,
        showCompose: false,
      }),
    })
  );
}

async function renderReplyThread({
  parentHash,
  replyChildren,
  replyCounts,
  depth = 1,
} = {}) {
  const children = replyChildren.get(parentHash);
  if (!children?.length) return "";

  const sorted = children
    .slice()
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));

  const parts = await Promise.all(
    sorted.map(async (child) => {
      const { meta, blobHash, author, ts } = child;
      const { name, image, body, reply, replyto } = meta;
      const timeHuman = ts ? await apds.human(ts) : "";
      const safeTime = escapeHtml(timeHuman);
      const safeName = escapeHtml(name);
      const safeBody = escapeHtml(body);
      const safeAuthor = escapeHtml(author);
      const imgSrc = imageSrc(image);
      const safeMsgHash = escapeHtml(blobHash);
      const safeMsgUrl = escapeHtml(`/message/${blobHash}`);
      const authorUrl = `/profile/${author}`;
      const safeAuthorUrl = escapeHtml(authorUrl);
      const safeReplyHash = reply ? escapeHtml(reply) : "";
      const safeReplyPreview = reply ? escapeHtml(reply.slice(0, 8)) : "";
      const safeReplyTo = replyto ? escapeHtml(replyto.slice(0, 10)) : "";
      const replyCount = replyCounts.get(blobHash) || 0;
      const replyCountLabel = escapeHtml(formatReplyCount(replyCount));
      const safeRawUrl = escapeHtml(`/blob/${blobHash}`);

      const imgTag = image
        ? `<img src="${escapeHtml(imgSrc)}" class="avatar" alt="${safeName}'s avatar">`
        : `<div class="avatar" style="background:#ccc"></div>`;
      const replyMeta = reply
        ? `<div class="message-reply-ref">
            Replying to <a href="/message/${safeReplyHash}">${safeReplyPreview}</a>${
          replyto ? ` · <span class="pubkey">${safeReplyTo}</span>` : ""
        }
          </div>`
        : "";
      const nested = await renderReplyThread({
        parentHash: blobHash,
        replyChildren,
        replyCounts,
        depth: depth + 1,
      });
      const actions = `
        <div class="message-actions">
          <a class="reply-count" data-count="${replyCount}" href="${safeMsgUrl}">${replyCountLabel}</a>
          <a class="raw-link" href="${safeRawUrl}" target="_blank" rel="noopener noreferrer">Raw</a>
          <button
            class="reply-btn"
            data-msg-hash="${safeMsgHash}"
            data-author="${safeAuthor}"
            data-author-name="${safeName}"
          >Reply</button>
        </div>`;

      return `
        <div class="message reply" data-msg-hash="${safeMsgHash}" data-author="${safeAuthor}" data-author-name="${safeName}">
          ${imgTag}
          <div class="message-content">
            <div class="message-header">
              <a href="${safeAuthorUrl}"><strong>${safeName}</strong></a>
              <a href="${safeMsgUrl}" class="pubkey">${safeTime}</a>
            </div>
            ${replyMeta}
            <div class="body">${safeBody}</div>
            ${actions}
            ${nested}
          </div>
        </div>`;
    })
  );

  return `<div class="reply-children depth-${depth}">
    ${parts.join("")}
  </div>`;
}

// Single message renderer
async function renderMessage(hash) {
  const endpoint = `/message/${hash}`;
  const {
    openedLog,
    messageIndex,
    replyCounts,
    replyChildren,
  } = await collectMessageData();

  let messageData = messageIndex.get(hash);
  let blob = messageData?.blob;
  if (!blob) {
    blob = await apds.get(hash);
    if (!blob) {
      const notFoundContent =
        '<section class="feed-container"><p><i>Message not found.</i></p></section>';
      return htmlResponse(
        renderPage({
          title: "Message not found",
          content: appShell({
            feedInner: notFoundContent,
            feedEndpoint: endpoint,
            enableHx: false,
          }),
        })
      );
    }
    const meta = await parseMessageBlob(blob);
    let ts = null;
    let author = "";
    const fallbackEntry = openedLog?.find?.((entry) => {
      const openedStr = entry.opened || "";
      return openedStr.substring(13) === hash;
    });
    if (fallbackEntry) {
      const openedStr = fallbackEntry.opened || "";
      ts = openedStr.substring(0, 13);
      author = fallbackEntry.author || "";
    }
    messageData = {
      blob,
      blobHash: hash,
      meta,
      ts,
      author,
    };
  }

  const { meta, author = "", ts } = messageData;
  const { name, image, body, reply, replyto } = meta;
  const timeHuman = ts ? await apds.human(ts) : "";
  const safeName = escapeHtml(name);
  const safeBody = escapeHtml(body);
  const safeTime = escapeHtml(timeHuman);
  const safeAuthor = escapeHtml(author);
  const safeMsgHash = escapeHtml(hash);
  const imgSrc = imageSrc(image);
  const safeReplyHash = reply ? escapeHtml(reply) : "";
  const safeReplyPreview = reply ? escapeHtml(reply.slice(0, 8)) : "";
  const safeReplyTo = replyto ? escapeHtml(replyto.slice(0, 10)) : "";
  const replyCount = replyCounts.get(hash) || 0;
  const replyCountLabel = escapeHtml(formatReplyCount(replyCount));
  const safeRawUrl = escapeHtml(`/blob/${hash}`);

  const imgTag = image
    ? `<img src="${escapeHtml(imgSrc)}" class="avatar" alt="${safeName}'s avatar">`
    : `<div class="avatar" style="background:#ccc"></div>`;
  const replyMeta = reply
    ? `<div class="message-reply-ref">
        Replying to <a href="/message/${safeReplyHash}">${safeReplyPreview}</a>${
      replyto ? ` · <span class="pubkey">${safeReplyTo}</span>` : ""
    }
      </div>`
    : "";
  const actions = `
    <div class="message-actions">
      <span class="reply-count" data-count="${replyCount}">${replyCountLabel}</span>
      <a class="raw-link" href="${safeRawUrl}" target="_blank" rel="noopener noreferrer">Raw</a>
      <button
        class="reply-btn"
        data-msg-hash="${safeMsgHash}"
        data-author="${safeAuthor}"
        data-author-name="${safeName}"
      >Reply</button>
    </div>`;

  const repliesHtml = await renderReplyThread({
    parentHash: hash,
    replyChildren,
    replyCounts,
  });

  const repliesSection = repliesHtml
    ? `<div class="reply-thread">
        <h3>Replies</h3>
        ${repliesHtml}
      </div>`
    : `<div class="reply-thread empty"><p><i>No replies yet.</i></p></div>`;

  const messageContent = `
    <section class="feed-container">
      <div class="message" data-msg-hash="${safeMsgHash}" data-author="${safeAuthor}" data-author-name="${safeName}">
        ${imgTag}
        <div class="message-content">
          <div class="message-header">
            <strong>${safeName}</strong>
            <span class="pubkey">${safeTime}</span>
          </div>
          ${replyMeta}
          <div class="body">${safeBody}</div>
          ${actions}
        </div>
      </div>
      ${repliesSection}
      <p><a href="/">← Back to wttr</a></p>
    </section>`;

  return htmlResponse(
    renderPage({
      title: `${safeName} on wttr`,
      content: appShell({
        feedInner: messageContent,
        feedEndpoint: endpoint,
        enableHx: false,
        showIdentity: false,
        showCompose: false,
      }),
    })
  );
}

console.log(`🌤 wttr running at http://localhost:${PORT}`);
