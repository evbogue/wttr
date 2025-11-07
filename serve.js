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
  };
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
      ? `data-feed-endpoint="${safeEndpoint}" hx-get="${safeEndpoint}" hx-trigger="load, every 5s, refreshFeed from:body" hx-swap="innerHTML"`
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

// Feed renderer (global or per-profile)
async function renderFeed({
  filterAuthor = null,
  heading = "wttr feed",
  request = null,
} = {}) {
  const openedLog = await apds.getOpenedLog();
  const endpoint = filterAuthor ? `/profile/${filterAuthor}` : "/feed";

  let feedContent = `<section class="feed-container"><h2>${escapeHtml(
    heading
  )}</h2><p><i>No posts yet.</i></p></section>`;

  if (openedLog?.length) {
    const htmlParts = await Promise.all(
      openedLog
        .slice()
        .reverse()
        .map(async (entry) => {
          if (filterAuthor && entry.author !== filterAuthor) return "";

          const openedStr = entry.opened || "";
          const author = entry.author || "";
          const authorUrl = `/profile/${author}`;
          const ts = openedStr.substring(0, 13);
          const blobHash = openedStr.substring(13);
          const blob = await apds.get(blobHash);
          if (!blob) return "";

          const { name, image, body } = await parseMessageBlob(blob);
          const timeHuman = await apds.human(ts);
          const safeName = escapeHtml(name);
          const safeBody = escapeHtml(body);
          const safeTime = escapeHtml(timeHuman);
          const imgSrc = imageSrc(image);

          const imgTag = image
            ? `<img src="${escapeHtml(imgSrc)}" class="avatar" alt="${safeName}'s avatar">`
            : `<div class="avatar" style="background:#ccc"></div>`;

          // Use blobHash as message id
          const msgHash = blobHash;
          const safeAuthorUrl = escapeHtml(authorUrl);
          const safeMsgUrl = escapeHtml(`/message/${msgHash}`);

          return `
          <div class="message">
            ${imgTag}
            <div class="message-content">
              <div class="message-header">
                <a href="${safeAuthorUrl}"><strong>${safeName}</strong></a>
                <a href="${safeMsgUrl}" class="pubkey">${safeTime}</a>
              </div>
              <div class="body">${safeBody}</div>
            </div>
          </div>`;
        })
    );

    feedContent = `
      <section class="feed-container">
        <h2>${escapeHtml(heading)}</h2>
        <div class="message-list">
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

// Single message renderer
async function renderMessage(hash) {
  const blob = await apds.get(hash);
  const endpoint = `/message/${hash}`;
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

  // Find timestamp from opened entries
  const openedLog = await apds.getOpenedLog();
  let ts = null;
  let author = null;
  for (const entry of openedLog) {
    const openedStr = entry.opened || "";
    const blobHash = openedStr.substring(13);
    if (blobHash === hash) {
      ts = openedStr.substring(0, 13);
      author = entry.author;
      break;
    }
  }

  const { name, image, body } = await parseMessageBlob(blob);
  const timeHuman = ts ? await apds.human(ts) : "";
  const safeName = escapeHtml(name);
  const safeBody = escapeHtml(body);
  const safeTime = escapeHtml(timeHuman);
  const imgSrc = imageSrc(image);

  const imgTag = image
    ? `<img src="${escapeHtml(imgSrc)}" class="avatar" alt="${safeName}'s avatar">`
    : `<div class="avatar" style="background:#ccc"></div>`;

  const messageContent = `
    <section class="feed-container">
      <div class="message">
        ${imgTag}
        <div class="message-content">
          <div class="message-header">
            <strong>${safeName}</strong>
            <span class="pubkey">${safeTime}</span>
          </div>
          <div class="body">${safeBody}</div>
        </div>
      </div>
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
