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
 *     checked as written and as resolved, connected only to the addresses
 *     that passed, with every redirect re-checked (ssrfSafeFetch).
 *
 *  3. A "local image path" in a request is really an image, so the img2img
 *     route cannot be pointed at the wallet key file (readLocalImageAsDataUri).
 */

import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
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
 * it does not resolve DNS — resolvePublicAddresses() applies it to what a
 * name resolves to.
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

export type SsrfResolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: SsrfResolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Every address `hostname` resolves to, refusing if ANY of them is blocked.
 *
 * isBlockedSsrfHost() only sees the name, and a public name can point
 * anywhere: localtest.me and 127.0.0.1.nip.io resolve to loopback,
 * 169.254.169.254.nip.io to the metadata service. All addresses are checked,
 * not the first, because the connection may land on any of them.
 */
export async function resolvePublicAddresses(
  hostname: string,
  resolve: SsrfResolver = systemResolver,
): Promise<LookupAddress[]> {
  const h = hostname.replace(/^\[/, "").replace(/\]$/, "");
  const family = isIP(h);
  const addrs = family ? [{ address: h, family }] : await resolve(h);
  if (addrs.length === 0) throw new Error(`could not resolve ${hostname}`);
  const blocked = addrs.find((a) => isBlockedSsrfHost(a.address));
  if (blocked) {
    throw new Error(
      `refusing to fetch ${hostname}: it resolves to a private/loopback/metadata address (${blocked.address})`,
    );
  }
  return addrs;
}

/**
 * A socket lookup that answers with the addresses already vetted, whatever
 * name it is asked about. Resolving again at connect time is the DNS-rebinding
 * gap: a TTL-0 record can answer the check with a public address and the
 * connect with 127.0.0.1. Node asks with `all: true` when it races address
 * families, so both callback shapes are served.
 */
export function pinnedLookup(addrs: LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, addrs);
    } else {
      callback(null, addrs[0].address, addrs[0].family);
    }
  };
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * One request, no redirects, connected only to `addrs`. The URL keeps its
 * hostname, so Host, SNI and certificate checks are unchanged.
 *
 * Unlike fetch() it sends no Accept-Encoding and does not decode bodies.
 */
export function pinnedFetch(
  url: URL,
  addrs: LookupAddress[],
  init: RequestInit = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const body = init.body;
  if (body != null && typeof body !== "string" && !(body instanceof Uint8Array)) {
    return Promise.reject(new TypeError("pinnedFetch supports only string or byte bodies"));
  }
  const headers = Object.fromEntries(new Headers(init.headers));
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = send(
      url,
      { method, headers, lookup: pinnedLookup(addrs), signal: init.signal ?? undefined },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 599) {
          res.destroy();
          reject(new Error(`unexpected HTTP status ${status} from ${url.host}`));
          return;
        }
        const resHeaders = new Headers();
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          resHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        }
        const noBody = method === "HEAD" || NULL_BODY_STATUSES.has(status);
        if (noBody) res.resume();
        resolve(
          new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
            status,
            statusText: res.statusMessage,
            headers: resHeaders,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

export interface SsrfFetchInit extends RequestInit {
  /** Skip every private-address check (CLAWROUTER_ALLOW_PRIVATE_FETCH). */
  allowPrivate?: boolean;
  /**
   * An upstream proxy is the global dispatcher. Requests must go through it,
   * and it resolves names itself, so the connection cannot be pinned: only
   * the resolve-time check applies.
   */
  viaUpstreamProxy?: boolean;
  /** Test seam; defaults to the system resolver. */
  resolve?: SsrfResolver;
}

/**
 * fetch() for URLs taken from a request body. On every hop, redirects
 * included, the host is checked as written and as resolved, and the
 * connection is pinned to the addresses that passed, so neither a 30x nor a
 * name pointing (or re-pointing) at 169.254.169.254 or the proxy itself gets
 * through.
 */
export async function ssrfSafeFetch(
  url: string,
  init: SsrfFetchInit = {},
  maxHops = 5,
): Promise<Response> {
  const { allowPrivate, viaUpstreamProxy, resolve, ...fetchInit } = init;
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    const u = new URL(current);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`refusing to fetch non-http(s) URL (${u.protocol})`);
    }
    let res: Response;
    if (allowPrivate) {
      res = await fetch(current, { ...fetchInit, redirect: "manual" });
    } else {
      if (isBlockedSsrfHost(u.hostname)) {
        throw new Error(`refusing to fetch a private/loopback/metadata address: ${u.hostname}`);
      }
      const addrs = await resolvePublicAddresses(u.hostname, resolve);
      res = viaUpstreamProxy
        ? await fetch(current, { ...fetchInit, redirect: "manual" })
        : await pinnedFetch(u, addrs, fetchInit);
    }
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
