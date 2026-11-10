// Notification delivery glue (DESIGN section 9): the sendMessage sink and the ack/loss wiring (S5).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NotificationSink } from "../contract.js";
import { notificationText } from "../core/format.js";
import type { NotificationPolicy } from "../core/notify-policy.js";
import { NOTIFICATION_TYPE, type NotificationDetails } from "./runtime.js";

/** `onError` receives a failed send (for example a stale `pi` after reload); the policy has already marked the task sent. */
export function createNotificationSink(pi: ExtensionAPI, onError?: (e: unknown) => void): NotificationSink {
  return {
    send(batch, opts) {
      const details: NotificationDetails = { taskIds: batch.items.map((i) => i.task.id), batch };
      try {
        pi.sendMessage(
          { customType: NOTIFICATION_TYPE, content: notificationText(batch), display: true, details },
          // S5: nextTurn never wakes an idle agent, so triggerTurn is not passed for it.
          { deliverAs: opts.deliverAs, triggerTurn: opts.deliverAs === "nextTurn" ? false : opts.triggerTurn },
        );
      } catch (e) {
        onError?.(e);
      }
    },
  };
}

/** Ack = custom `message_end` with our type (S5); loss = `agent_settled` with aborted (policy redelivers once as nextTurn). */
export function installNotifyHandlers(pi: ExtensionAPI, notify: NotificationPolicy): void {
  pi.on("message_end", (event) => {
    const m = event.message as { role?: string; customType?: string; details?: Partial<NotificationDetails> };
    if (m.role === "custom" && m.customType === NOTIFICATION_TYPE && Array.isArray(m.details?.taskIds)) {
      notify.markAcked(m.details.taskIds);
    }
  });
  pi.on("agent_settled", (event) => {
    notify.onAgentSettled(event.aborted === true);
  });
}
