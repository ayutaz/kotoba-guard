import { debounce, type Debounced } from "./debounce";
import { HighlightManager } from "./highlights";
import {
  adapterFor,
  editorFromTarget,
  readWithAdapter,
  type EditorElement,
} from "../adapters/editor";
import {
  MAX_INPUT_LENGTH,
  type CheckResponse,
  type RuntimeState,
} from "../shared/types";

type Editable = EditorElement;
type SendMessage = (message: unknown) => Promise<unknown>;

const DEFAULT_DEBOUNCE_MS = 400;

type EditorRequestState = {
  lifecycleEpoch: number;
  inFlight: boolean;
  pending: boolean;
  pendingManual: boolean;
  pendingStateEpoch: number;
  busyRetries: number;
};

export type ContentControllerOptions = {
  readonly debounceMs?: number;
  readonly sendMessage?: SendMessage;
};

function editableFromTarget(target: EventTarget | null): Editable | undefined {
  return editorFromTarget(target)?.element;
}

/** Content-side orchestration. It never writes into an editor's DOM or persists text. */
export class ContentController {
  private enabled = false;
  private globalEnabled = false;
  private stateEpoch = 0;
  private lifecycleEpoch = 0;
  private composing = new WeakSet<Element>();
  private readonly latest = new WeakMap<Element, number>();
  private readonly debounced = new Map<
    Element,
    Debounced<(...args: never[]) => void>
  >();
  private readonly sequence = new WeakMap<Element, number>();
  private readonly requestStates = new WeakMap<Element, EditorRequestState>();
  private readonly trackedEditors = new Set<Editable>();
  private readonly highlights = new HighlightManager();
  private observer: MutationObserver | undefined;
  private attached = false;
  private readonly sendMessage: SendMessage;

  constructor(private readonly options: ContentControllerOptions = {}) {
    this.sendMessage =
      options.sendMessage ?? ((message) => chrome.runtime.sendMessage(message));
  }

  start(): void {
    if (this.attached) return;
    this.attached = true;
    const lifecycleEpoch = ++this.lifecycleEpoch;
    document.addEventListener(
      "compositionstart",
      this.onCompositionStart,
      true,
    );
    document.addEventListener(
      "compositionupdate",
      this.onCompositionUpdate,
      true,
    );
    document.addEventListener("compositionend", this.onCompositionEnd, true);
    document.addEventListener("beforeinput", this.onBeforeInput, true);
    document.addEventListener("input", this.onInput, true);
    document.addEventListener("focusin", this.onFocusIn, true);
    this.ensureObserver();
    void this.sendMessage({ type: "content-ready" })
      .then((value) => {
        if (!this.attached || lifecycleEpoch !== this.lifecycleEpoch) return;
        if (!value || typeof value !== "object") return;
        const state = (value as { state?: unknown }).state;
        if (state && typeof state === "object")
          this.setState(state as RuntimeState);
      })
      .catch(() => undefined);
  }

  stop(): void {
    if (!this.attached) return;
    this.attached = false;
    this.lifecycleEpoch += 1;
    this.stateEpoch += 1;
    document.removeEventListener(
      "compositionstart",
      this.onCompositionStart,
      true,
    );
    document.removeEventListener(
      "compositionupdate",
      this.onCompositionUpdate,
      true,
    );
    document.removeEventListener("compositionend", this.onCompositionEnd, true);
    document.removeEventListener("beforeinput", this.onBeforeInput, true);
    document.removeEventListener("input", this.onInput, true);
    document.removeEventListener("focusin", this.onFocusIn, true);
    this.observer?.disconnect();
    this.observer = undefined;
    for (const timer of this.debounced.values()) timer.cancel();
    this.debounced.clear();
    for (const editable of this.trackedEditors) {
      const state = this.requestStates.get(editable);
      if (state) {
        state.pending = false;
        state.pendingManual = false;
        state.pendingStateEpoch = this.stateEpoch;
        state.busyRetries = 0;
      }
    }
    this.trackedEditors.clear();
    this.highlights.clear();
  }

