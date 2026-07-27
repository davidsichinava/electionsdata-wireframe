// scripts/protocol-check/check.js
// Fast (existence + size) verdict for one scanned protocol image.
//
// Uses a 3-byte ranged GET (see http.probeImage) so we never download whole
// scans. Verdicts:
//   OK         200/206, image/* content-type, size >= minBytes
//   MISSING    404, or 301/302 (the archive redirects absent files to root)
//   FORBIDDEN  403 (hotlink block — usually a bad Referer, not a missing file)
//   WRONG_TYPE 200 but not an image (e.g. an HTML error page)
//   SUSPECT    image but smaller than minBytes (likely a blank/placeholder scan)
//   ERROR      network failure / status 0

import { probeImage } from "./http.js";

export const VERDICT = {
  OK: "OK",
  MISSING: "MISSING",
  FORBIDDEN: "FORBIDDEN",
  WRONG_TYPE: "WRONG_TYPE",
  SUSPECT: "SUSPECT",
  ERROR: "ERROR",
};

/**
 * @param {{imageUrl:string, pageUrl:string}} entry
 * @param {{minBytes?:number, minDelayMs?:number}} opts
 * @returns {Promise<{imageUrl:string,pageUrl:string,verdict:string,httpStatus:number,contentType:string,bytes:number|null}>}
 */
export async function checkImage(entry, opts = {}) {
  const { minBytes = 8000, minDelayMs = 0 } = opts;
  const r = await probeImage(entry.imageUrl, { referer: entry.pageUrl, minDelayMs });

  let verdict;
  if (r.status === 0) verdict = VERDICT.ERROR;
  else if (r.status === 404 || r.status === 301 || r.status === 302) verdict = VERDICT.MISSING;
  else if (r.status === 403) verdict = VERDICT.FORBIDDEN;
  else if (r.status === 200 || r.status === 206) {
    if (!/^image\//i.test(r.contentType)) verdict = VERDICT.WRONG_TYPE;
    else if (r.totalBytes != null && r.totalBytes < minBytes) verdict = VERDICT.SUSPECT;
    else verdict = VERDICT.OK;
  } else {
    verdict = VERDICT.ERROR;
  }

  return {
    imageUrl: entry.imageUrl,
    pageUrl: entry.pageUrl,
    verdict,
    httpStatus: r.status,
    contentType: r.contentType,
    bytes: r.totalBytes,
  };
}
