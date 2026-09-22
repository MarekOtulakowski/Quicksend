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
    shareSecurityWarning: "Każdy, kto ma ten link lub kod QR, może dołączyć do tego transferu. Udostępnij go tylko osobie, do której wysyłasz plik.",
    shareButton: "Udostępnij",
    shareCopied: "Skopiowano do schowka",
    shareCopyManually: "Zaznacz i skopiuj powyższy tekst ręcznie",
    copyCodeButton: "Kopiuj kod",

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

    methodChooseTitle: "Wybierz sposób parowania",
    methodQR: "Kod QR (razem fizycznie)",
    methodCode: "Kod (zdalnie)",

    codeReceiverWaiting: "Podaj ten kod drugiej osobie (dowolnym kanałem)",
    codeExpiryNote: "Kod jest ważny 5 minut i można go użyć tylko raz.",
    codeSenderLabel: "Wpisz kod otrzymany od drugiej osoby",

    statusConnecting: "Łączenie…",
    statusJoining: "Dołączanie…",
    statusVerifying: "Weryfikowanie kodu…",
    statusPaired: "Sparowano!",
    statusPairedHost: "Sparowano! Drugie urządzenie dołączyło.",
    statusPairedGuest: "Sparowano z drugim urządzeniem.",

    errSessionNotFound: "Nie znaleziono sesji. Link może być nieaktualny.",
    errSessionFull: "Ta sesja ma już dwoje uczestników.",
    errTooManySessions: "Zbyt wiele aktywnych sesji z tego urządzenia.",
    errInvalidCode: "Nieprawidłowy lub wygasły kod.",
    errTooManyAttempts: "Zbyt wiele prób. Poczekaj chwilę i spróbuj ponownie.",
    errCodeMismatch: "Kod się nie zgadza po obu stronach. Spróbujcie ponownie z nowym kodem.",
    errConnectionLost: "Utracono połączenie i nie udało się go wznowić.",
    errSessionEnded: "Sesja zakończona — drugie urządzenie nie wróciło na czas.",
    errGeneric: "Coś poszło nie tak. Spróbuj ponownie.",
    tryAgain: "Spróbuj ponownie",
    reconnecting: "Połączenie przerwane, próba wznowienia…",

    swapRolesButton: "Zamień się rolami",
    swapRequesting: "Czekam na zgodę drugiej strony…",
    swapRejected: "Druga strona odrzuciła zamianę (trwa transfer). Spróbuj ponownie za chwilę.",
    swapBusyLocal: "Zaczekaj, aż bieżący transfer się zakończy.",
    swapTimedOut: "Brak odpowiedzi. Spróbuj ponownie.",

    transferSenderHint: "Wybierz pliki do wysłania",
    transferWaitingForFiles: "Czekam na pliki…",
    transferReceivingFiles: "Odbieranie plików…",
    transferSending: "Wysyłanie…",
    transferSent: "Wysłano",
    transferSavedToDisk: "Zapisano na dysku",
    transferDownloaded: "Pobrano",
    transferError: "Błąd transferu",
    transferCanceled: "Anulowano",
    transferTooLarge: "Plik zbyt duży — przekroczono limit rozmiaru",
    transferLargeFileWarning: "Duży plik bez wsparcia zapisu na dysk — może zużyć dużo pamięci przeglądarki.",
    cancelButton: "Anuluj",
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
    shareSecurityWarning: "Anyone with this link or QR code can join this transfer. Only share it with the person you're sending the file to.",
    shareButton: "Share",
    shareCopied: "Copied to clipboard",
    shareCopyManually: "Select and copy the text above manually",
    copyCodeButton: "Copy code",

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

    methodChooseTitle: "Choose a pairing method",
    methodQR: "QR code (physically together)",
    methodCode: "Code (remote)",

    codeReceiverWaiting: "Give this code to the other person (any channel)",
    codeExpiryNote: "The code is valid for 5 minutes and can only be used once.",
    codeSenderLabel: "Enter the code you got from the other person",

    statusConnecting: "Connecting…",
    statusJoining: "Joining…",
    statusVerifying: "Verifying code…",
    statusPaired: "Paired!",
    statusPairedHost: "Paired! The other device has joined.",
    statusPairedGuest: "Paired with the other device.",

    errSessionNotFound: "Session not found. The link may be stale.",
    errSessionFull: "This session already has two participants.",
    errTooManySessions: "Too many active sessions from this device.",
    errInvalidCode: "Invalid or expired code.",
    errTooManyAttempts: "Too many attempts. Wait a bit and try again.",
    errCodeMismatch: "The code didn't match on both sides. Try again with a new code.",
    errConnectionLost: "Connection lost and couldn't be resumed.",
    errSessionEnded: "Session ended — the other device didn't come back in time.",
    errGeneric: "Something went wrong. Please try again.",
    tryAgain: "Try again",
    reconnecting: "Connection lost, trying to reconnect…",

    swapRolesButton: "Swap roles",
    swapRequesting: "Waiting for the other side to agree…",
    swapRejected: "The other side declined (a transfer is in progress). Try again shortly.",
    swapBusyLocal: "Wait for the current transfer to finish first.",
    swapTimedOut: "No response. Try again.",

    transferSenderHint: "Choose files to send",
    transferWaitingForFiles: "Waiting for files…",
    transferReceivingFiles: "Receiving files…",
    transferSending: "Sending…",
    transferSent: "Sent",
    transferSavedToDisk: "Saved to disk",
    transferDownloaded: "Downloaded",
    transferError: "Transfer error",
    transferCanceled: "Canceled",
    transferTooLarge: "File too large — exceeded the size limit",
    transferLargeFileWarning: "Large file without disk-write support — may use a lot of browser memory.",
    cancelButton: "Cancel",
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