  setState(
    state: Pick<RuntimeState, "globalEnabled" | "siteEnabled"> | boolean,
  ): void {
    const nextGlobalEnabled =
      typeof state === "boolean" ? state : state.globalEnabled;
    const next =
      typeof state === "boolean"
        ? state
        : nextGlobalEnabled && state.siteEnabled;
    const globalChanged = this.globalEnabled !== nextGlobalEnabled;
    if (!globalChanged && this.enabled === next) return;
    this.globalEnabled = nextGlobalEnabled;
    this.enabled = next;
    this.stateEpoch += 1;
    if (!next) {
      this.clearPendingEditors();
      this.highlights.clear();
      return;
    }
    const focused = editableFromTarget(document.activeElement);
    if (focused && !this.composing.has(focused)) this.schedule(focused);
  }

  manualCheck(target?: EventTarget | null): void {
    if (!this.globalEnabled) return;
    const editable = editableFromTarget(target ?? document.activeElement);
    if (editable) {
      this.trackedEditors.add(editable);
      if (!this.composing.has(editable)) this.request(editable, true);
    }
  }

  private getRequestState(editable: Editable): EditorRequestState {
    const current = this.requestStates.get(editable);
    if (current?.lifecycleEpoch === this.lifecycleEpoch) return current;
    const next: EditorRequestState = {
      lifecycleEpoch: this.lifecycleEpoch,
      inFlight: false,
      pending: false,
      pendingManual: false,
      pendingStateEpoch: this.stateEpoch,
      busyRetries: 0,
    };
    this.requestStates.set(editable, next);
    return next;
  }

  private clearPendingEditors(): void {
    for (const editable of this.trackedEditors) {
      this.debounced.get(editable)?.cancel();
      this.debounced.delete(editable);
      const state = this.getRequestState(editable);
      state.pending = false;
      state.pendingManual = false;
      state.pendingStateEpoch = this.stateEpoch;
      state.busyRetries = 0;
    }
  }

  private isConnected(editable: Editable): boolean {
    return editable.isConnected && document.contains(editable);
  }

  private schedule(
    editable: Editable,
    retry = false,
    manualPending = false,
  ): void {
    this.trackedEditors.add(editable);
    if (
      (!this.enabled && !manualPending) ||
      !adapterFor(editable) ||
      this.composing.has(editable)
    )
      return;
    const state = this.getRequestState(editable);
    if (!retry) state.busyRetries = 0;
    if (manualPending) state.pendingManual = true;
    let timer = this.debounced.get(editable);
    if (!timer) {
      timer = debounce(
        (() => {
          const current = this.getRequestState(editable);
          const manual = current.pendingManual;
          current.pending = false;
          current.pendingManual = false;
          this.request(editable, manual);
        }) as (...args: never[]) => void,
        this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      );
      this.debounced.set(editable, timer);
    }
    timer.schedule();
  }

