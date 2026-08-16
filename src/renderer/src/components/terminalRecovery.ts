export interface TerminalRecoveryState {
  initialRedrawRequested: boolean;
  webglRecoveryPending: boolean;
}

export function createTerminalRecoveryState(): TerminalRecoveryState {
  return { initialRedrawRequested: false, webglRecoveryPending: false };
}

/** React key for one disposable xterm instance attached to a stable PTY id. */
export function terminalInstanceKey(ptyId: string, generation = 0): string {
  return `${ptyId}:${generation}`;
}

/** Accept output from the current string protocol and the short-lived replay
 * protocol so a renderer hot reload stays usable until the app next exits. */
export function normalizePtyChunk(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'data' in value) {
    const data = (value as { data?: unknown }).data;
    if (typeof data === 'string') return data;
  }
  return '';
}

/** Request exactly one redraw after the renderer has subscribed to PTY output.
 *
 *  The latch is only set once the redraw has actually SUCCEEDED. It used to be
 *  set up front, before the fire-and-forget IPC resolved — so a redraw that
 *  failed or raced left a terminal that had already consumed its one chance,
 *  with no output to repaint it and no retry path. That is a blank pane with a
 *  perfectly healthy pty behind it. A rejected redraw now leaves the latch clear
 *  so the next attach tries again. */
export function requestInitialPtyRedraw(
  state: TerminalRecoveryState,
  requestRedraw: () => void | Promise<unknown>
): boolean {
  if (state.initialRedrawRequested) return false;
  // Set before awaiting so two attaches in the same tick can't both fire; a
  // failure clears it again below.
  state.initialRedrawRequested = true;
  try {
    const result = requestRedraw();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      void (result as Promise<unknown>).catch(() => {
        state.initialRedrawRequested = false;
      });
    }
  } catch {
    state.initialRedrawRequested = false;
  }
  return true;
}

/** Wait two paint frames after WebGL disposal so the DOM renderer can repaint.
 *
 *  `recover` reports whether it actually repainted. When it could not (the host
 *  is detached or still unsized), the pending flag is cleared AND the caller
 *  keeps its needs-repaint marker, so a later attach can schedule another
 *  attempt. Clearing the flag unconditionally before the repaint was confirmed
 *  is what made the blank terminal recover "sometimes" — whether a later resize
 *  happened to rebuild the renderer was pure luck. */
export function scheduleWebglRecovery(
  state: TerminalRecoveryState,
  requestFrame: (cb: () => void) => void,
  recover: () => void
): boolean {
  if (state.webglRecoveryPending) return false;
  state.webglRecoveryPending = true;
  requestFrame(() => requestFrame(() => {
    state.webglRecoveryPending = false;
    recover();
  }));
  return true;
}

/** The minimum a canvas has to offer for its GPU context to be handed back.
 *  Typed structurally so the tests can pass plain objects. */
export interface ReleasableCanvas {
  isConnected: boolean;
  getContext(type: string): { getExtension(name: string): unknown } | null;
}

/** Hand the GPU contexts of released WebGL canvases back to the browser.
 *
 *  `addon.dispose()` does NOT do this. @xterm/addon-webgl never calls
 *  WEBGL_lose_context, and on xterm 5.5.0 its teardown throws before it can
 *  restore the DOM renderer (it dereferences `_terminal._core._store`, which
 *  5.5.0 does not have), so the terminal's render service keeps pointing at the
 *  disposed WebGL renderer — which keeps its canvas, which keeps a LIVE GL
 *  context — for as long as the pooled terminal exists. Chromium caps live
 *  contexts at ~16 and silently EVICTS THE OLDEST when a new one pushes past
 *  the cap; the office floor's Pixi canvas is built at startup, so it is always
 *  the oldest. That is why clicking an agent card — which leases a context for
 *  the newly selected terminal — SOMETIMES blacks out the floor and rebuilds
 *  it: the click that crossed the cap.
 *
 *  Only canvases the addon has already unparented are touched; one still in the
 *  document belongs to a terminal that legitimately owns it. Returns how many
 *  contexts were released. */
export function releaseWebglContexts(canvases: readonly ReleasableCanvas[]): number {
  let released = 0;
  for (const canvas of canvases) {
    if (canvas.isConnected) continue;
    try {
      // Never mint a context: getContext('webgl2') returns null for a canvas
      // that already holds a 2D one, and every canvas xterm leaves behind holds
      // one or the other.
      const lose = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context') as
        { loseContext(): void } | null | undefined;
      if (!lose) continue;
      lose.loseContext();
      released += 1;
    } catch {
      // A canvas that cannot give its context back must not stop the others —
      // the leak is cumulative, so a skipped one costs a later floor reset.
    }
  }
  return released;
}
