export const STRINGS = {
  pl: {
    langGroupLabel: "Język",
    themeGroupLabel: "Motyw",
    langAuto: "Auto",
    langPl: "PL",
    langEn: "EN",
    themeSystem: "System",
    themeLight: "Jasny",
    themeDark: "Ciemny",

    roleChooseTitle: "Jak chcesz sparować urządzenia?",
    roleReceive: "Odbierz",
    roleSend: "Wyślij",
    backButton: "Wstecz",

    receiverGenerating: "Generowanie sesji…",
    receiverWaiting: "Zeskanuj ten kod na drugim urządzeniu",
    receiverLinkLabel: "Lub wklej ten link na drugim urządzeniu:",

    senderChooseTitle: "Jak chcesz dołączyć?",
    senderScan: "Skanuj kamerą",
    senderPaste: "Wklej link ręcznie",
    senderPasteLabel: "Wklej link z drugiego urządzenia",
    senderPasteButton: "Dołącz",
    senderScanHint: "Wyceluj kamerą w kod QR",
    senderCameraError: "Brak dostępu do kamery. Użyj wklejania linku.",
    senderPasteInvalid: "To nie wygląda na poprawny link Quicksend.",

    joinDetectedTitle: "Wykryto sesję parowania",
    joinDetectedButton: "Dołącz do sesji",
    joinDetectedCancel: "Anuluj",

    statusConnecting: "Łączenie…",
    statusJoining: "Dołączanie…",
    statusPaired: "Sparowano!",
    statusPairedHost: "Sparowano! Drugie urządzenie dołączyło.",
    statusPairedGuest: "Sparowano z drugim urządzeniem.",

    errSessionNotFound: "Nie znaleziono sesji. Link może być nieaktualny.",
    errSessionFull: "Ta sesja ma już dwoje uczestników.",
    errTooManySessions: "Zbyt wiele aktywnych sesji z tego urządzenia.",
    errGeneric: "Coś poszło nie tak. Spróbuj ponownie.",
    tryAgain: "Spróbuj ponownie",
  },
  en: {
    langGroupLabel: "Language",
    themeGroupLabel: "Theme",
    langAuto: "Auto",
    langPl: "PL",
    langEn: "EN",
    themeSystem: "System",
    themeLight: "Light",
    themeDark: "Dark",

    roleChooseTitle: "How do you want to pair devices?",
    roleReceive: "Receive",
    roleSend: "Send",
    backButton: "Back",

    receiverGenerating: "Generating session…",
    receiverWaiting: "Scan this code on the other device",
    receiverLinkLabel: "Or paste this link on the other device:",

    senderChooseTitle: "How do you want to join?",
    senderScan: "Scan with camera",
    senderPaste: "Paste link manually",
    senderPasteLabel: "Paste the link from the other device",
    senderPasteButton: "Join",
    senderScanHint: "Point your camera at the QR code",
    senderCameraError: "Camera access unavailable. Use paste instead.",
    senderPasteInvalid: "That doesn't look like a valid Quicksend link.",

    joinDetectedTitle: "Pairing session detected",
    joinDetectedButton: "Join session",
    joinDetectedCancel: "Cancel",

    statusConnecting: "Connecting…",
    statusJoining: "Joining…",
    statusPaired: "Paired!",
    statusPairedHost: "Paired! The other device has joined.",
    statusPairedGuest: "Paired with the other device.",

    errSessionNotFound: "Session not found. The link may be stale.",
    errSessionFull: "This session already has two participants.",
    errTooManySessions: "Too many active sessions from this device.",
    errGeneric: "Something went wrong. Please try again.",
    tryAgain: "Try again",
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