  private request(editable: Editable, manual: boolean): void {
    this.trackedEditors.add(editable);
    if (
      !this.attached ||
      !this.isConnected(editable) ||
      this.composing.has(editable) ||
      (!this.enabled && !manual) ||
      (manual && !this.globalEnabled) ||
      !adapterFor(editable)
    )
      return;
    const state = this.getRequestState(editable);
    if (state.inFlight) {
      state.pending = true;
      state.pendingManual ||= manual;
      state.pendingStateEpoch = this.stateEpoch;
      return;
    }
    const text = readWithAdapter(editable);
    if (text === undefined) return;
    if (text.length === 0 || text.length > MAX_INPUT_LENGTH) {
      this.highlights.clear(editable);
      return;
    }
    const current = (this.sequence.get(editable) ?? 0) + 1;
    this.sequence.set(editable, current);
    this.latest.set(editable, current);
    const requestId = current;
    const epoch = this.stateEpoch;
    const lifecycleEpoch = this.lifecycleEpoch;
    state.inFlight = true;
    void this.sendMessage({
      type: "check",
      requestId,
      text,
      ...(manual ? { manual: true } : {}),
    })
      .then((value) => {
        if (
          lifecycleEpoch !== this.lifecycleEpoch ||
          epoch !== this.stateEpoch ||
          !this.isConnected(editable) ||
          this.composing.has(editable) ||
          (!this.enabled && (!manual || !this.globalEnabled)) ||
          this.latest.get(editable) !== requestId
        )
          return;
        const response = value as CheckResponse | undefined;
        if (!response || response.requestId !== requestId) return;
        if (response.type === "check-error") {
          if (response.code === "busy" && !manual && state.busyRetries < 1) {
            state.busyRetries += 1;
            state.pending = true;
            state.pendingStateEpoch = epoch;
          }
          return;
        }
        if (response.type !== "check-result") return;
        state.busyRetries = 0;
        if (readWithAdapter(editable) !== text) return;
        this.highlights.show(editable, response.result.detections);
      })
      .catch(() => {
        if (this.latest.get(editable) === requestId)
          this.highlights.clear(editable);
      })
      .finally(() => {
        state.inFlight = false;
        if (
          lifecycleEpoch !== this.lifecycleEpoch ||
          !this.isConnected(editable) ||
          this.composing.has(editable)
        ) {
          state.pending = false;
          state.pendingManual = false;
          state.pendingStateEpoch = this.stateEpoch;
          return;
        }
        if (
          epoch !== this.stateEpoch &&
          (!state.pending || state.pendingStateEpoch !== this.stateEpoch)
        ) {
          state.pending = false;
          state.pendingManual = false;
          state.pendingStateEpoch = this.stateEpoch;
          return;
        }
        if (state.pending) {
          const retry = state.busyRetries > 0;
          const manualPending = state.pendingManual;
          state.pending = false;
          state.pendingManual = false;
          this.schedule(editable, retry, manualPending);
        }
      });
  }

  private readonly onCompositionStart = (event: CompositionEvent): void => {
    const editable = editableFromTarget(event.target);
    if (editable) {
      this.trackedEditors.add(editable);
      this.debounced.get(editable)?.cancel();
      const state = this.getRequestState(editable);
      state.pending = false;
      state.pendingManual = false;
      state.pendingStateEpoch = this.stateEpoch;
      state.busyRetries = 0;
      this.latest.delete(editable);
      this.composing.add(editable);
      this.highlights.clear(editable);
    }
  };

  private readonly onCompositionUpdate = (event: CompositionEvent): void => {
    const editable = editableFromTarget(event.target);
    if (editable) this.composing.add(editable);
  };

  private readonly onCompositionEnd = (event: CompositionEvent): void => {
    const editable = editableFromTarget(event.target);
    if (!editable) return;
    this.composing.delete(editable);
    this.schedule(editable);
  };

  private readonly onBeforeInput = (event: InputEvent): void => {
    const editable = editableFromTarget(event.target);
    if (editable) this.highlights.clear(editable);
  };

  private readonly onInput = (event: Event): void => {
    if (event instanceof InputEvent && event.isComposing) return;
    const editable = editableFromTarget(event.target);
    if (editable) {
      this.highlights.clear(editable);
      this.schedule(editable);
    }
  };

  private readonly onFocusIn = (event: FocusEvent): void => {
    const editable = editableFromTarget(event.target);
    if (editable) this.trackedEditors.add(editable);
    this.ensureObserver();
  };

  private ensureObserver(): void {
    if (this.observer || typeof MutationObserver === "undefined") return;
    const root = document.documentElement;
    if (!root) return;
    this.observer = new MutationObserver(() => {
      for (const editable of this.trackedEditors) {
        if (this.isConnected(editable)) continue;
        this.debounced.get(editable)?.cancel();
        this.debounced.delete(editable);
        const state = this.getRequestState(editable);
        state.pending = false;
        state.pendingManual = false;
        state.pendingStateEpoch = this.stateEpoch;
        state.busyRetries = 0;
        this.latest.delete(editable);
        this.highlights.clear(editable);
        this.trackedEditors.delete(editable);
      }
    });
    this.observer.observe(root, { childList: true, subtree: true });
  }
}

let singleton: ContentController | undefined;
export function startContentController(): ContentController {
  singleton ??= new ContentController();
  singleton.start();
  return singleton;
}
export function getContentController(): ContentController | undefined {
  return singleton;
}
