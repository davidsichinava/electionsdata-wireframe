---
theme: [air, alt, wide]
title: About
toc: false
---

```js
import {getLang, tr} from "./components/state.js";

const dict = await FileAttachment("data/config/translations.json").json();
const lang = getLang();
const elections = await FileAttachment("data/elections.json").json();
```

```js
// ── Localised strings ────────────────────────────────────────────────────────
const about = {
  en: {
    about_title: "Georgia Elections Data Archive (GEDA)",
    about_body:  `The Georgia Elections Data Archive (GEDA) is an open, structured
      dataset of election results held in Georgia from 1919 to the present. It brings together available
      results, candidate lists, and constituency-level data for all national and sub-national
      elections. Data are sourced from the Central Election Commission of Georgia
      (CEC), contemporary press coverage, and the National Archives of Georgia. Part of the election results and spatial data were kindly granted by the National Democratic Institute (NDI).
      The archive is maintained by David Sichinava, and any interested parties are welcome to use it for academic and journalistic purposes, or for general interest.  Data are released under a CC-BY-4.0 license; when using,
      please cite the archive using the format provided on this page.`,
    cite_title:    "Cite GEDA",
    cite_sub:      "Select an election and a citation style to generate a formatted reference.",
    pick_election: "Election",
    pick_style:    "Citation style",
    copy:          "Copy",
    copied:        "Copied!",
    bibtex_title:  "BibTeX",
    styles: {
      apa:     "APA 7th",
      harvard: "Harvard",
      chicago: "Chicago 17th",
    },
    contact_title:   "Contact",
    contact_body:    "For questions, corrections, or collaboration inquiries, please contact David Sichinava.",
    src_title:       "Sources",
    src_col_election:"Election",
    src_col_source:  "Source",
    src_col_note:    "Note",
  },
  ka: {
    about_title: "საქართველოს არჩევნების მონაცემთა არქივი (GEDA)",
    about_body:  `საქართველოს არჩევნების მონაცემთა არქივი (GEDA) 1919 წლიდან დღემდე საქართველოში ჩატარებული არჩევნების შედეგების ღია, სტრუქტურირებული მონაცემთა ბაზას წარმოადგენს. იგი მოიცავს საქართველოში გამართული ყველა ეროვნული და ადგილობრივი არჩევნების შედეგებს, კანდიდატთა სიებს და საოლქო თუ საუბნო დონის მონაცემებს, რომელთა შესახებ ინფორმაციის მოძიება შესაძლებელი იყო. მონაცემები მომზადებულია საქართველოს ცენტრალური საარჩევნო კომისიის (ცესკო), პრესისა და საქართველოს ეროვნული არქივის მასალების საფუძველზე. შედეგებისა და სივრცითი მონაცემების ნაწილი გადმოგვცა „ეროვნულმა დემოკრატიულმა ინსტიტუტმა“ (NDI). მონაცემები დამუშავებულია დავით სიჭინავას მიერ, ხოლო მათი გამოყენება შეუძლია ნებისმიერ მსურველს, აკადემიური, ჟურნალისტური თუ საინფორმაციო მიზნით. მონაცემები ვრცელდება CC-BY-4.0 ლიცენზიით, შესაბამისად, გამოყენებისას, გთხოვთ, მიუთითოთ წყარო ამავე გვერდზე მოცემული ფორმატით.`,
    cite_title:    "GEDA-ს ციტირება",
    cite_sub:      "აირჩიეთ არჩევნები და დააგენერირეთ ციტირება სასურველ ფორმატში",
    pick_election: "არჩევნები",
    pick_style:    "ციტირების სტილი",
    copy:          "კოპირება",
    copied:        "კოპირებულია!",
    bibtex_title:  "BibTeX",
    styles: {
      apa:     "APA 7th",
      harvard: "Harvard",
      chicago: "Chicago 17th",
    },
    contact_title:   "კონტაქტი",
    contact_body:    "კითხვების, შესწორებების ან თანამშრომლობის შემთხვევაში, გთხოვთ, დაუკავშირდეთ დავით სიჭინავას.",
    src_title:       "წყაროები",
    src_col_election:"არჩევნები",
    src_col_source:  "წყარო",
    src_col_note:    "შენიშვნა",
  },
};

const L = about[lang] ?? about.en;
const BASE_URL = "https://electionsdata.ge";
```

