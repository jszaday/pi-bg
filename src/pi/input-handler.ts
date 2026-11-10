// `input` handler (DESIGN section 8.2): a user message queued while a bg_wait is active releases the wait; one queued earlier is remembered until the next turn starts, so a later bg_wait sees it.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Services } from "./runtime.js";

export function installInputHandler(pi: ExtensionAPI, s: Services): void {
  pi.on("input", (event) => {
    if ((event.streamingBehavior === "steer" || event.streamingBehavior === "followUp") && s.waits.activeWaitIds().length > 0) {
      s.waits.onUserMessage();
    }
    // Count user input only: pi-bg's own notifications are not `input` events, and extension-sourced messages are not the user's.
    if ((event.streamingBehavior === "steer" || event.streamingBehavior === "followUp") && event.source !== "extension") {
      s.waits.rememberUserMessage();
    }
    return { action: "continue" as const };
  });
  // The queued message is delivered at the start of the next turn, so a bg_wait after that point must wait normally.
  pi.on("turn_start", () => {
    s.waits.clearQueuedUserMessage();
  });
}
