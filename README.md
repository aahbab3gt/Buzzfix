# 🐝 BuzzFix

**See something broken at Georgia Tech? One photo. We figure out the rest.**

Today, reporting maintenance at GT depends on which building you're in: Housing has its own request flow, academic buildings expect you to find the *building manager* (students aren't supposed to email I&S customer service directly), and the Student Center has a staff-only form. Result: most issues never get reported.

BuzzFix is one front door. A student snaps a photo → Gemini classifies the issue (category, urgency, title, summary, building guess) → BuzzFix routes it to the right queue with the right format (building number included), merges duplicates into upvotes, catches emergencies ("call 404-385-6000 now, don't file a ticket"), and gives SGA/Facilities a live dashboard + campus heatmap.

## Run it

```bash
npm install
npm start
# Report page:  http://localhost:3000
# Dashboard:    http://localhost:3000/dashboard
```

Works out of the box with a **keyword fallback classifier** (no key needed — demo-safe offline).

### Turn on Gemini (recommended)

```bash
export GEMINI_API_KEY=your_key          # from Google AI Studio / your GCP credits
export GEMINI_MODEL=gemini-2.5-flash    # optional, bump to the newest flash model
npm start
```

## Architecture

```
public/index.html      mobile-first report page (camera capture)
public/dashboard.html  SGA/Facilities view: issues, Leaflet map, email outbox
server.js              Express API: /api/report, /api/reports, /api/outbox
classify.js            Gemini vision triage + keyword fallback
routing.js             GT-specific routing rules + emergency phone logic
store.js               JSON-file store (swap for Firestore)
data/buildings.json    building numbers, types, managers, coords (extend w/ SGA data)
```

## Demo-mode notes (be honest with judges)

- **Emails are staged, not sent** — they appear in the dashboard Outbox so judges see exactly what facilities would receive. Flip to real email with one SMTP/SendGrid call in `server.js`.
- **Building manager emails are placeholders** (`@demo.buzzfix`). Ask SGA for the real building-manager directory.
- **Phone numbers** (404-385-6000 facilities / 404-894-2500 GTPD / Housing flows) mirror GT's published process — re-verify before the final pitch.

## Production path (pitch slide)

1. WhatsApp/SMS intake via Twilio → same `/api/report` endpoint (photo + text, zero app install).
2. Firestore + Cloud Run + Cloud Storage (all covered by the GCP credits).
3. Real email/webhook into Housing's help desk + I&S customer service, with per-building manager directory from SGA.
4. Analytics: response time per building, hotspots, duplicate rate → SGA accountability reports.

## TODO for the team

- [ ] Get real building-manager list from SGA (Sat 12–3 CAB office hours)
- [ ] Add remaining campus buildings to `data/buildings.json`
- [ ] Twilio WhatsApp sandbox intake
- [ ] Record backup demo video before Sun 9 AM submission
