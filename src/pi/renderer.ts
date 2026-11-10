// Renderer for pi-bg:task notification messages (S5). Collapsed: one line per task; expanded: the full notification text.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { NotificationItem } from "../contract.js";
import { notificationText, REDELIVERY_LABEL } from "../core/format.js";
import { isErrorOutcome } from "../core/notify-policy.js";
import { NOTIFICATION_TYPE, type NotificationDetails } from "./runtime.js";

function isDetails(d: unknown): d is NotificationDetails {
  const b = (d as NotificationDetails | undefined)?.batch;
  return Array.isArray(b?.items) && b.items.length > 0;
}

/** First line of the task's block in the notification text, e.g. "bg1 (build) exited with code 0 after 12s." */
function oneLine(item: NotificationItem): string {
  return notificationText({ items: [item], redelivery: false }).split("\n")[1] ?? item.task.id;
}

export function registerNotificationRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<NotificationDetails>(NOTIFICATION_TYPE, (message, options, theme) => {
    if (!isDetails(message.details)) {
      const content = typeof message.content === "string" ? message.content : message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      return new Text(content, 1, 0);
    }
    const batch = message.details.batch;
    if (options.expanded) return new Text(notificationText(batch), 1, 0);
    const lines = batch.items.map((item) => theme.fg(isErrorOutcome(item.task) ? "error" : "success", oneLine(item)));
    if (batch.redelivery) lines.unshift(theme.fg("muted", REDELIVERY_LABEL));
    return new Text(lines.join("\n"), 1, 0);
  });
}
