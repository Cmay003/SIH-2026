// CAP XML / PDF report / Timeline links for one confirmed alert (step W2).
// Kept apart from lib/trends.ts so the dashboard and officer map bundles
// do not pull in the chart and CSV code.
import { ApiError } from "../api/client";
import type { Role } from "../api/types";

/** Staff who may download reports / see the timeline (server: requireOfficer). */
export const isOfficerRole = (role: Role | undefined) => role === "officer" || role === "admin";

export interface AlertLinks {
  /** CAP 1.2 XML: the officer proxy for staff, the public confirmed-only route otherwise */
  cap: string;
  pdf: string | null;
  pdfName: string;
  timeline: string | null;
}

export function alertLinks(alertId: number, nodeId: string, role: Role | undefined): AlertLinks {
  const staff = isOfficerRole(role);
  return {
    cap: staff ? `/api/officer/alerts/${alertId}/cap` : `/cap/alerts/${alertId}.xml`,
    pdf: staff ? `/api/officer/alerts/${alertId}/report.pdf` : null,
    pdfName: `sanjeevni_situation_report_${alertId}.pdf`,
    timeline: staff ? `/trends.html?node=${encodeURIComponent(nodeId)}&around=${alertId}#timeline` : null,
  };
}

/** Public Atom feed of confirmed alerts (CAP 1.2 entries), served by server.js. */
export const CAP_FEED_URL = "/cap/feed.atom";

/**
 * Downloads a file from our server, but only when it really is one: a
 * plain <a download> would save the JSON error of a stopped backend as
 * "report.pdf". Throws ApiError with the server's message instead.
 */
export async function downloadFromServer(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new ApiError(res.status, typeof data?.error === "string" ? data.error : `Download failed (HTTP ${res.status})`, data);
  }
  const objectUrl = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}
