// Citizen page translations. Every key needs a real Hindi value - the i18n
// test fails on an English copy. Text not listed here stays in English.
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
    areaUnknown: "UNKNOWN",
    areaNeedLocation: "Share your location to check the hazard level in your area.",
    areaChecking: "Checking active hazard zones near you...",
    sosHintAvailable: "Tap SOS if you need emergency help - responders will receive your location.",
    sosHintHighRisk: "High risk detected nearby. Tap SOS to alert responders.",
    sosHintActive: "Your SOS is already active. Responders have been notified - waiting for it to be resolved.",
    sosHintLocating: "Detecting your location - SOS unlocks once your area's risk is confirmed.",
    sosHintSending: "Sending your SOS...",
    // HUMAN REVIEW: safety message - mentions the map fallback (sos-manual-location)
    sosHintNeedLocation: "Allow location access (tap “Get My Location”) or set your location on the map - SOS needs your location to send help.",
    // Area status card. The per-hazard actions come from lib/advice.ts.
    riskLOW: "LOW RISK",
    riskMEDIUM: "MEDIUM RISK",
    riskHIGH: "HIGH RISK",
    riskCRITICAL: "CRITICAL RISK",
    areaLowDesc: "SANJEEVNI is monitoring environmental conditions in your area.",
    hazardInArea: "Active hazard in your area:",
    whatToDo: "What to do now:",
    // "Set my location on a map" fallback when the device location fails.
    // HUMAN REVIEW: safety message (it tells the person responders will
    // treat the point as approximate) - check the wording before release.
    manualOffer: "Set my location on a map",
    manualTitle: "Set your location on the map",
    manualHelp:
      "Location is not available. Tap the place where you are on the map, or type its coordinates below. Responders will see that you set it by hand and that it may be approximate.",
    manualLat: "Latitude",
    manualLon: "Longitude",
    manualApply: "Use these coordinates",
    // Card intros
    locateIntro: "Allow location access to find nearby safe locations and active danger zones.",
    sosIntro: "If you are in immediate danger, send your location to the SANJEEVNI emergency response system.",
    // Hospital card. {km} etc. are filled in by t(lang, key, params).
    // HUMAN REVIEW: safety-critical citizen text (why a farther hospital is shown, "call 112").
    hospTitle: "Nearest Hospital & Route",
    hospDistance: "{km} km away (straight-line distance; the road route may be longer)",
    hospDirections: "Directions to hospital",
    hospError: "Could not look up the nearest hospital right now.",
    hospWaiting: "Waiting for your location to look up the nearest hospital...",
    hospSkipped:
      "{hospital} ({km} km) is closer, but it is inside an active {hazard} zone ({severity}), so the nearest hospital outside the danger area is shown.",
    hospInZone:
      "Every nearby hospital is inside an active hazard zone. This one is the closest, but it is inside an active {hazard} zone ({severity}) - call 112 before travelling.",
    noteLabel: "Optional: describe your situation",
    notePlaceholder: "e.g. trapped by flood water, number of people",
    // Location status line under "Get My Location". {msg} is the browser's own
    // (English) error text. locSentInstead, locReplacesManual and locManualKept
    // are appended after another loc* sentence.
    // HUMAN REVIEW: safety-critical citizen text - check wording before release.
    locAuto: "Detecting your location automatically...",
    locGetting: "Getting your location...",
    locDetected: "Location detected ({lat}, {lon}).",
    locSentInstead: "It was sent instead of the point you set on the map.",
    locReplacesManual: "It replaces the point you set on the map.",
    locNeedSilent: "Location access needed to check your area and find the nearest hospital. Tap “Get My Location” to allow it.",
    locDenied: "Could not get location: {msg}. Please enable location access and try again.",
    locRetry: "Could not get location: {msg}. Please try again, near a window or outdoors if you can.",
    locManualKept: "The point you set on the map is still used.",
    locManualSet:
      "Location set by hand on the map ({lat}, {lon}). Responders will see that it was set by hand and may be approximate.",
    // Device fix less exact than APPROX_LOCATION_M (lib/sos.ts) - typical on a
    // device without GPS (Wi-Fi / cell / IP position). {acc} is e.g. "±2.3 km".
    // Never blocks SOS: it only offers the map.
    // HUMAN REVIEW: safety-critical citizen text - check wording before release.
    approxNotice: "Your location is approximate (about {acc}). If you can, check it or set your location on the map.",
    approxSetOnMap: "Check / set my location on the map",
    locApproxManualKept: "Your device location is only approximate ({acc}), so the point you set on the map is still used.",
  },
  hi: {
    portalLabel: "नागरिक पोर्टल",
    // HUMAN REVIEW: safety-critical citizen text, Hindi needs native-speaker check
    // (connection status: tells the person whether an SOS can reach the server)
    connecting: "संजीवनी सर्वर से जुड़ रहे हैं...",
    connected: "संजीवनी सर्वर से जुड़े हैं।",
    disconnected: "संजीवनी सर्वर से संपर्क नहीं हो पा रहा है।",
    checkSafety: "अपने क्षेत्र की सुरक्षा जांचें",
    getLocation: "मेरा स्थान प्राप्त करें",
    areaSafety: "वर्तमान क्षेत्र सुरक्षा",
    needHelp: "आपातकालीन सहायता चाहिए?",
    sosButton: "एसओएस",
    riskScoreLabel: "जोखिम स्कोर",
    // HUMAN REVIEW: safety-critical citizen text, Hindi needs native-speaker check
    // (these were English copies; the i18n test now refuses English copies)
    areaUnknown: "अज्ञात",
    areaNeedLocation: "अपने क्षेत्र का खतरा स्तर जांचने के लिए अपनी लोकेशन साझा करें।",
    areaChecking: "आपके आस-पास के सक्रिय खतरा क्षेत्रों की जांच की जा रही है...",
    sosHintAvailable: "आपातकालीन सहायता चाहिए तो एसओएस दबाएं - आपकी लोकेशन सहायता दल को भेजी जाएगी।",
    sosHintHighRisk: "आस-पास उच्च जोखिम पाया गया। मदद के लिए एसओएस दबाएं।",
    sosHintActive: "आपका एसओएस पहले से सक्रिय है। सहायता दल को सूचित कर दिया गया है - समाधान की प्रतीक्षा है।",
    // HUMAN REVIEW: safety-critical citizen text, Hindi needs native-speaker check
    // sosHintNeedLocation is the hint a Hindi user sees when GPS is denied. The
    // quoted button name must stay equal to getLocation (the i18n test checks it).
    sosHintLocating: "आपकी लोकेशन पता की जा रही है - क्षेत्र का जोखिम पुष्टि होने पर एसओएस चालू होगा।",
    sosHintSending: "आपका एसओएस भेजा जा रहा है...",
    sosHintNeedLocation:
      "लोकेशन की अनुमति दें (“मेरा स्थान प्राप्त करें” दबाएं) या मानचित्र पर अपना स्थान चुनें - मदद भेजने के लिए एसओएस को आपकी लोकेशन चाहिए।",
    // HUMAN REVIEW: needs native-speaker review (safety message) - added
    // with the shared hazard advice table, not yet checked.
    riskLOW: "कम जोखिम",
    riskMEDIUM: "मध्यम जोखिम",
    riskHIGH: "उच्च जोखिम",
    riskCRITICAL: "गंभीर जोखिम",
    areaLowDesc: "संजीवनी आपके क्षेत्र की पर्यावरणीय स्थितियों की निगरानी कर रहा है।",
    hazardInArea: "आपके क्षेत्र में सक्रिय खतरा:",
    whatToDo: "अभी क्या करें:",
    // HUMAN REVIEW: needs native-speaker review (safety message) - added
    // with the map location fallback, not yet checked.
    manualOffer: "मानचित्र पर अपना स्थान चुनें",
    manualTitle: "मानचित्र पर अपना स्थान चुनें",
    manualHelp:
      "स्थान उपलब्ध नहीं है। मानचित्र पर उस जगह को टैप करें जहाँ आप हैं, या नीचे उसके निर्देशांक लिखें। सहायता दल को दिखेगा कि यह स्थान आपने स्वयं चुना है और अनुमानित हो सकता है।",
    manualLat: "अक्षांश (Latitude)",
    manualLon: "देशांतर (Longitude)",
    manualApply: "ये निर्देशांक उपयोग करें",
    // HUMAN REVIEW: safety-critical citizen text, Hindi needs native-speaker check
    locateIntro: "आस-पास के सुरक्षित स्थान और सक्रिय खतरा क्षेत्र जानने के लिए लोकेशन की अनुमति दें।",
    sosIntro: "अगर आप तुरंत खतरे में हैं, तो अपनी लोकेशन संजीवनी आपातकालीन सहायता प्रणाली को भेजें।",
    // HUMAN REVIEW: safety-critical citizen text, Hindi needs native-speaker check
    hospTitle: "निकटतम अस्पताल और रास्ता",
    hospDistance: "{km} किमी दूर (सीधी रेखा की दूरी; सड़क का रास्ता इससे लंबा हो सकता है)",
    hospDirections: "अस्पताल का रास्ता देखें",
    hospError: "अभी निकटतम अस्पताल की जानकारी नहीं मिल सकी।",
    hospWaiting: "निकटतम अस्पताल खोजने के लिए आपकी लोकेशन की प्रतीक्षा है...",
    hospSkipped:
      "{hospital} ({km} किमी) ज़्यादा पास है, लेकिन वह सक्रिय {hazard} क्षेत्र ({severity}) के अंदर है, इसलिए खतरा क्षेत्र के बाहर का निकटतम अस्पताल दिखाया गया है।",
    hospInZone:
      "आस-पास के सभी अस्पताल सक्रिय खतरा क्षेत्र के अंदर हैं। यह सबसे पास है, लेकिन यह सक्रिय {hazard} क्षेत्र ({severity}) के अंदर है - जाने से पहले 112 पर कॉल करें।",
    noteLabel: "वैकल्पिक: अपनी स्थिति बताएं",
    notePlaceholder: "जैसे: बाढ़ के पानी में फंसे हैं, कितने लोग हैं",
    // HUMAN REVIEW: safety-critical citizen text, Hindi needs native-speaker check
    locAuto: "आपकी लोकेशन अपने-आप पता की जा रही है...",
    locGetting: "आपकी लोकेशन ली जा रही है...",
    locDetected: "लोकेशन मिल गई ({lat}, {lon})।",
    locSentInstead: "मानचित्र पर चुने गए स्थान की जगह यही लोकेशन भेजी गई।",
    locReplacesManual: "यह मानचित्र पर चुने गए स्थान की जगह लेती है।",
    locNeedSilent:
      "आपके क्षेत्र की जांच और निकटतम अस्पताल खोजने के लिए लोकेशन की अनुमति चाहिए। अनुमति देने के लिए “मेरा स्थान प्राप्त करें” दबाएं।",
    locDenied: "लोकेशन नहीं मिल सकी: {msg}। कृपया लोकेशन की अनुमति चालू करें और फिर से कोशिश करें।",
    locRetry: "लोकेशन नहीं मिल सकी: {msg}। कृपया फिर से कोशिश करें, हो सके तो खिड़की के पास या खुले में।",
    locManualKept: "मानचित्र पर आपका चुना हुआ स्थान अभी भी उपयोग हो रहा है।",
    locManualSet:
      "स्थान मानचित्र पर स्वयं चुना गया ({lat}, {lon})। सहायता दल को दिखेगा कि यह स्वयं चुना गया है और अनुमानित हो सकता है।",
    // HUMAN REVIEW: new approximate-location text - Hindi needs native-speaker review
    approxNotice: "आपकी लोकेशन अनुमानित है (लगभग {acc})। हो सके तो इसे जाँचें या मानचित्र पर अपना स्थान चुनें।",
    approxSetOnMap: "मानचित्र पर अपना स्थान जाँचें / चुनें",
    locApproxManualKept: "आपके डिवाइस की लोकेशन केवल अनुमानित है ({acc}), इसलिए मानचित्र पर आपका चुना हुआ स्थान ही उपयोग हो रहा है।",
  },
} as const;

export type StringKey = keyof (typeof STRINGS)["en"];
export const STRING_KEYS = Object.keys(STRINGS.en) as StringKey[];

/**
 * The text for key in lang. {name} placeholders are filled from params; one
 * that params doesn't name is left as is. A replacer function (not a
 * replacement string) so a value such as a browser error message containing
 * "$&" is inserted literally, and an inserted value is never re-scanned.
 */
export function t(lang: Lang, key: StringKey, params?: Record<string, string | number>): string {
  const text: string = STRINGS[lang][key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}
