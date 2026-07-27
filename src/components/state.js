import {Generators} from "npm:@observablehq/stdlib";
import {loadFonts} from "./fontloader.js";

// EXECUTE IMMEDIATELY
// Since this module is imported by every page, the fonts will load automatically.
loadFonts();

// i18n note: the page dictionary lives in src/data/config/translations.json
// (single source of truth — checked by scripts/check-translations.js). The
// header/nav language switcher is owned entirely by components/header.html,
// which dispatches the "lang-change" event that getLang() listens for.

/**
 * Look up a translation key: requested language → Georgian fallback → the key
 * itself (so untranslated keys stay visible rather than rendering blank).
 * @param {object} dict parsed translations.json ({en: {...}, ka: {...}})
 * @param {string} lang "en" | "ka"
 * @param {string} key dot-separated key, e.g. "elections.results.candidate"
 * @returns {string}
 */
export function tr(dict, lang, key) {
  if (!dict) return key;
  return dict[lang]?.[key] || dict["ka"]?.[key] || key;
}

/**
 * Reactive language value for Observable pages. Initializes from
 * localStorage("app_lang", default "ka") and updates whenever the header
 * button dispatches a "lang-change" CustomEvent.
 * @returns {AsyncGenerator<string>} yields "en" | "ka"
 */
export function getLang() {
  return Generators.observe((notify) => {
    const initial = (typeof window !== "undefined" && localStorage.getItem("app_lang")) || "ka";
    notify(initial);

    const listener = (event) => notify(event.detail);

    if (typeof window !== "undefined") {
      window.addEventListener("lang-change", listener);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("lang-change", listener);
      }
    };
  });
}
