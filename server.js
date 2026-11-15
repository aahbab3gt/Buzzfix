import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import twilio from "twilio";
import exifParser from "exif-parser";
import { classify, parseLocationReply, GEMINI_MODEL, GEMINI_ENABLED } from "./classify.js";
import { nearestBuilding, parseLatLng, reverseGeocode, mapsLink } from "./geo.js";
import { route, draftEmail, emergencyContacts } from "./routing.js";
import {
  nextTicket,
  addReport,
  getReports,
  getReport,
  updateReport,
  getLatestReportBySender,
  getAwaitingReportForSender,
  resetAll,
  addOutbox,
  getOutbox,
  findDuplicate,
  optOut,
  optIn,
  isOptedOut,
  getOptOuts,
} from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

const buildings = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "buildings.json"), "utf8"));

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, "uploads"),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, "_")}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.static(path.join(__dirname, "public")));

function extractExifGps(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const buf = fs.readFileSync(filePath);
    const parser = exifParser.create(buf);
    const result = parser.parse();
    if (result && result.tags && typeof result.tags.GPSLatitude === "number" && typeof result.tags.GPSLongitude === "number") {
      return {
        lat: result.tags.GPSLatitude,
        lng: result.tags.GPSLongitude,
      };
    }
  } catch (err) {
    // Non-fatal: Not a JPEG or stripped EXIF
  }
  return null;
}

function slimBuilding(b) {
  return b ? { id: b.id, name: b.name, number: b.number, type: b.type, lat: b.lat, lng: b.lng } : null;
}

// Resolve a GPS fix into everything the dashboard needs: nearest building, distance, street address.
// Priority of GPS sources: browser/WhatsApp pin (fresh, accurate) > EXIF (often stripped by carriers).
async function resolveLocation(gps) {
  if (!gps) return null;
  const near = nearestBuilding(buildings, gps.lat, gps.lng);
  const geo = await reverseGeocode(gps.lat, gps.lng);
  return {
    gps,
    nearest: near ? { ...slimBuilding(near.building), distanceMeters: near.distanceMeters } : null,
    address: geo?.short || null,
    addressFull: geo?.full || null,
    mapsUrl: mapsLink(gps.lat, gps.lng),
  };
}

// ── SMS location conversation ──────────────────────────────────────────────
// A report "awaits location" until we have a building AND some room/floor detail,
// or we've asked twice. Window: 20 min from the last message in the thread.
const LOCATION_WINDOW_MS = 20 * 60 * 1000;

function needsLocation(r) {
  const hasBuilding = r.building && r.building.id !== "gps-pin";
  return !hasBuilding || !(r.location && r.location.trim());
}

function isAwaitingLocation(r) {
  if (!r.awaitingLocation) return false;
  const last = new Date(r.lastPromptAt || r.createdAt).getTime();
  return Date.now() - last < LOCATION_WINDOW_MS;
}

function locationQuestion(r) {
  const hasBuilding = r.building && r.building.id !== "gps-pin";
  const hasDetail = Boolean(r.location && r.location.trim());
  if (!hasBuilding && hasDetail) return `Which building is that in?`;
  if (!hasBuilding) return `Where is this? Reply with building + floor/room (e.g. "Klaus 2nd floor by the elevators").`;
  return `Which floor or room in ${r.building.name}? (e.g. "3rd floor men's restroom")`;
}

// Mark a fresh report as waiting and return the question to append to the reply.
function startLocationPrompt(r) {
  if (!needsLocation(r)) return "";
  r.awaitingLocation = true;
  r.locationAsks = 1;
  r.lastPromptAt = new Date().toISOString();
  updateReport(r.id, r);
  return `\n❓ ${locationQuestion(r)}`;
}

