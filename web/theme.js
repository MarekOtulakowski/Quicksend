const STORAGE_KEY = "quicksend-theme";
const VALID = ["system", "light", "dark"];

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

  const labels = { system: "System", light: "Jasny", dark: "Ciemny" };
  container.innerHTML = "";
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "Motyw");

  const buttons = {};
  for (const theme of VALID) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = labels[theme];
    btn.addEventListener("click", () => setTheme(theme));
    container.appendChild(btn);
    buttons[theme] = btn;
  }

  function setTheme(theme) {
    current = theme;
    apply(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Preference simply won't persist across reloads; not critical.
    }
    for (const [t, btn] of Object.entries(buttons)) {
      btn.setAttribute("aria-pressed", String(t === theme));
    }
  }

  setTheme(current);
}
