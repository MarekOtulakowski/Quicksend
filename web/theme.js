import { t, onLocaleChange } from "./i18n.js";

const STORAGE_KEY = "quicksend-theme";
const VALID = ["system", "light", "dark"];
const LABEL_KEYS = { system: "themeSystem", light: "themeLight", dark: "themeDark" };

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return VALID.includes(v) ? v : "system";
  } catch {
    return "system";
  }
}

function apply(theme) {
  if (theme === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

export function initThemeToggle(container) {
  let current = readStored();
  apply(current);

  container.innerHTML = "";
  container.setAttribute("role", "group");

  const buttons = {};
  for (const theme of VALID) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.addEventListener("click", () => setTheme(theme));
    container.appendChild(btn);
    buttons[theme] = btn;
  }

  function relabel() {
    container.setAttribute("aria-label", t("themeGroupLabel"));
    for (const [theme, btn] of Object.entries(buttons)) {
      btn.textContent = t(LABEL_KEYS[theme]);
    }
  }

  function setTheme(theme) {
    current = theme;
    apply(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Preference simply won't persist across reloads; not critical.
    }
    for (const [th, btn] of Object.entries(buttons)) {
      btn.setAttribute("aria-pressed", String(th === theme));
    }
  }

  relabel();
  setTheme(current);
  onLocaleChange(relabel);
}
