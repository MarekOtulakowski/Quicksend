import { STRINGS, DEFAULT_LOCALE, detectLocale } from "./strings.js";

const STORAGE_KEY = "quicksend-lang";
const VALID = ["system", "pl", "en"];

let currentLocale = DEFAULT_LOCALE;
const subscribers = [];

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return VALID.includes(v) ? v : "system";
  } catch {
    return "system";
  }
}

function resolveLocale(pref) {
  return pref === "system" ? detectLocale() : pref;
}

function applyTranslations() {
  const dict = STRINGS[currentLocale] || STRINGS[DEFAULT_LOCALE];
  document.documentElement.lang = currentLocale;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (dict[key] !== undefined) el.textContent = dict[key];
  });
  for (const fn of subscribers) fn(currentLocale);
}

/** Translate a single key against the currently active locale. */
export function t(key) {
  const dict = STRINGS[currentLocale] || STRINGS[DEFAULT_LOCALE];
  return dict[key] !== undefined ? dict[key] : key;
}

/** Register a callback invoked whenever the resolved locale changes. */
export function onLocaleChange(fn) {
  subscribers.push(fn);
}

export function initLangToggle(container) {
  let pref = readStored();

  const labelKeys = { system: "langAuto", pl: "langPl", en: "langEn" };
  container.innerHTML = "";
  container.setAttribute("role", "group");

  const buttons = {};
  for (const opt of VALID) {
    const btn = document.createElement("button");
    btn.type = "button";
    container.appendChild(btn);
    buttons[opt] = btn;
    btn.addEventListener("click", () => setPref(opt));
  }

  function relabel() {
    container.setAttribute("aria-label", t("langGroupLabel"));
    for (const [opt, btn] of Object.entries(buttons)) {
      btn.textContent = t(labelKeys[opt]);
    }
  }

  function setPref(newPref) {
    pref = newPref;
    currentLocale = resolveLocale(pref);
    try {
      localStorage.setItem(STORAGE_KEY, newPref);
    } catch {
      // Preference simply won't persist across reloads; not critical.
    }
    applyTranslations();
    relabel();
    for (const [opt, btn] of Object.entries(buttons)) {
      btn.setAttribute("aria-pressed", String(opt === pref));
    }
  }

  setPref(pref);
}
