import type { MonitorBatch, MonitorSink, NotificationBatch, NotificationSink } from "../../src/contract.js";

export class FakeNotificationSink implements NotificationSink {
  readonly sent: { batch: NotificationBatch; opts: { deliverAs: "steer" | "followUp" | "nextTurn"; triggerTurn: boolean } }[] = [];

  send(batch: NotificationBatch, opts: { deliverAs: "steer" | "followUp" | "nextTurn"; triggerTurn: boolean }): void {
    this.sent.push({ batch, opts });
  }
}

export class FakeMonitorSink implements MonitorSink {
  readonly sent: { batch: MonitorBatch; opts: { deliverAs: "steer" | "followUp" | "nextTurn"; triggerTurn: boolean } }[] = [];

  send(batch: MonitorBatch, opts: { deliverAs: "steer" | "followUp" | "nextTurn"; triggerTurn: boolean }): void {
    this.sent.push({ batch, opts });
  }
}
