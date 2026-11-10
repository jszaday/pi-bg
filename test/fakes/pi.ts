import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

export interface FakeComponent {
  render(width: number): string[];
  invalidate(): void;
  handleInput?(data: string): void;
  dispose?(): void;
}

export interface FakeTui {
  renders: number;
  requestRender(force?: boolean): void;
  hasOverlay(): boolean;
  getFocusedComponent(): unknown;
  terminal: { rows: number; columns: number };
}

// Theme stand-in: inverse wraps the text in the same escapes as Pi's chalk.inverse.
export const fakeTheme = { inverse: (t: string) => `\x1b[7m${t}\x1b[27m` };

export interface FakeOverlay {
  component: FakeComponent;
  opts: unknown;
  closed: boolean;
  /** Settles when done() is called. */
  result: Promise<unknown>;
}

// Recorder for the parts of the context pi-bg reads.
export interface FakeUi {
  // A factory widget records content "factory" and its component in `widgetComponents`.
  widgets: { key: string; content: string[] | "factory" | undefined }[];
  widgetComponents: Map<string, FakeComponent>;
  tui: FakeTui;
  // Focused component the fake TUI reports; defaults to an editor that is not showing autocomplete.
  focused: unknown;
  editor: { isShowingAutocomplete(): boolean };
  overlays: FakeOverlay[];
  statuses: { key: string; text: string | undefined }[];
  notices: { msg: string; level: "info" | "warning" | "error" | undefined }[];
  // Registered terminal input listeners, in registration order.
  listeners: ((data: string) => { consume?: boolean; data?: string } | undefined)[];
  // Text in the editor; the test sets it. getEditorText() returns it.
  editorText: string;
  getEditorText(): string;
  setWidget(
    key: string,
    content: string[] | ((tui: FakeTui, theme: typeof fakeTheme) => FakeComponent) | undefined,
  ): void;
  custom(
    factory: (tui: FakeTui, theme: typeof fakeTheme, kb: unknown, done: (r?: unknown) => void) => FakeComponent,
    opts?: unknown,
  ): Promise<unknown>;
  setStatus(key: string, text: string | undefined): void;
  notify(msg: string, level?: "info" | "warning" | "error"): void;
  onTerminalInput(handler: FakeUi["listeners"][number]): () => void;
  // Feeds one key to the listeners in order. Returns true if a listener consumed it.
  // A listener that consumes stops the chain; a listener may rewrite data, which the next listener sees.
  typeKey(data: string): boolean;
}

export interface FakeCtx {
  hasUI: boolean;
  cwd: string;
  signal: AbortSignal | undefined;
  ui: FakeUi;
  hasPendingMessages(): boolean;
}

type Handler = (payload: unknown, ctx: FakeCtx) => unknown;

function createUi(): FakeUi {
  const editor = { isShowingAutocomplete: () => false };
  const ui: FakeUi = {
    widgets: [],
    widgetComponents: new Map(),
    overlays: [],
    editor,
    focused: editor,
    tui: {
      renders: 0,
      requestRender() {
        ui.tui.renders++;
      },
      hasOverlay: () => ui.overlays.some((o) => !o.closed),
      getFocusedComponent: () => ui.focused,
      terminal: { rows: 30, columns: 100 },
    },
    statuses: [],
    notices: [],
    listeners: [],
    editorText: "",
    getEditorText() {
      return ui.editorText;
    },
    setWidget(key, content) {
      ui.widgetComponents.get(key)?.dispose?.();
      ui.widgetComponents.delete(key);
      if (typeof content === "function") {
        ui.widgets.push({ key, content: "factory" });
        ui.widgetComponents.set(key, content(ui.tui, fakeTheme));
      } else ui.widgets.push({ key, content });
    },
    custom(factory, opts) {
      let finish!: (r?: unknown) => void;
      const result = new Promise<unknown>((resolve) => (finish = resolve));
      const overlay = { opts, closed: false, result } as FakeOverlay;
      const done = (r?: unknown): void => {
        if (overlay.closed) return;
        overlay.closed = true;
        overlay.component.dispose?.();
        finish(r);
      };
      overlay.component = factory(ui.tui, fakeTheme, undefined, done);
      ui.overlays.push(overlay);
      return result;
    },
    setStatus(key, text) {
      ui.statuses.push({ key, text });
    },
    notify(msg, level) {
      ui.notices.push({ msg, level });
    },
    onTerminalInput(handler) {
      ui.listeners.push(handler);
      return () => {
        ui.listeners = ui.listeners.filter((h) => h !== handler);
      };
    },
    typeKey(data) {
      let current = data;
      for (const l of [...ui.listeners]) {
        const r = l(current);
        if (r?.consume) return true;
        if (r?.data !== undefined) current = r.data;
      }
      // Nothing consumed it: the focused overlay (if any) gets the key, as Pi's TUI does.
      ui.overlays.filter((o) => !o.closed).at(-1)?.component.handleInput?.(current);
      return false;
    },
  };
  return ui;
}