async function handleLocationReply(r, text) {
  const parsed = await parseLocationReply(text, buildings.map((b) => b.name));
  const b = matchBuilding(text) || matchBuilding(parsed.building_hint);
  const hadBuilding = r.building && r.building.id !== "gps-pin";

  if (b && (!hadBuilding || r.buildingSource !== "user")) {
    r.building = slimBuilding(b);
    r.buildingSource = "user";
  }
  // Keep the student's words, minus the building name/alias itself (that lives in r.building).
  let detail = parsed.detail || text.trim();
  if (b) {
    for (const term of [b.name, ...(b.aliases || [])].sort((x, y) => y.length - x.length)) {
      detail = detail.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "");
    }
    detail = detail.replace(/^[\s,.\-–:]+|[\s,.\-–:]+$/g, "").replace(/\s{2,}/g, " ");
    // Drop replies that were only filler around the building name ("it's in", "at the").
    const filler = /^(it'?s|its|in|at|the|inside|near|building|bldg|on|campus|is)(\s+(it'?s|its|in|at|the|inside|near|building|bldg|on|campus|is))*$/i;
    if (filler.test(detail)) detail = "";
  }
  if (detail) r.location = r.location ? `${r.location}, ${detail}` : detail;

  const stillNeeds = needsLocation(r);
  const asks = (r.locationAsks || 1);
  if (stillNeeds && asks < 2) {
    r.locationAsks = asks + 1;
    r.lastPromptAt = new Date().toISOString();
    r.awaitingLocation = true;
    updateReport(r.id, r);
    const got = r.building && r.building.id !== "gps-pin" ? `📍 ${r.building.name} noted.` : `📝 Noted: "${detail}".`;
    return `🐝 [BuzzFix] ${got}\n❓ ${locationQuestion(r)}`;
  }

  r.awaitingLocation = false;
  updateReport(r.id, r);
  const where = [r.building && r.building.id !== "gps-pin" ? `${r.building.name}${r.building.number ? ` (Bldg #${r.building.number})` : ""}` : null, r.location]
    .filter(Boolean).join(" · ");
  return `🐝 [BuzzFix] Location saved for ${r.id}!\n📍 ${where || "Campus"}\nTechnicians can see it on the map now. We'll text you updates. (Reply STOP to opt out)`;
}

// Apply a resolved location onto a report (mutates). Only overrides the building if the report
// had none, or only had a GPS pin / text guess, so an explicit building choice always wins.
function applyLocation(report, loc, { overrideBuilding = false } = {}) {
  if (!loc) return report;
  report.gps = loc.gps;
  report.address = loc.address;
  report.addressFull = loc.addressFull;
  report.mapsUrl = loc.mapsUrl;
  report.nearestBuilding = loc.nearest;
  const weakBuilding = !report.building || report.building.id === "gps-pin" || report.buildingSource === "text";
  if (loc.nearest && (overrideBuilding || weakBuilding)) {
    const { distanceMeters, ...b } = loc.nearest;
    report.building = b;
    report.buildingSource = "gps";
  } else if (!report.building) {
    report.building = { id: "gps-pin", name: loc.address || "Pinned location", number: "", type: "outdoor", lat: loc.gps.lat, lng: loc.gps.lng };
    report.buildingSource = "gps";
  }
  return report;
}

function matchBuilding(input) {
  if (!input) return null;
  const t = String(input).toLowerCase();
  return (
    buildings.find((b) => b.id.toLowerCase() === t) ||
    buildings.find((b) => t.includes(b.name.toLowerCase())) ||
    buildings.find((b) => b.aliases && b.aliases.some((a) => t.includes(a.toLowerCase()))) ||
    null
  );
}

app.get("/api/buildings", (_req, res) => res.json(buildings));

// Lets the dashboard know what's actually live (so it never claims an SMS went out when it didn't).
app.get("/api/config", (_req, res) =>
  res.json({ smsEnabled: Boolean(twilioClient), geminiEnabled: GEMINI_ENABLED, geminiModel: GEMINI_MODEL })
);

function baseUrlFor(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
  return `${proto}://${host}`;
}

// Core maintenance report processor used by both Web and SMS/WhatsApp intake
async function processReport({
  text = "",
  buildingId = "",
  location = "",
  photoPath = null,
  photoMime = null,
  photoUrl = null,
  source = "web",
  sender = null,
  gps = null, // { lat, lng, accuracy, source: "browser" | "whatsapp" }
}) {
  const combinedText = `${text} ${location}`.trim();
  const ai = await classify({
    text: combinedText,
    photoPath,
    photoMime,
  });

  // GPS: a live fix (browser / WhatsApp pin) beats EXIF, which carriers usually strip anyway.
  const exifGps = extractExifGps(photoPath);
  const fix = gps || (exifGps ? { ...exifGps, accuracy: null, source: "exif" } : null);
  const loc = await resolveLocation(fix);

  // Building precedence: explicit pick > GPS within 400 m > text/AI guess.
  let building = null;
  let buildingSource = null;
  if (matchBuilding(buildingId)) { building = matchBuilding(buildingId); buildingSource = "user"; }
  else if (loc?.nearest) { building = buildings.find((b) => b.id === loc.nearest.id); buildingSource = "gps"; }
  else if (matchBuilding(text)) { building = matchBuilding(text); buildingSource = "text"; }
  else if (matchBuilding(ai.building_guess)) { building = matchBuilding(ai.building_guess); buildingSource = "ai"; }

  // Emergencies: don't file a form — tell them who to call RIGHT NOW (and still log it).
  const isEmergency = ai.urgency === "emergency";
  const contacts = isEmergency ? emergencyContacts(building?.type) : null;

  // Duplicate detection: same building + category, open, last 72h -> merge as upvote.
  // Only when we actually trust the building (user pick, GPS, or explicit text) and the
  // category is specific. "other" + an AI-guessed building merged unrelated reports in testing.
  const trustedBuilding = building && ["user", "gps", "text"].includes(buildingSource);
  const specificCategory = ai.category && ai.category !== "other";
  if (trustedBuilding && specificCategory && !isEmergency && process.env.DISABLE_DEDUPE !== "1") {
    const dup = findDuplicate(building.id, ai.category);
    if (dup) {
      dup.upvotes += 1;
      if (photoUrl) {
        if (!dup.photo) dup.photo = photoUrl;
        if (!dup.photos) dup.photos = [];
        dup.photos.push(photoUrl);
      }
      if (sender) {
        if (!dup.subscribers) dup.subscribers = dup.sender ? [dup.sender] : [];
        if (!dup.subscribers.includes(sender)) dup.subscribers.push(sender);
      }
      updateReport(dup.id, dup);
      return {
        merged: true,
        ticket: dup.id,
        message: `Already reported — you're the ${ordinal(dup.upvotes)} person. We bumped its priority.`,
        report: dup,
        building,
        emergency: null,
      };
    }
  }

  const id = nextTicket();
  const report = {
    id,
    createdAt: new Date().toISOString(),
    status: isEmergency ? "emergency" : "reported",
    category: ai.category,
    urgency: ai.urgency,
    title: ai.title,
    summary: ai.summary,
    aiSource: ai.source,
    text,
    location,
    source,
    sender,
    subscribers: sender ? [sender] : [],
    gps: null,
    address: null,
    mapsUrl: null,
    nearestBuilding: null,
    building: slimBuilding(building),
    buildingSource,
    photo: photoUrl,
    photos: photoUrl ? [photoUrl] : [],
    upvotes: 1,
  };
  applyLocation(report, loc);
  addReport(report);

  let routed = null;
  if (!isEmergency) {
    const r = route(report, building);
    const email = draftEmail(report, building, r);
    addOutbox(email);
    routed = { ...r, emailPreview: email };
    updateReport(id, { routedTo: r.label });
  }

  return {
    merged: false,
    ticket: id,
    emergency: isEmergency ? contacts : null,
    routed,
    report: getReport(id),
    building,
  };
}

// Web report endpoint
app.post("/api/report", upload.single("photo"), async (req, res) => {
  const { text = "", buildingId = "", location = "", lat, lng, accuracy } = req.body;
  const photoUrl = req.file ? `/uploads/${req.file.filename}` : null;
  const browserFix = parseLatLng(lat, lng, accuracy);

  const result = await processReport({
    text,
    buildingId,
    location,
    photoPath: req.file?.path,
    photoMime: req.file?.mimetype,
    photoUrl,
    source: "web",
    gps: browserFix ? { ...browserFix, source: "browser" } : null,
  });

  res.json({
    merged: result.merged,
    ticket: result.ticket,
    message: result.message,
    emergency: result.emergency,
    routed: result.routed,
    report: result.report,
  });
});

function escapeXml(unsafe = "") {
  return String(unsafe).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "'": return "&apos;";
      case '"': return "&quot;";
    }
  });
}

