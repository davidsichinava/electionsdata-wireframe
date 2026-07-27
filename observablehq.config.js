// 1. Import the Node.js file system module
import { readFileSync } from "node:fs";
import { collectExistingPaths, isPrecinctPath } from "./src/data/config/registry-utils.js";
import { collectDownloadEntries } from "./src/loaders/downloads/shared.js";

// 2. Read the file content (Path is relative to the project root)
const headerContent = readFileSync("./src/components/header.html", "utf8");

function dynamicAssetPaths() {
  const paths = ["/data/config/translations.json"];
  paths.push(
    "/fonts/bpg-arial-caps-webfont.woff2",
    "/fonts/bpg-arial-caps-webfont.ttf",
    "/fonts/bpg-arial-webfont.woff2",
    "/fonts/bpg-arial-webfont.ttf"
  );
  paths.push(...collectExistingPaths(p =>
    p.endsWith(".geojson") || p.endsWith(".csv")
  )
    .map(p => `/${p}`));
  for (const entry of collectDownloadEntries()) {
    paths.push(`/data/downloads/${entry.filename}`);
  }
  return [...new Set(paths)].sort();
}

// See https://observablehq.com/framework/config for documentation.
export default {
  root: "src",
  base: "/electionsdata-wireframe/",
  header: headerContent,
  head: `
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
    <link rel="stylesheet" href="custom-style.css">
    <!-- Per-page styles (REFACTOR_PLAN §4): class names are page-prefixed or
         verified collision-free, so global loading is safe. cand-shared.css
         holds the candidate-table UI used by BOTH candidates.md and parties.md
         (deduplicated from two identical copies); the one divergent rule is
         scoped via .cand-grid-parties / .cand-grid-cands modifiers. -->
    <link rel="stylesheet" href="styles/index.css">
    <link rel="stylesheet" href="styles/elections.css">
    <link rel="stylesheet" href="styles/cand-shared.css">
    <link rel="stylesheet" href="styles/candidates.css">
    <link rel="stylesheet" href="styles/parties.css">
    <link rel="stylesheet" href="styles/analysis.css">
    <link rel="stylesheet" href="styles/about.css">
    <link rel="stylesheet" href="styles/downloads.css">
    <link rel="icon" href="logo_ka-1.svg" type="image/svg" sizes="32x32">
    <!-- Cloudflare Web Analytics — skipped on localhost / dev preview / file:// so dev traffic doesn't pollute stats. -->
    <script>
      (function () {
        var h = (typeof location !== "undefined" && location.hostname) || "";
        if (h === "localhost" || h === "127.0.0.1" || h === "" || h.endsWith(".local")) return;
        var s = document.createElement("script");
        s.defer = true;
        s.src = "https://static.cloudflareinsights.com/beacon.min.js";
        s.setAttribute("data-cf-beacon", '{"token": "fe929cc11e5c47338413453d424732e0"}');
        document.head.appendChild(s);
      })();
    </script>
    <!-- End Cloudflare Web Analytics -->
  `,
  pages: [
    {name: "Main", path: "/index"},
    {name: "Elections", path: "/elections"},
    {name: "Candidates", path: "/candidates"},
    {name: "Parties", path: "/parties"},
    {name: "Data", path: "/downloads"},
    // {name: "Analysis", path: "/analysis"},
    {name: "About", path: "/about"}
  ],
  dynamicPaths: dynamicAssetPaths,
  theme: "air", // "air", "cotton", "ink", or "near-midnight"
  pager: false, // Turn off next/prev buttons for a dashboard feel
  // The app’s title; used in the sidebar and webpage titles.
  title: "არჩევნები საქართველოში",
  // The pages and sections in the sidebar. If you don’t specify this option,
  // all pages will be listed in alphabetical order. Listing pages explicitly
  // lets you organize them into sections and have unlisted pages.
  // Some additional configuration options and their defaults:
  theme: "light",
  // theme: "default", // try "light", "dark", "slate", etc.
  footer: `დავით სიჭინავა. <a href="https://github.com/geoelectionsdata/geoelectionsdata.github.io" target="_blank" rel="noopener noreferrer">GitHub</a>`, // what to show in the footer (HTML)
  sidebar: false, // whether to show the sidebar
  // toc: true, // whether to show the table of contents
  pager: false, // whether to show previous & next links in the footer
  // output: "dist", // path to the output root for build
  // search: true, // activate search
  // linkify: true, // convert URLs in Markdown to links
  // typographer: false, // smart quotes and other typographic improvements
  // preserveExtension: false, // drop .html from URLs
  // preserveIndex: false, // drop /index from URLs
};
