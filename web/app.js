import { initLangToggle } from "./i18n.js";
import { initThemeToggle } from "./theme.js";
import { initPairing } from "./pairing.js";

initLangToggle(document.getElementById("lang-toggle"));
initThemeToggle(document.getElementById("theme-toggle"));
initPairing(document.getElementById("pairing-root"));