// Twilio SMS & WhatsApp Inbound Webhook
app.post("/api/sms", async (req, res) => {
  try {
    console.log("Incoming Twilio Webhook Full Body:", req.body);

    const bodyText = req.body.Body || "";
    const fromNumber = req.body.From || "";
    const numMedia = parseInt(req.body.NumMedia || "0", 10);

    const trimmed = bodyText.trim().toUpperCase();

    // Check opt-out keywords
    if (["STOP", "OPTOUT", "UNSUBSCRIBE", "CANCEL", "QUIT"].includes(trimmed)) {
      optOut(fromNumber);
      res.type("text/xml");
      return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>🐝 [BuzzFix]: You have opted out of SMS ticket updates. Reply START anytime to re-subscribe.</Message>
</Response>`);
    }

    // Check opt-in keywords
    if (["START", "RESUME", "SUBSCRIBE", "UNSTOP"].includes(trimmed)) {
      optIn(fromNumber);
      res.type("text/xml");
      return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>🐝 [BuzzFix]: You are re-subscribed to ticket updates! We will text you as repairs progress on campus.</Message>
</Response>`);
    }

    // Check ticket status query: e.g. "STATUS GT-1013" or "GT-1013"
    const ticketMatch = trimmed.match(/(GT-\d{4})/i);
    if (ticketMatch && (trimmed.startsWith("STATUS") || trimmed === ticketMatch[1].toUpperCase())) {
      const found = getReport(ticketMatch[1].toUpperCase());
      if (found) {
        const bldg = found.building?.name || "Campus";
        const st = (found.status || "reported").replace("_", " ").toUpperCase();
        res.type("text/xml");
        return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>🐝 [BuzzFix Status - ${found.id}]
Status: ${st}
Location: ${bldg}
Summary: ${found.title}
Updates: Enabled (Reply STOP to opt out)</Message>
</Response>`);
      }
    }

    // ── Location conversation ────────────────────────────────────────────────
    // If this sender's latest report is still waiting on a location, a text-only
    // reply is the answer, whatever it says. We never turn it into a new ticket.
    if (numMedia === 0 && trimmed.length > 0) {
      const recent = getAwaitingReportForSender(fromNumber);
      if (recent && isAwaitingLocation(recent)) {
        const reply = await handleLocationReply(recent, bodyText);
        res.type("text/xml");
        return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(reply)}</Message>
</Response>`);
      }
    }

    let photoPath = null;
    let photoMime = null;
    let photoUrl = null;

    if (numMedia > 0 && req.body.MediaUrl0) {
      try {
        const mediaUrl = req.body.MediaUrl0;
        photoMime = req.body.MediaContentType0 || "image/jpeg";
        const ext = photoMime.includes("png") ? "png" : photoMime.includes("webp") ? "webp" : "jpg";
        const filename = `${Date.now()}-sms.${ext}`;
        photoPath = path.join(__dirname, "uploads", filename);

        const headers = {};
        if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
          headers["Authorization"] =
            "Basic " + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
        }

        console.log(`Fetching MMS media from: ${mediaUrl}`);
        // Twilio redirects authenticated media requests to S3 with pre-signed query params.
        // We handle redirects manually so the Basic Auth header is NOT sent to S3 (which S3 rejects).
        let mediaRes = await fetch(mediaUrl, { headers, redirect: "manual" });
        if (mediaRes.status >= 300 && mediaRes.status < 400 && mediaRes.headers.get("location")) {
          const redirectUrl = mediaRes.headers.get("location");
          console.log(`Following Twilio S3 redirect to: ${redirectUrl.split("?")[0]}...`);
          mediaRes = await fetch(redirectUrl);
        }

        console.log(`Media fetch HTTP status: ${mediaRes.status} ${mediaRes.statusText}`);

        if (mediaRes.ok) {
          const arrayBuffer = await mediaRes.arrayBuffer();
          fs.writeFileSync(photoPath, Buffer.from(arrayBuffer));
          photoUrl = `/uploads/${filename}`;
          console.log(`Saved MMS photo to: ${photoUrl}`);
        } else {
          console.error(`Failed to download MMS media. Status: ${mediaRes.status} ${mediaRes.statusText}`);
          const text = await mediaRes.text();
          console.error(`Media error body: ${text.slice(0, 200)}`);
        }
      } catch (mediaErr) {
        console.error("Failed to download MMS media:", mediaErr.message);
      }
    }

    // WhatsApp location shares arrive as Latitude/Longitude params (SMS has no equivalent).
    const waPin = parseLatLng(req.body.Latitude, req.body.Longitude);

    // A bare location share with no text/photo = "pin my last report here".
    if (waPin && numMedia === 0 && trimmed.length === 0) {
      const recent = getLatestReportBySender(fromNumber);
      const isRecent = recent && Date.now() - new Date(recent.createdAt).getTime() < 20 * 60 * 1000;
      if (recent && isRecent) {
        const loc = await resolveLocation({ ...waPin, source: "whatsapp" });
        applyLocation(recent, loc, { overrideBuilding: recent.buildingSource !== "user" });
        updateReport(recent.id, recent);
        res.type("text/xml");
        return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(`🐝 [BuzzFix] Location pinned!\n📍 ${recent.address || recent.building?.name || "Pinned on map"}${recent.nearestBuilding && recent.address ? `\n🏛 ${recent.nearestBuilding.name} (${recent.nearestBuilding.distanceMeters} m away)` : ""}\nReport ${recent.id} updated for technicians.`)}</Message>
</Response>`);
      }
    }

    const result = await processReport({
      text: bodyText,
      photoPath,
      photoMime,
      photoUrl,
      source: fromNumber.startsWith("whatsapp:") ? "whatsapp" : "sms",
      sender: fromNumber,
      gps: waPin ? { ...waPin, source: "whatsapp" } : null,
    });

    const photoLink = `${baseUrlFor(req)}/add-photo?id=${result.ticket}`;

    let replyMsg = "";
    if (result.emergency) {
      replyMsg = `🚨 [BuzzFix EMERGENCY]\nUrgent hazard detected! Do not wait on a ticket.\nCALL NOW: ${result.emergency.call} (${result.emergency.note})\nLogged as ticket ${result.ticket}.\n📸 Add photo: ${photoLink}`;
    } else if (result.merged) {
      // Even on a merge, if the ticket has no room/floor detail, this reporter can supply it.
      const question = startLocationPrompt(result.report);
      replyMsg = `🐝 [BuzzFix] Already reported at ${result.report.building?.name || 'this location'}! You're the ${ordinal(result.report.upvotes)} person. We bumped ticket ${result.ticket} priority.\n` +
                 `Status: ${(result.report.status || 'reported').replace('_', ' ').toUpperCase()}` +
                 question +
                 `\nWe'll text you updates! (Reply STOP to opt out)` +
                 (question ? "" : `\n📸 Add photo for tech: ${photoLink}`);
    } else {
      const bldgStr = result.building
        ? `${result.building.name}${result.building.number ? ` (Bldg #${result.building.number})` : ""}${result.report.address ? ` · ${result.report.address}` : ""}`
        : "GT Campus (Building unassigned)";
      const question = startLocationPrompt(result.report);
      replyMsg = `🐝 [BuzzFix] Report ${result.ticket} logged!\n` +
                 `📍 ${bldgStr}\n` +
                 `🔧 ${result.report.title}\n` +
                 `Status: REPORTED (technicians notified)` +
                 question +
                 (question ? `\n(or tap to pin GPS: ${photoLink})` : `\nWe'll text you updates. (Reply STOP to opt out)\n📸 Add photo: ${photoLink}`);
    }

    res.type("text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(replyMsg)}</Message>
</Response>`);
  } catch (err) {
    console.error("Error handling incoming SMS webhook:", err);
    res.type("text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>🐝 BuzzFix: Sorry, we had trouble processing that request. Please try again or report at ${baseUrlFor(req)}</Message>
</Response>`);
  }
});

