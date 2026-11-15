// Classification: Gemini (if GEMINI_API_KEY is set) with a keyword fallback,
// so the demo always works even with no network / no key.
import fs from "fs";

const CATEGORIES = [
  "plumbing",
  "electrical",
  "lighting",
  "hvac",
  "elevator",
  "door_lock",
  "furniture",
  "custodial",
  "pest",
  "safety_hazard",
  "grounds",
  "other",
];

const EMERGENCY_HINTS = [
  "flood",
  "flooding",
  "burst",
  "gushing",
  "sparking",
  "smoke",
  "fire",
  "gas",
  "exposed wire",
  "sewage",
  "ceiling collapsing",
  "glass everywhere",
];

const KEYWORDS = {
  plumbing: ["leak", "leaking", "drip", "toilet", "sink", "faucet", "water fountain", "pipe", "clog", "flood"],
  electrical: ["outlet", "socket", "power", "breaker", "sparking", "wire", "charging"],
  lighting: ["light", "bulb", "lamp", "flickering", "dark"],
  hvac: ["ac", "a/c", "heat", "heating", "cold", "hot", "thermostat", "air conditioning", "vent"],
  elevator: ["elevator", "lift", "stuck"],
  door_lock: ["door", "lock", "handle", "buzzcard", "card reader", "hinge"],
  furniture: ["chair", "desk", "table", "couch", "whiteboard", "projector screen", "broken seat"],
  custodial: ["trash", "spill", "dirty", "mess", "vomit", "overflowing bin", "restroom supplies", "soap", "paper towel"],
  pest: ["roach", "rat", "mouse", "ants", "bug", "wasp", "pest", "rodent"],
  safety_hazard: ["broken glass", "exposed wire", "hole in", "tripping", "falling", "ice", "hazard", "smoke", "fire", "gas"],
  grounds: ["sidewalk", "pothole", "tree", "sprinkler", "bench", "lamp post", "crosswalk", "bike rack"],
};

export function fallbackClassify(text = "") {
  const t = text.toLowerCase();
  let category = "other";
  let best = 0;
  for (const [cat, words] of Object.entries(KEYWORDS)) {
    const hits = words.filter((w) => t.includes(w)).length;
    if (hits > best) {
      best = hits;
      category = cat;
    }
  }
  const emergency = EMERGENCY_HINTS.some((w) => t.includes(w));
  return {
    category,
    urgency: emergency ? "emergency" : category === "safety_hazard" ? "high" : "normal",
    title: text ? text.slice(0, 60) : "Maintenance issue",
    summary: text || "Issue reported via photo.",
    building_guess: null,
    source: "keyword-fallback",
  };
}

// Single source of truth for the model name (server.js logs it on startup).
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
export const GEMINI_ENABLED = Boolean(process.env.GEMINI_API_KEY);

export async function classify({ text, photoPath, photoMime }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return fallbackClassify(text);

  try {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey: key });
    const model = GEMINI_MODEL;

    const parts = [];
    if (photoPath && fs.existsSync(photoPath)) {
      parts.push({
        inlineData: {
          mimeType: photoMime || "image/jpeg",
          data: fs.readFileSync(photoPath).toString("base64"),
        },
      });
    }
    parts.push({
      text:
        `You triage campus maintenance reports at Georgia Tech. ` +
        `Given the photo and/or student note, return STRICT JSON only:\n` +
        `{"category": one of ${JSON.stringify(CATEGORIES)}, ` +
        `"urgency": "normal"|"high"|"emergency", ` +
        `"title": short 6-10 word title, ` +
        `"summary": 1 sentence a facilities tech would find useful, ` +
        `"building_guess": building name if visible/mentioned else null}\n` +
        `"emergency" means active water flow, sparking, smoke, gas, or danger to people.\n` +
        `Student note: ${text || "(none)"}`,
    });

    const res = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
    });
    const raw = res.text ?? res.response?.text?.() ?? "";
    const json = JSON.parse(raw.replace(/```json|```/g, "").trim());
    if (!CATEGORIES.includes(json.category)) json.category = "other";
    json.source = `gemini:${model}`;
    return json;
  } catch (err) {
    console.error("Gemini classify failed, using fallback:", err.message);
    const out = fallbackClassify(text);
    out.source = "keyword-fallback (gemini error)";
    return out;
  }
}

// Parse a free-text location reply ("klaus 2nd floor by the elevators") into
// { building_hint, detail }. Gemini when available, otherwise a light heuristic.
export async function parseLocationReply(text, buildingNames = []) {
  const raw = (text || "").trim();
  if (!raw) return { building_hint: null, detail: "" };

  if (process.env.GEMINI_API_KEY) {
    try {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const res = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{
          role: "user",
          parts: [{
            text:
              `A Georgia Tech student is telling us WHERE a maintenance problem is. ` +
              `Known buildings: ${buildingNames.join("; ")}.\n` +
              `Return STRICT JSON only: {"building_hint": the matching building name from the list or null, ` +
              `"detail": floor/room/landmark text a technician needs (e.g. "2nd floor, men's restroom by elevators"), or "" }.\n` +
              `Student reply: "${raw}"`,
          }],
        }],
      });
      const out = res.text ?? res.response?.text?.() ?? "";
      const j = JSON.parse(out.replace(/```json|```/g, "").trim());
      return { building_hint: j.building_hint || null, detail: (j.detail || "").trim() };
    } catch (err) {
      console.error("parseLocationReply Gemini failed, using heuristic:", err.message);
    }
  }
  // Heuristic: everything is detail; building matching happens via aliases in server.js.
  return { building_hint: null, detail: raw };
}
