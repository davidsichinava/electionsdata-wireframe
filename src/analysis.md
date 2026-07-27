---
theme: [air, alt, wide]
title: Analysis
toc: false
---

```js
import {getLang, tr} from "./components/state.js";

const dict = await FileAttachment("data/config/translations.json").json();
const lang = getLang();
```

```js
function generatePosts(count = 3) {
  return Array.from({length: count}).map((_, i) => {
    const postTitle  = `${tr(dict, lang, "analysis.post_title")} ${i + 1}`;
    const postTeaser = tr(dict, lang, "analysis.post_teaser");
    const btnLabel   = tr(dict, lang, "analysis.post_read_more");

    return html`
      <div class="analysis-card">
        <div>
          <div class="stat-label" style="margin-bottom: 0.5rem;">
            ${tr(dict, lang, "analysis.post_label") || "Analysis"} &nbsp;·&nbsp; ${new Date(2024, i * 3, 1).toLocaleDateString("en-GB", {month: "long", year: "numeric"})}
          </div>
          <h5>${postTitle}</h5>
          <p>${postTeaser}</p>
        </div>
        <button class="btn-primary-solid" style="margin-top: 1rem;">
          ${btnLabel} →
        </button>
      </div>
    `;
  });
}
```

```js
const container = html`
<div class="card card-featured" style="margin-bottom: 1.5rem;">
  <h3 style="margin-top: 0;">${tr(dict, lang, "analysis.title")}</h3>
  <p style="color: var(--muted); font-size: 1rem; max-width: 680px; margin-bottom: 0;">
    ${tr(dict, lang, "analysis.intro")}
  </p>
</div>

<div class="analysis-grid">
  ${generatePosts(3)}
</div>
`;

display(container);
```