// Test simulator endpoint for quick testing without sending a real SMS
app.get("/api/sms/test", async (req, res) => {
  const text = req.query.text || "Water is leaking from Klaus 2nd floor bathroom ceiling";
  const result = await processReport({
    text,
    source: "sms-test",
    sender: req.query.from || "+14045550199",
  });
  res.json({ ok: true, result });
});

app.get("/add-photo", (_req, res) => res.sendFile(path.join(__dirname, "public", "add-photo.html")));

app.get("/api/reports", (_req, res) => res.json(getReports()));
app.get("/api/reports/:id", (req, res) => {
  const r = getReport(req.params.id);
  if (!r) return res.status(404).json({ error: "Ticket not found" });
  res.json(r);
});

// Pin a location onto an existing ticket (from the /add-photo page's geolocation, no photo needed).
app.post("/api/reports/:id/location", async (req, res) => {
  const r = getReport(req.params.id);
  if (!r) return res.status(404).json({ error: "Ticket not found" });
  const fix = parseLatLng(req.body.lat, req.body.lng, req.body.accuracy);
  if (!fix) return res.status(400).json({ error: "lat/lng required" });
  const loc = await resolveLocation({ ...fix, source: "browser" });
  applyLocation(r, loc, { overrideBuilding: r.buildingSource !== "user" });
  updateReport(r.id, r);
  res.json({ ok: true, report: r });
});

