# 🐝 BuzzFix

**See something broken at Georgia Tech? Text a photo. We figure out the rest.**

Built for the GT Campus Solutions Challenge, November 2026.

## The problem

Reporting maintenance at Georgia Tech depends on which building you're in. Housing has its own request flow. Academic buildings expect you to find the *building manager* (students aren't supposed to email I&S customer service directly). The Student Center has a staff-only form. Most students have never filed a request because they don't know how. Most issues never get reported.

## What BuzzFix does

One front door: **text a photo to a number**, or use the web page.

1. **Gemini triage** reads the photo and note: category, urgency, title, a one-line summary a technician can use, and a building guess.
2. **Location by conversation.** If the building or room isn't known, BuzzFix texts back *"Where is this? Reply with building + floor/room."* The next reply is parsed (Gemini + alias matching) and attached. At most two questions, then it stops asking. Browser GPS and WhatsApp location pins work too, and are reverse-geocoded to a street address.
3. **GT-aware routing.** Residence halls go to Housing. Academic buildings become a formatted email to the building manager + I&S with the building number. Student Center and outdoor issues go to their own queues.
4. **Emergencies skip the ticket.** A burst pipe or sparking outlet gets *"Call 404-385-6000 now"* (or GTPD / RA on duty after hours), and is still logged.
5. **Duplicates merge.** The fifth person reporting the same broken elevator becomes an upvote, and gets status texts too.
6. **Live status texts.** When Facilities marks a ticket in progress or resolved on the dashboard, every reporter gets an SMS.
7. **Dashboard** for SGA / Facilities: issue cards with photos, a campus map with exact GPS pins, an outbox showing the exact emails that would go out, and per-ticket status controls.

## Run it locally

```bash
git clone https://github.com/aahbab3gt/buzzfix.git
cd buzzfix
npm install
cp .env.example .env        # then fill in keys (see below)
npm start
```

- Report page: http://localhost:3000
- Dashboard: http://localhost:3000/dashboard
- SMS webhook: `POST /api/sms` (Twilio)
- Quick SMS simulator (no Twilio needed): http://localhost:3000/api/sms/test?text=water+fountain+leaking+in+klaus

Works with **no keys at all** using a keyword classifier, so the demo never dies offline.

### `.env`

| Variable | What it does |
|---|---|
| `GEMINI_API_KEY` | Turns on Gemini vision triage and smart location parsing |
| `GEMINI_MODEL` | Defaults to the value in `classify.js`; set explicitly to a model your key supports |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | Required for **outbound** status texts and MMS photo download. Inbound replies work via TwiML without them |
| `ADMIN_KEY` | Key for the demo reset endpoint (default `buzz`) |
| `DISABLE_DEDUPE` | Set to `1` to turn off duplicate merging during a demo |

### Exposing it to Twilio

Twilio needs a public URL. We use ngrok's free **static domain** so the webhook never changes:

```bash
ngrok http 3000 --url=squint-stardust-spiny.ngrok-free.dev
```

Keep this running in its own terminal tab alongside `npm start`. In the Twilio console the number's *"A message comes in"* webhook is set to `https://squint-stardust-spiny.ngrok-free.dev/api/sms` (HTTP POST).

> On a Twilio trial account, only **verified** phone numbers can receive replies. Add every demo phone under *Phone Numbers → Verified Caller IDs*.

### Demo checklist

1. Server tab: `npm start`. Tunnel tab: the ngrok command above. Mac stays awake.
2. Wipe test data: `curl -X POST "http://localhost:3000/api/admin/reset?key=buzz"`
3. Open the dashboard on the projector. Text a photo to the BuzzFix number from a verified phone.
4. Reply to the "Where is this?" question. Watch the card update with the room.
5. Mark it *In progress* on the dashboard; the phone gets a status text.

## Architecture

```
server.js              Express API, Twilio webhook, location conversation, routing
classify.js            Gemini vision triage + location-reply parser, keyword fallback
routing.js             GT-specific routing rules + emergency phone logic by time of day
geo.js                 nearest building, reverse geocoding (OpenStreetMap), map links
store.js               JSON-file store (swap for Firestore)
data/buildings.json    building numbers, types, managers, coordinates, aliases
public/index.html      mobile report page (camera + browser GPS)
public/add-photo.html  follow-up page linked from SMS: add a photo or pin location
public/dashboard.html  SGA / Facilities dashboard (issues, Leaflet map, outbox)
```

Key endpoints: `POST /api/report`, `POST /api/sms`, `GET /api/reports`, `POST /api/reports/:id/status`, `POST /api/reports/:id/location`, `POST /api/reports/:id/photo`, `GET /api/config`, `POST /api/admin/reset`.

## Honest demo notes

- **Emails are staged, not sent.** They appear in the dashboard Outbox so judges can see exactly what Facilities would receive. One SMTP call turns them live.
- **Building manager addresses are placeholders** (`@demo.buzzfix`) until GT provides the directory.
- **Phone numbers and processes** mirror GT's published pages (Facilities 404-385-6000, GTPD 404-894-2500, Housing flows). Re-verify before launch.
- **Photo EXIF GPS is almost always stripped** by carriers and iOS, which is why location comes from the text conversation, browser GPS, or WhatsApp pins instead.

## Production path

1. Firestore + Cloud Run + Cloud Storage on the GCP credits.
2. A2P 10DLC registration (or a verified toll-free number) so any student can text it.
3. Real email / webhook into Housing's help desk and I&S customer service, with the building manager directory from SGA.
4. Analytics for SGA: response time per building, hotspots, duplicate rates, resolution SLAs.
5. Sell it to other campuses. Every university has this exact problem.

## Team

Built at Georgia Tech, Campus Solutions Challenge 2026.
