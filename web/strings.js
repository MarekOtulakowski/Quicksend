export const STRINGS = {
  pl: {
    tagline: "Relay i logika transferu w budowie.",
    langGroupLabel: "Język",
    themeGroupLabel: "Motyw",
    langAuto: "Auto",
    langPl: "PL",
    langEn: "EN",
    themeSystem: "System",
    themeLight: "Jasny",
    themeDark: "Ciemny",
  },
  en: {
    tagline: "Relay and transfer logic under construction.",
    langGroupLabel: "Language",
    themeGroupLabel: "Theme",
    langAuto: "Auto",
    langPl: "PL",
    langEn: "EN",
    themeSystem: "System",
    themeLight: "Light",
    themeDark: "Dark",
  },
};

export const DEFAULT_LOCALE = "en";

export function detectLocale() {
  const langs = navigator.languages && navigator.languages.length
    ? navigator.languages
    : [navigator.language || DEFAULT_LOCALE];
  for (const l of langs) {
    const base = l.toLowerCase().slice(0, 2);
    if (base === "pl") return "pl";
    if (base === "en") return "en";
  }
  return DEFAULT_LOCALE;
}