app.post("/api/reports/:id/photo", upload.single("photo"), async (req, res) => {
  const r = getReport(req.params.id);
  if (!r) return res.status(404).json({ error: "Ticket not found" });
  if (!req.file) return res.status(400).json({ error: "No photo uploaded" });

  const photoUrl = `/uploads/${req.file.filename}`;
  r.photo = photoUrl;
  if (!r.photos) r.photos = [];
  r.photos.push(photoUrl);

  // Location can ride along with the photo (browser GPS first, EXIF as a fallback).
  const fix = parseLatLng(req.body.lat, req.body.lng, req.body.accuracy);
  const exif = fix ? null : extractExifGps(req.file.path);
  if (fix || exif) {
    const loc = await resolveLocation(fix ? { ...fix, source: "browser" } : { ...exif, accuracy: null, source: "exif" });
    applyLocation(r, loc, { overrideBuilding: r.buildingSource !== "user" });
  }

  // Re-triage with Gemini vision on the newly attached photo!
  if (process.env.GEMINI_API_KEY) {
    try {
      const ai = await classify({
        text: `${r.title} ${r.text || ""}`.trim(),
        photoPath: req.file.path,
        photoMime: req.file.mimetype,
      });
      if (ai.category && ai.category !== "other") r.category = ai.category;
      if (ai.urgency && ai.urgency !== "normal") r.urgency = ai.urgency;
      if (ai.title && (!r.text || r.title === "Maintenance issue")) r.title = ai.title;
      if (ai.summary) r.summary = ai.summary;
      r.aiSource = ai.source;
    } catch (err) {
      console.error("Gemini photo re-triage error:", err.message);
    }
  }

  updateReport(r.id, r);
  res.json({ ok: true, report: r });
});

