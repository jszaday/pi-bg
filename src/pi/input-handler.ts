// `input` handler (DESIGN section 8.2): a user message queued while a bg_wait is active releases the wait.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Services } from "./runtime.js";

export function installInputHandler(pi: ExtensionAPI, s: Services): void {
  pi.on("input", (event) => {
    if ((event.streamingBehavior === "steer" || event.streamingBehavior === "followUp") && s.waits.activeWaitIds().length > 0) {
      s.waits.onUserMessage();
    }
    return { action: "continue" as const };
  });
}