```js
// ── Election list for citation picker ────────────────────────────────────────
const currentYear = new Date().getFullYear();

const elecOptions = elections
  .filter(e => e.id && e.name)
  .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
  .map(e => ({
    id:     e.id,
    label:  (lang === "ka" && e.name?.ka) ? e.name.ka : (e.name?.en ?? e.id),
    url:    `${BASE_URL}/${e.id}`,
    year:   currentYear,
    nameEn: e.name?.en ?? e.id,
    nameKa: e.name?.ka ?? "",
  }));

const styleOptions = [
  {value: "apa",     label: L.styles.apa},
  {value: "harvard", label: L.styles.harvard},
  {value: "chicago", label: L.styles.chicago},
];
```

```js
// ── Citation generator — fully self-contained, uses DOM events (no Generators.input) ──
{
  const elecSelect  = Inputs.select(elecOptions,  {label: L.pick_election, format: d => d.label});
  const styleSelect = Inputs.select(styleOptions, {label: L.pick_style,    format: d => d.label});

  function formatCitation(elec, styleVal) {
    if (!elec) return "";
    const { nameEn, nameKa, year, url } = elec;
    const isKa = lang === "ka";

    const title = isKa && nameKa
      ? nameKa.replace(/არჩევნები$/, "არჩევნების შედეგები")
      : `Results of the ${nameEn}`;
    const archive    = isKa ? "საქართველოს არჩევნების მონაცემთა არქივი (GEDA)"
                            : "Georgia Elections Data Archive (GEDA)";
    const author     = isKa ? "სიჭინავა, დ."    : "Sichinava, D.";
    const authorFull = isKa ? "სიჭინავა, დავით" : "Sichinava, David";
    const availAt    = isKa ? "ხელმისაწვდომია"  : "Available at";
    const retrieved  = isKa ? "ნანახია"          : "Retrieved on";
    const today      = new Date().toLocaleDateString(isKa ? "ka-GE" : "en-GB",
                         {day: "numeric", month: "long", year: "numeric"});

    if (styleVal === "apa")
      return `${author} (${year}). <em>${title}</em>. ${archive}. ${url}. ${retrieved}: ${today}.`;
    if (styleVal === "harvard")
      return `${author} (${year}) <em>${title}</em>, ${archive}. ${availAt}: ${url}. ${retrieved}: ${today}.`;
    if (styleVal === "chicago")
      return `${authorFull}. ${year}. "<em>${title}</em>." ${archive}. ${url}. ${retrieved}: ${today}.`;
    return "";
  }

  function formatBibtex(elec) {
    if (!elec) return "";
    const key   = `sichinava${elec.year}${elec.id.replace(/[^a-z0-9]/gi, "")}`;
    const title = `Results of the ${elec.nameEn}`;
    return `@misc{${key},\n  author    = {Sichinava, David},\n  title     = {{${title}}},\n  year      = {${elec.year}},\n  publisher = {Georgia Election Data Archive (GEDA)},\n  url       = {${elec.url}}\n}`;
  }

  function stripTags(s) { return s.replace(/<[^>]+>/g, ""); }

  // DOM nodes that will be updated on input change
  const citDiv = document.createElement("div");
  citDiv.style.cssText = "background:var(--theme-background-alt,#f7f7f7);border:1px solid var(--theme-foreground-faintest,#e0e0e0);border-radius:6px;padding:0.75rem 1rem;margin-bottom:0.5rem;font-size:0.9rem;line-height:1.7;";

  const bibtexPre = document.createElement("pre");
  bibtexPre.style.cssText = "background:var(--theme-background-alt,#f7f7f7);border:1px solid var(--theme-foreground-faintest,#e0e0e0);border-radius:6px;padding:0.75rem 1rem;font-size:0.8rem;overflow-x:auto;margin:0 0 0.5rem;white-space:pre-wrap;";

  function makeCopyBtn(label, getContent) {
    const btn = html`<button class="btn-primary-outline" style="font-size:0.78rem;padding:0.25rem 0.75rem;">${label}</button>`;
    btn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(getContent());
      const orig = btn.textContent;
      btn.textContent = L.copied;
      setTimeout(() => btn.textContent = orig, 1800);
    });
    return btn;
  }

  const copyCiteBtn   = makeCopyBtn(L.copy, () => stripTags(citDiv.innerHTML));
  const copyBibtexBtn = makeCopyBtn(L.copy, () => bibtexPre.textContent);

  function update() {
    const elec     = elecSelect.value;         // the selected option object
    const styleVal = (styleSelect.value?.value) ?? "apa"; // {value:"apa",...}.value
    citDiv.innerHTML      = formatCitation(elec, styleVal);
    bibtexPre.textContent = formatBibtex(elec);
  }

  elecSelect.addEventListener("input",  update);
  styleSelect.addEventListener("input", update);
  update(); // initial render

  // Build sources rows from elections that have a sources array
  const srcTableRows = elections
    .filter(e => Array.isArray(e.sources) && e.sources.length > 0)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .map(e => {
      const elecLabel = (lang === "ka" && e.name?.ka) ? e.name.ka : (e.name?.en ?? e.id);
      const items = e.sources.map(s => {
        const label = (lang === "ka" && s.name?.ka) ? s.name.ka : (s.name?.en ?? "");
        // Auto-link: if no explicit s.url is set, scan the label text for an
        // embedded http(s):// link and split the visible text from the URL so
        // we still render a clickable anchor. Matches the elections page's
        // renderElectionInfo() so sources behave consistently across pages.
        const urlMatch = label.match(/https?:\/\/\S+/);
        const url = s.url ?? (urlMatch ? urlMatch[0] : null);
        if (!url) return html`<li>${label}</li>`;
        const visibleLabel = urlMatch
          ? label.replace(urlMatch[0], "").replace(/[:\s]+$/u, "").trim()
          : label;
        return html`<li><a href="${url}" target="_blank" rel="noopener">${visibleLabel || url}</a></li>`;
      });
      const note = (lang === "ka" && e.source_note?.ka) ? e.source_note.ka
                 : e.source_note?.en ?? "";
      return html`<tr>
        <td class="src-elec-cell">${elecLabel}</td>
        <td><ul class="src-list">${items}</ul></td>
        <td class="src-note-cell">${note}</td>
      </tr>`;
    });

  const page = html`
