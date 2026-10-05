/**
 * Guards for the local proxy's trust boundary.
 *
 * The proxy listens on 127.0.0.1 and signs payments from the user's wallet,
 * so three things must hold:
 *
 *  1. Only local clients reach it. Binding to loopback keeps the LAN out, but
 *     a web page open in the user's browser can still send requests to
 *     127.0.0.1:8402 (a text/plain POST needs no CORS preflight), and a
 *     DNS-rebinding page can read the responses. isTrustedLocalRequest()
 *     rejects cross-site browser requests and non-local Host headers. Native
 *     clients (OpenClaw, curl, SDKs) send no Origin and are unaffected.
 *
 *  2. URLs supplied in a request body are fetched only from public hosts,
 *     with every redirect re-checked (isBlockedSsrfHost / ssrfSafeFetch).
 *
 *  3. A "local image path" in a request is really an image, so the img2img
 *     route cannot be pointed at the wallet key file (readLocalImageAsDataUri).
 */

import type { IncomingMessage } from "node:http";
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── 1. Local-request trust ────────────────────────────────────────────────

function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

/**
 * Why this request must be refused, or null if it is a trusted local client.
 *
 * - Host must name a loopback host. A DNS-rebinding page reaches 127.0.0.1
 *   under its own hostname, so this is what stops it reading responses.
 * - Origin, when present, must be a loopback origin. Browsers attach Origin to
 *   cross-origin POSTs; native clients don't send one.
 * - Sec-Fetch-Site: cross-site is refused even without Origin, as a backstop
 *   for browsers that omit Origin on some request types.
 */
export function untrustedRequestReason(req: IncomingMessage): string | null {
  const host = req.headers.host;
  if (host) {
    let hostname: string;
    try {
      hostname = new URL(`http://${host}`).hostname;
    } catch {
      return "malformed Host header";
    }
    if (!isLocalHostname(hostname)) return `non-local Host header (${hostname})`;
  }

  const origin = req.headers.origin;
  if (Array.isArray(origin)) return "multiple Origin headers";
  if (origin !== undefined) {
    // Sandboxed iframes and file:// pages send the literal "null".
    if (origin === "null") return "opaque Origin";
    let o: URL;
    try {
      o = new URL(origin);
    } catch {
      return "malformed Origin header";
    }
    if ((o.protocol !== "http:" && o.protocol !== "https:") || !isLocalHostname(o.hostname)) {
      return `cross-site Origin (${origin})`;
    }
  }

  const site = req.headers["sec-fetch-site"];
  if (site === "cross-site") return "cross-site browser request";

  return null;
}

// ─── 2. SSRF guard ─────────────────────────────────────────────────────────

// Named cloud-metadata endpoints that aren't `*.internal`.
const METADATA_HOSTS = new Set(["metadata", "metadata.goog", "instance-data"]);

function v4FromHex(hi: number, lo: number): string {
  return `${(hi >>> 8) & 255}.${hi & 255}.${(lo >>> 8) & 255}.${lo & 255}`;
}

/**
 * True for loopback, private, link-local, CGNAT and cloud-metadata hosts,
 * including the IPv6 forms that embed an IPv4 address. Literal-host based:
 * it does not resolve DNS.
 */
export function isBlockedSsrfHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h.endsWith(".internal")) return true;
  if (METADATA_HOSTS.has(h)) return true;

  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true;
    if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
    // 6to4: 2002:WWXX:YYZZ::/16 embeds W.X.Y.Z.
    const sixToFour = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/);
    if (sixToFour) {
      return isBlockedSsrfHost(v4FromHex(parseInt(sixToFour[1], 16), parseInt(sixToFour[2], 16)));
    }
    // NAT64 (64:ff9b::/96) and IPv4-mapped (::ffff:0:0/96) embed an IPv4.
    const embedded = h.match(/^64:ff9b::(.+)$/) ?? h.match(/::ffff:(.+)$/);
    if (embedded) {
      const tail = embedded[1];
      if (tail.includes(".")) return isBlockedSsrfHost(tail);
      const seg = tail.split(":");
      if (seg.length === 2)
        return isBlockedSsrfHost(v4FromHex(parseInt(seg[0], 16), parseInt(seg[1], 16)));
    }
    return false;
  }

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = Number(m[3]);
    if (a === 127 || a === 0 || a === 10) return true;
    if (a === 169 && b === 254) return true; // link-local + 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT, incl. Alibaba 100.100.100.200
    if (a === 192 && b === 0 && c === 0) return true; // Oracle 192.0.0.192
  }
  return false;
}

/**
 * fetch() that follows redirects manually and re-checks the host on every
 * hop, so a public URL can't 30x into 169.254.169.254 or the proxy itself.
 */
export async function ssrfSafeFetch(
  url: string,
  init: RequestInit & { allowPrivate?: boolean } = {},
  maxHops = 5,
): Promise<Response> {
  const { allowPrivate, ...fetchInit } = init;
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    const u = new URL(current);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`refusing to fetch non-http(s) URL (${u.protocol})`);
    }
    if (!allowPrivate && isBlockedSsrfHost(u.hostname)) {
      throw new Error(`refusing to fetch a private/loopback/metadata address: ${u.hostname}`);
    }
    const res = await fetch(current, { ...fetchInit, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      current = new URL(loc, current).href;
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

// ─── 3. Local image read ───────────────────────────────────────────────────

const MAX_LOCAL_IMAGE_BYTES = 25 * 1024 * 1024;

const IMAGE_SIGNATURES: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  {
    mime: "image/png",
    test: (b) =>
      b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a,
  },
  {
    mime: "image/jpeg",
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: "image/webp",
    test: (b) =>
      b.length >= 12 &&
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WEBP",
  },
];

/**
 * Read a local image file as a data URI.
 *
 * The path comes from a request body or a chat message, so it is untrusted.
 * Only regular files whose bytes are a PNG, JPEG or WebP are read; the
 * extension is not trusted, and a symlink named photo.png pointing at a key
 * file fails the signature check. The error never says whether a path
 * exists, so the route can't be used to probe the filesystem.
 */
export function readLocalImageAsDataUri(filePath: string): string {
  const expanded = filePath.startsWith("~/") ? join(homedir(), filePath.slice(2)) : filePath;
  const refuse = () => new Error(`Not a readable PNG, JPEG or WebP image: ${filePath}`);

  let fd: number;
  try {
    fd = openSync(realpathSync(expanded), "r");
  } catch {
    throw refuse();
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size === 0 || st.size > MAX_LOCAL_IMAGE_BYTES) throw refuse();
    const head = Buffer.alloc(12);
    readSync(fd, head, 0, 12, 0);
    const sig = IMAGE_SIGNATURES.find((s) => s.test(head));
    if (!sig) throw refuse();
    const data = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, data, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return `data:${sig.mime};base64,${data.subarray(0, off).toString("base64")}`;
  } finally {
    closeSync(fd);
  }
}