// Records registrations and replays events, tool calls and messages. Covers only the
// ExtensionAPI members pi-bg uses; asExtensionAPI() casts it, so an unimplemented
// member fails at call time with a TypeError.
export class FakePi {
  readonly tools = new Map<string, ToolDefinition>();
  readonly shortcuts = new Map<string, unknown>();
  readonly handlers = new Map<string, Handler[]>();
  // sendMessage() calls, in order.
  readonly messages: { msg: unknown; opts: unknown }[] = [];
  // sendUserMessage() calls, in order.
  readonly userMessages: { content: unknown; opts: unknown }[] = [];
  readonly commands = new Map<string, unknown>();
  // Registered flag definitions.
  readonly flags = new Map<string, unknown>();
  // Flag values as the user would pass them (setFlag); getFlag reads these.
  readonly flagValues = new Map<string, boolean | string>();
  readonly renderers = new Map<string, unknown>();
  // Count used by ctx.hasPendingMessages(); the test sets it.
  pendingMessages = 0;
  readonly ui: FakeUi = createUi();

  asExtensionAPI(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }

  on(event: string, handler: Handler): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {
      this.handlers.set(event, (this.handlers.get(event) ?? []).filter((h) => h !== handler));
    };
  }

  registerTool(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`FakePi: tool "${tool.name}" is registered twice; register each tool name once per extension load`);
    }
    this.tools.set(tool.name, tool);
  }

  registerShortcut(shortcut: string, options: unknown): void {
    this.shortcuts.set(shortcut, options);
  }

  registerCommand(name: string, options: unknown): void {
    this.commands.set(name, options);
  }

  registerFlag(name: string, options: unknown): void {
    this.flags.set(name, options);
  }

  setFlag(name: string, value: boolean | string): void {
    this.flagValues.set(name, value);
  }

  getFlag(name: string): boolean | string | undefined {
    return this.flagValues.get(name);
  }

  registerMessageRenderer(customType: string, renderer: unknown): void {
    this.renderers.set(customType, renderer);
  }

  sendMessage(msg: unknown, opts?: unknown): void {
    this.messages.push({ msg, opts });
  }

  sendUserMessage(content: unknown, opts?: unknown): void {
    this.userMessages.push({ content, opts });
  }

  makeCtx(over: Partial<FakeCtx> = {}): FakeCtx {
    return {
      hasUI: true,
      cwd: process.cwd(),
      signal: undefined,
      ui: this.ui,
      hasPendingMessages: () => this.pendingMessages > 0,
      ...over,
    };
  }

  // Calls every handler for the event in registration order, awaiting each, and returns their results.
  async emit(event: string, payload: unknown, ctx: Partial<FakeCtx> = {}): Promise<unknown[]> {
    const full = this.makeCtx(ctx);
    const results: unknown[] = [];
    for (const h of [...(this.handlers.get(event) ?? [])]) {
      results.push(await h(payload, full));
    }
    return results;
  }

  // Runs a registered tool. Rejects for an unknown tool name, and for params that fail the tool's TypeBox schema.
  async callTool(
    name: string,
    params: unknown,
    opts: { signal?: AbortSignal; ctx?: Partial<FakeCtx>; toolCallId?: string } = {},
  ): Promise<AgentToolResult<unknown>> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(
        `FakePi has no tool "${name}"; registered tools: ${[...this.tools.keys()].join(", ") || "(none)"}. Register it in the code under test or fix the name in the call.`,
      );
    }
    if (!Value.Check(tool.parameters, params)) {
      const first = [...Value.Errors(tool.parameters, params)][0];
      throw new Error(
        `FakePi: params for tool "${name}" fail its schema at ${first?.instancePath || "/"}: ${first?.message ?? "invalid"}. Fix the call or the schema.`,
      );
    }
    const ctx = this.makeCtx({ signal: opts.signal, ...opts.ctx });
    const id = opts.toolCallId ?? `call-${this.tools.size}-${name}`;
    return (tool.execute as unknown as (...a: unknown[]) => Promise<AgentToolResult<unknown>>)(
      id,
      params,
      opts.signal,
      undefined,
      ctx,
    );
  }
}