<div class="about-page">

  <!-- Two-column layout -->
  <div class="about-cols">

    <!-- Left: combined about card -->
    <div class="card" style="align-self:start;">
      <h4 style="margin-top:0;">${L.about_title}</h4>
      <p style="margin:0;line-height:1.7;">${L.about_body}</p>
    </div>

    <!-- Right: citation generator -->
    <div class="card" style="align-self:start;">
      <h4 style="margin-top:0;">${L.cite_title}</h4>
      <p style="color:var(--muted);margin-top:0;font-size:0.88rem;">${L.cite_sub}</p>

      <div style="display:flex;flex-direction:column;gap:0.5rem;margin-bottom:1rem;">
        ${elecSelect}
        ${styleSelect}
      </div>

      ${citDiv}
      <div style="display:flex;justify-content:flex-end;margin-bottom:1.5rem;">${copyCiteBtn}</div>

      <h5 style="margin:0 0 0.4rem;">${L.bibtex_title}</h5>
      ${bibtexPre}
      <div style="display:flex;justify-content:flex-end;">${copyBibtexBtn}</div>
    </div>

  </div>

  <!-- Sources card -->
  <div class="card sources-card" style="margin-top:1rem;">
    <h4 style="margin-top:0;">${L.src_title}</h4>
    <table class="sources-table">
      <thead>
        <tr>
          <th>${L.src_col_election}</th>
          <th>${L.src_col_source}</th>
          <th>${L.src_col_note}</th>
        </tr>
      </thead>
      <tbody>${srcTableRows}</tbody>
    </table>
  </div>

</div>
`;

  display(page);
}
```
