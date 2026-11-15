// Tiny JSON-file store. Swap for Firestore in production (see README).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "data", "db.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return { reports: [], outbox: [], counter: 1000 };
  }
}

let db = load();

function save() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

export function nextTicket() {
  db.counter += 1;
  save();
  return `GT-${db.counter}`;
}

export function addReport(report) {
  db.reports.unshift(report);
  save();
  return report;
}

export function getReports() {
  return db.reports;
}

export function getReport(id) {
  return db.reports.find((r) => r.id === id);
}

export function updateReport(id, patch) {
  const r = getReport(id);
  if (!r) return null;
  Object.assign(r, patch);
  save();
  return r;
}

export function addOutbox(email) {
  db.outbox.unshift(email);
  save();
  return email;
}

export function getOutbox() {
  return db.outbox;
}

// User Notification Preferences (Opt-in / Opt-out)
export function optOut(phone) {
  if (!db.optOuts) db.optOuts = [];
  if (phone && !db.optOuts.includes(phone)) {
    db.optOuts.push(phone);
    save();
  }
  return true;
}

export function optIn(phone) {
  if (!db.optOuts) return true;
  db.optOuts = db.optOuts.filter((p) => p !== phone);
  save();
  return true;
}

export function isOptedOut(phone) {
  if (!phone) return false;
  return Array.isArray(db.optOuts) && db.optOuts.includes(phone);
}

export function getOptOuts() {
  return db.optOuts || [];
}

// Duplicate = same building + same category, still open, within windowHours.
export function findDuplicate(buildingId, category, windowHours = 72) {
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  return db.reports.find(
    (r) =>
      r.building?.id === buildingId &&
      r.category === category &&
      r.status !== "resolved" &&
      new Date(r.createdAt).getTime() > cutoff
  );
}

export function getLatestReportBySender(phone) {
  if (!phone) return null;
  return db.reports.find((r) => r.sender === phone);
}
