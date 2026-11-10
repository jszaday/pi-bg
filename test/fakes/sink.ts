import type { NotificationBatch, NotificationSink } from "../../src/contract.js";

export class FakeNotificationSink implements NotificationSink {
  readonly sent: { batch: NotificationBatch; opts: { deliverAs: "steer" | "followUp" | "nextTurn"; triggerTurn: boolean } }[] = [];

  send(batch: NotificationBatch, opts: { deliverAs: "steer" | "followUp" | "nextTurn"; triggerTurn: boolean }): void {
    this.sent.push({ batch, opts });
  }
}
