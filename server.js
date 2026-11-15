import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { classify } from "./classify.js";
import { route, draftEmail, emergencyContacts } from "./routing.js";
import {
  nextTicket,
  addReport,
  getReports,
  getReport,
  updateReport,
  addOutbox,
  getOutbox,
  findDuplicate,
} from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const buildings = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "buildings.json"), "utf8"));

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, "uploads"),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, "_")}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.static(path.join(__dirname, "public")));

function matchBuilding(input) {
  if (!input) return null;
  const t = String(input).toLowerCase();
  return (
    buildings.find((b) => b.id === t) ||
    buildings.find((b) => t.includes(b.name.toLowerCase())) ||
    buildings.find((b) => b.aliases.some((a) => t.includes(a))) ||
    null
  );
}

app.get("/api/buildings", (_req, res) => res.json(buildings));

// The core endpoint: one photo + optional note in, triaged + routed ticket out.
app.post("/api/report", upload.single("photo"), async (req, res) => {
  const { text = "", buildingId = "", location = "" } = req.body;

  const ai = await classify({
    text: `${text} ${location}`.trim(),
    photoPath: req.file?.path,
    photoMime: req.file?.mimetype,
  });

  const building = matchBuilding(buildingId) || matchBuilding(text) || matchBuilding(ai.building_guess);

  // Emergencies: don't file a form — tell them who to call RIGHT NOW (and still log it).
  const isEmergency = ai.urgency === "emergency";
  const contacts = isEmergency ? emergencyContacts(building?.type) : null;

  // Duplicate detection: same building + category, open, last 72h -> merge as upvote.
  if (building && !isEmergency) {
    const dup = findDuplicate(building.id, ai.category);
    if (dup) {
      dup.upvotes += 1;
      if (req.file) dup.photos.push(`/uploads/${req.file.filename}`);
      updateReport(dup.id, dup);
      return res.json({
        merged: true,
        ticket: dup.id,
        message: `Already reported — you're the ${ordinal(dup.upvotes)} person. We bumped its priority.`,
        report: dup,
      });
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
    building: building
      ? { id: building.id, name: building.name, number: building.number, type: building.type, lat: building.lat, lng: building.lng }
      : null,
    photo: req.file ? `/uploads/${req.file.filename}` : null,
    photos: req.file ? [`/uploads/${req.file.filename}`] : [],
    upvotes: 1,
  };
  addReport(report);

  let routed = null;
  if (!isEmergency) {
    const r = route(report, building);
    const email = draftEmail(report, building, r);
    addOutbox(email);
    routed = { ...r, emailPreview: email };
    updateReport(id, { routedTo: r.label });
  }

  res.json({
    merged: false,
    ticket: id,
    emergency: isEmergency ? contacts : null,
    routed,
    report: getReport(id),
  });
});

app.get("/api/reports", (_req, res) => res.json(getReports()));
app.get("/api/outbox", (_req, res) => res.json(getOutbox()));

app.post("/api/reports/:id/upvote", (req, res) => {
  const r = getReport(req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  r.upvotes += 1;
  updateReport(r.id, r);
  res.json(r);
});

app.post("/api/reports/:id/status", (req, res) => {
  const { status } = req.body;
  const r = updateReport(req.params.id, { status });
  if (!r) return res.status(404).json({ error: "not found" });
  res.json(r);
});

app.get("/dashboard", (_req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));

app.listen(PORT, () => {
  console.log(`BuzzFix running:
  Report page -> http://localhost:${PORT}
  Dashboard   -> http://localhost:${PORT}/dashboard
  Gemini      -> ${process.env.GEMINI_API_KEY ? "ON (" + (process.env.GEMINI_MODEL || "gemini-2.5-flash") + ")" : "OFF (keyword fallback)"}`);
});

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
