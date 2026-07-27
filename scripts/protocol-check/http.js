// scripts/protocol-check/http.js
// Shared HTTP helpers for the CEC protocol checker.
//
// The archive (https://archiveresults.cec.gov.ge) sits behind Cloudflare + nginx
// hotlink protection. Two hard-won facts shape this module:
//   1. Cloudflare blocks Node's built-in fetch (undici) with a 403 challenge on
//      TLS fingerprint, even with a browser User-Agent. The system `curl` is NOT
//      challenged, so we shell out to curl for every request. This keeps the tool
//      dependency-free (no npm packages) and is the same client we verified by hand.
//   2. Protocol images reject HEAD / no-Referer requests with 403. A ranged GET
//      (`Range: bytes=0-2`) with a same-site Referer returns 206 plus the true
//      file size in `content-range` — so we confirm an image exists, is an image,
//      and is non-trivial without downloading it.
//
// Redirects are NOT followed: the archive 301-redirects absent files (and gated
// SPA data paths) to the site root, so a 3xx is a meaningful "missing/denied".

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

export const ORIGIN = "https://archiveresults.cec.gov.ge";
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const STATUS_MARK = "\n__HTTP_STATUS__:";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cacheKey(url) {
  return crypto.createHash("sha1").update(url).digest("hex") + ".html";
}

/** Run curl with the given args; resolve with its stdout (never rejects). */
function curl(args) {
  return new Promise(resolve => {
    execFile("curl", args, { maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
      resolve({ stdout: stdout ?? "", failed: !!err });
    });
  });
}

const baseArgs = referer => [
  "-sS", "--compressed", "-m", "40",
  "-A", UA,
  "-H", "Accept-Language: ka-GE,ka;q=0.9,en;q=0.8",
  ...(referer ? ["-e", referer] : []),
];

/**
 * Fetch a page as text via curl, with retry/backoff and an optional disk cache.
 * @param {string} url
 * @param {{cacheDir?:string, referer?:string, retries?:number, minDelayMs?:number}} opts
 * @returns {Promise<{ok:boolean, status:number, text:string, fromCache:boolean}>}
 */
export async function fetchText(url, opts = {}) {
  const { cacheDir, referer, retries = 3, minDelayMs = 0 } = opts;
  if (cacheDir) {
    const cached = path.join(cacheDir, cacheKey(url));
    if (fs.existsSync(cached)) {
      return { ok: true, status: 200, text: fs.readFileSync(cached, "utf8"), fromCache: true };
    }
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (minDelayMs) await sleep(minDelayMs);
    const { stdout } = await curl([
      ...baseArgs(referer),
      "-H", "Accept: text/html,application/xhtml+xml,*/*",
      "--write-out", `${STATUS_MARK}%{http_code}`,
      url,
    ]);
    const idx = stdout.lastIndexOf(STATUS_MARK);
    const status = idx >= 0 ? Number(stdout.slice(idx + STATUS_MARK.length).trim()) : 0;
    const text = idx >= 0 ? stdout.slice(0, idx) : stdout;
    if (status === 200) {
      if (cacheDir) {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(path.join(cacheDir, cacheKey(url)), text, "utf8");
      }
      return { ok: true, status, text, fromCache: false };
    }
    if (status >= 300 && status < 500 && status !== 0) {
      // 3xx/4xx are deterministic answers, not transient — don't retry.
      return { ok: false, status, text: "", fromCache: false };
    }
    await sleep(400 * (attempt + 1) ** 2);
  }
  return { ok: false, status: 0, text: "", fromCache: false };
}

/**
 * Probe an image with a 3-byte ranged GET via curl. Returns status, content-type,
 * and the true total size parsed from `content-range`.
 * @param {string} url
 * @param {{referer?:string, retries?:number, minDelayMs?:number}} opts
 * @returns {Promise<{status:number, contentType:string, totalBytes:number|null}>}
 */
export async function probeImage(url, opts = {}) {
  const { referer, retries = 3, minDelayMs = 0 } = opts;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (minDelayMs) await sleep(minDelayMs);
    // -D - dumps response headers to stdout; -r 0-2 keeps the body to 3 bytes.
    const { stdout, failed } = await curl([
      ...baseArgs(referer),
      "-H", "Accept: image/avif,image/webp,image/*,*/*",
      "-r", "0-2", "-D", "-",
      "--write-out", `${STATUS_MARK}%{http_code}`,
      url,
    ]);
    const idx = stdout.lastIndexOf(STATUS_MARK);
    const status = idx >= 0 ? Number(stdout.slice(idx + STATUS_MARK.length).trim()) : 0;
    const head = (idx >= 0 ? stdout.slice(0, idx) : stdout);
    const ctMatch = head.match(/^content-type:\s*([^\r\n]+)/im);
    const crMatch = head.match(/^content-range:\s*bytes\s+\S+\/(\d+)/im);
    const clMatch = head.match(/^content-length:\s*(\d+)/im);
    if (status !== 0) {
      const totalBytes = crMatch ? Number(crMatch[1])
        : (status === 200 && clMatch ? Number(clMatch[1]) : null);
      return { status, contentType: ctMatch ? ctMatch[1].trim() : "", totalBytes };
    }
    if (failed) await sleep(400 * (attempt + 1) ** 2);
  }
  return { status: 0, contentType: "", totalBytes: null };
}

/**
 * Run async `worker` over `items` with bounded concurrency, preserving order.
 * @template T,R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item:T, index:number)=>Promise<R>} worker
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<R[]>}
 */
export async function pool(items, concurrency, worker, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}
