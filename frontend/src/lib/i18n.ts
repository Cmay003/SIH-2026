// Citizen page translations - the same strings the classic sos.html
// translated. Text not listed here stays in English, as before.
// Have a native speaker review any new Hindi text: these are safety messages.
export type Lang = "en" | "hi";

const STRINGS = {
  en: {
    portalLabel: "USER PORTAL",
    connecting: "Connecting to SANJEEVNI server...",
    connected: "Connected to SANJEEVNI server.",
    disconnected: "Unable to connect to SANJEEVNI server.",
    checkSafety: "Check Your Safety Area",
    getLocation: "Get My Location",
    areaSafety: "Current area safety",
    needHelp: "Need Emergency Help?",
    sosButton: "SOS",
    riskScoreLabel: "Risk score",
    sosHintAvailable: "Tap SOS if you need emergency help - responders will receive your location.",
    sosHintHighRisk: "High risk detected nearby. Tap SOS to alert responders.",
    sosHintActive: "Your SOS is already active. Responders have been notified - waiting for it to be resolved.",
    sosHintLocating: "Detecting your location - SOS unlocks once your area's risk is confirmed.",
    sosHintSending: "Sending your SOS...",
    sosHintNeedLocation: "Allow location access (tap “Get My Location”) - SOS needs your location to send help.",
  },
  hi: {
    portalLabel: "नागरिक पोर्टल",
    connecting: "सांजीवनी सर्वर से जुड़ रहे हैं...",
    connected: "Connected to SANJEEVNI server.",
    disconnected: "Unable to connect to SANJEEVNI server.",
    checkSafety: "अपने क्षेत्र की सुरक्षा जांचें",
    getLocation: "मेरा स्थान प्राप्त करें",
    areaSafety: "वर्तमान क्षेत्र सुरक्षा",
    needHelp: "आपातकालीन सहायता चाहिए?",
    sosButton: "एसओएस",
    riskScoreLabel: "जोखिम स्कोर",
    sosHintAvailable: "आपातकालीन सहायता चाहिए तो एसओएस दबाएं - आपकी लोकेशन सहायता दल को भेजी जाएगी।",
    sosHintHighRisk: "आस-पास उच्च जोखिम पाया गया। मदद के लिए एसओएस दबाएं।",
    sosHintActive: "आपका एसओएस पहले से सक्रिय है। सहायता दल को सूचित कर दिया गया है - समाधान की प्रतीक्षा है।",
    sosHintLocating: "Detecting your location - SOS unlocks once your area's risk is confirmed.",
    sosHintSending: "Sending your SOS...",
    sosHintNeedLocation: "Allow location access (tap “Get My Location”) - SOS needs your location to send help.",
  },
} as const;

export type StringKey = keyof (typeof STRINGS)["en"];
export const t = (lang: Lang, key: StringKey): string => STRINGS[lang][key];
