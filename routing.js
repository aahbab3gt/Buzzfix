// Routing: decide WHERE a report goes, mirroring how GT actually works today.
// - residence      -> Housing facilities request (Housing Help Desk)
// - academic       -> building manager + I&S customer service email, with building number
// - student_center -> Student & Campus Event Centers maintenance form
// - outdoor        -> Landscaping / outdoor lighting queues
// Emergencies never wait on a form: reply with the right phone number for right now.

export function emergencyContacts(buildingType, now = new Date()) {
  const hour = now.getHours();
  const weekday = now.getDay() >= 1 && now.getDay() <= 5;
  const businessHours = weekday && hour >= 8 && hour < 16;

  if (buildingType === "residence") {
    if (weekday && hour >= 17 && hour < 20) {
      return { call: "Your community's Area Office", note: "Weekdays 5–8 PM: contact your Area Office." };
    }
    if (!businessHours) {
      return { call: "RA on duty (number on the yellow card at your hall entrance)", note: "After hours / weekends." };
    }
    return { call: "Housing Help Desk (404-894-2470)", note: "Business hours." };
  }
  // Academic / everything else
  if (businessHours) {
    return { call: "Facilities Operations: 404-385-6000", note: "Weekdays 8 AM–4 PM." };
  }
  return { call: "GTPD: 404-894-2500", note: "After hours — GTPD dispatches emergency maintenance." };
}

export function route(report, building) {
  const type = building?.type || "academic";
  switch (type) {
    case "residence":
      return {
        channel: "housing",
        label: "Housing & Residence Life — Facilities Request",
        to: "housing-helpdesk@demo.buzzfix",
        why: "Residence hall issues go through the Housing Help Desk facilities request.",
      };
    case "student_center":
      return {
        channel: "student_center",
        label: "Student & Campus Event Centers — Maintenance",
        to: building.manager,
        why: "Student Center spaces have their own maintenance form (normally staff-only — BuzzFix submits on your behalf).",
      };
    case "outdoor":
      return {
        channel: "landscaping",
        label: "Infrastructure & Sustainability — Landscaping / Outdoor",
        to: building.manager,
        why: "Outdoor issues route to Landscaping / Outdoor Lighting request queues.",
      };
    default:
      return {
        channel: "academic",
        label: "I&S Customer Service (via building manager)",
        to: `${building?.manager || "building-manager@demo.buzzfix"}, iscustomerserv@demo.buzzfix`,
        why: "Academic buildings: only building managers may email I&S customer service — BuzzFix formats and sends it for you, cc'ing the manager.",
      };
  }
}

export function draftEmail(report, building, routeInfo) {
  const subject = `[BuzzFix ${report.id}] ${report.title} — ${building?.name || "Unknown building"}${
    building?.number ? ` (Bldg ${building.number})` : ""
  }`;
  const body = [
    `Issue: ${report.title}`,
    `Category: ${report.category}  |  Urgency: ${report.urgency}`,
    `Building: ${building?.name || "Unknown"}${building?.number ? ` — Building #${building.number}` : ""}`,
    report.location ? `Location detail: ${report.location}` : null,
    ``,
    `Description: ${report.summary}`,
    report.photo ? `Photo: attached (${report.photo})` : `Photo: none`,
    ``,
    `Reported via BuzzFix by a GT student. Reply to this thread to update the reporter.`,
    `Upvotes (people affected): ${report.upvotes}`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  return { to: routeInfo.to, subject, body, channel: routeInfo.channel, reportId: report.id, sentAt: new Date().toISOString() };
}