app.get("/api/outbox", (_req, res) => res.json(getOutbox()));

app.post("/api/reports/:id/upvote", (req, res) => {
  const r = getReport(req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  r.upvotes += 1;
  updateReport(r.id, r);
  res.json(r);
});

app.post("/api/reports/:id/status", async (req, res) => {
  const { status, note = "" } = req.body;
  const r = getReport(req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  const oldStatus = r.status;
  const updated = updateReport(req.params.id, { status, statusNote: note || r.statusNote });

  // If status changed, send live SMS notification to student(s) who reported it
  if (oldStatus !== status) {
    await sendStatusUpdateSMS(updated, status, note);
  }
  res.json(updated);
});

async function sendStatusUpdateSMS(report, newStatus, note = "") {
  if (!twilioClient) {
    console.log("Twilio client not initialized, skipping status update SMS");
    return;
  }
  const fromNum = process.env.TWILIO_PHONE_NUMBER;
  if (!fromNum) {
    console.log("TWILIO_PHONE_NUMBER not set, skipping status update SMS");
    return;
  }

  // Get all unique reporters/subscribers for this issue who have not opted out
  const rawSubscribers = Array.isArray(report.subscribers) && report.subscribers.length > 0
    ? report.subscribers
    : (report.sender ? [report.sender] : []);

  const recipients = [...new Set(rawSubscribers)].filter((p) => p && !isOptedOut(p));
  if (recipients.length === 0) {
    console.log(`No active SMS recipients for ${report.id} status update`);
    return;
  }

  const bldgName = report.building?.name || "Campus";
  let statusText = newStatus.replace("_", " ").toUpperCase();
  let emoji = "🔧";
  let details = "";

  if (newStatus === "in_progress") {
    emoji = "🔨";
    details = `Work is now IN PROGRESS. Facilities has assigned a technician to ${bldgName}.`;
  } else if (newStatus === "resolved") {
    emoji = "✅";
    details = `Issue at ${bldgName} has been marked RESOLVED by Facilities! Thank you for helping keep Georgia Tech running.`;
  } else {
    details = `Current status at ${bldgName} is now ${statusText}.`;
  }

  if (note) details += `\nNote: ${note}`;

  const messageBody = `🐝 [BuzzFix Update - ${report.id}]\n${emoji} ${details}\nReply STOP to opt out.`;

  for (const to of recipients) {
    try {
      const msg = await twilioClient.messages.create({
        from: fromNum,
        to,
        body: messageBody,
      });
      console.log(`Dispatched status SMS update for ${report.id} to ${to} (SID: ${msg.sid})`);
    } catch (err) {
      console.error(`Failed to send status SMS to ${to}:`, err.message);
    }
  }
}

// Demo reset: POST /api/admin/reset?key=... (key = ADMIN_KEY env, default "buzz"). Clears all tickets.
app.post("/api/admin/reset", (req, res) => {
  if ((req.query.key || req.body?.key) !== (process.env.ADMIN_KEY || "buzz")) return res.status(403).json({ error: "bad key" });
  resetAll();
  res.json({ ok: true, message: "All reports cleared. Ticket numbers restart at GT-1001." });
});

app.get("/dashboard", (_req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));

app.listen(PORT, () => {
  console.log(`🐝 BuzzFix is running!
  • Report page  -> http://localhost:${PORT}
  • Dashboard    -> http://localhost:${PORT}/dashboard
  • SMS Webhook  -> http://localhost:${PORT}/api/sms (Twilio POST)
  • SMS Test URL -> http://localhost:${PORT}/api/sms/test
  • Gemini AI    -> ${GEMINI_ENABLED ? "ON (" + GEMINI_MODEL + ")" : "OFF (keyword fallback)"}
  • Twilio SMS   -> ${twilioClient && process.env.TWILIO_PHONE_NUMBER ? "ON (" + process.env.TWILIO_PHONE_NUMBER + ")" : "OFF (status texts disabled)"}`);
});

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
