import { useCallback, useEffect } from 'react';
import {
  handleCharacterKeyDown,
  handleCharacterKeyUp,
  type CharacterKeyTarget,
} from './characterInput';
import type { CharacterSession } from './characterSession';

export const CHARACTER_MOUSE_SENSITIVITY_RAD = 0.0025;

export interface CharacterEventPort {
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

export interface CharacterInputPort {
  readonly root: CharacterEventPort & { focus?: (options?: FocusOptions) => void; contains?: (target: any) => boolean };
  readonly window: CharacterEventPort;
  readonly document: CharacterEventPort & {
    hidden: boolean;
    pointerLockElement: unknown;
    exitPointerLock(): void;
  };
  readonly canvas: (CharacterEventPort & { requestPointerLock(): void | Promise<void> }) | null;
}

export interface CharacterInputAdapterOptions {
  readonly session: CharacterSession;
  readonly port: CharacterInputPort;
  readonly onChange?: () => void;
}

/**
 * DOM-free input owner. The port is intentionally small so pointer-lock
 * behavior can be checked with fakes without mounting React or a browser.
 */
export class CharacterInputAdapter {
  private readonly session: CharacterSession;
  private readonly port: CharacterInputPort;
  private readonly onChange: () => void;
  private readonly removeControlsListener: () => void;
  private mounted = false;
  private ownsPointerLock = false;
  private requestPending = false;
  private requestGeneration = 0;
  private pendingGeneration = 0;
  private drag: { pointerId: number; x: number; y: number } | null = null;
  private dragged = false;

  constructor(options: CharacterInputAdapterOptions) {
    this.session = options.session;
    this.port = options.port;
    this.onChange = options.onChange ?? (() => undefined);
    this.removeControlsListener = this.session.onControlsReleased(() => {
      this.releasePointerLock();
    });
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.port.root.addEventListener('keydown', this.onKeyDown);
    this.port.window.addEventListener('keyup', this.onKeyUp);
    this.port.root.addEventListener('focusout', this.onFocusOut);
    this.port.root.addEventListener('focusin', this.onFocusIn);
    this.port.window.addEventListener('blur', this.onBlur);
    this.port.document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.port.document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.port.document.addEventListener('pointerlockerror', this.onPointerLockError);
    this.port.canvas?.addEventListener('click', this.onCanvasClick);
    this.port.canvas?.addEventListener('mousemove', this.onMouseMove);
    this.port.canvas?.addEventListener('pointerdown', this.onDragStart);
    this.port.window.addEventListener('pointermove', this.onDragMove);
    this.port.window.addEventListener('pointerup', this.onDragEnd);
    this.port.window.addEventListener('pointercancel', this.onDragEnd);
  }

  unmount(): void {
    if (!this.mounted) {
      this.removeControlsListener();
      this.releasePointerLock();
      return;
    }
    this.mounted = false;
    this.port.root.removeEventListener('keydown', this.onKeyDown);
    this.port.window.removeEventListener('keyup', this.onKeyUp);
    this.port.root.removeEventListener('focusout', this.onFocusOut);
    this.port.root.removeEventListener('focusin', this.onFocusIn);
    this.port.window.removeEventListener('blur', this.onBlur);
    this.port.document.removeEventListener('visibilitychange', this.onVisibilityChange);
    // Keep completion listeners for a pending legacy request until it settles.
    this.detachLockListeners();
    this.port.canvas?.removeEventListener('click', this.onCanvasClick);
    this.port.canvas?.removeEventListener('mousemove', this.onMouseMove);
    this.port.canvas?.removeEventListener('pointerdown', this.onDragStart);
    this.port.window.removeEventListener('pointermove', this.onDragMove);
    this.port.window.removeEventListener('pointerup', this.onDragEnd);
    this.port.window.removeEventListener('pointercancel', this.onDragEnd);
    this.removeControlsListener();
    this.releasePointerLock();
    this.session.releaseControls();
  }

  focusRoot(): void {
    this.port.root.focus?.({ preventScroll: true });
  }

  private readonly onKeyDown = (event: any): void => {
    const target = event.target !== null && typeof event.target === 'object'
      ? event.target as CharacterKeyTarget
      : null;
    if (handleCharacterKeyDown(event, this.session, target)) this.onChange();
  };

  private readonly onKeyUp = (event: any): void => {
    handleCharacterKeyUp(event, this.session);
  };

  private readonly onFocusOut = (event: any): void => {
    if (this.port.root.contains?.(event.relatedTarget)) return;
    this.onBlur();
  };

  private readonly onFocusIn = (event: any): void => {
    const target = event.target as CharacterKeyTarget | null;
    if (target?.isContentEditable || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(target?.tagName ?? '')) this.session.releaseControls();
  };

  private detachLockListeners(): void {
    if (this.mounted || this.requestPending) return;
    this.port.document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.port.document.removeEventListener('pointerlockerror', this.onPointerLockError);
  }

  private readonly onPointerLockError = (): void => {
    this.requestPending = false;
    this.detachLockListeners();
  };

  private readonly onBlur = (): void => {
    this.session.loseFocus();
    this.releasePointerLock();
    this.onChange();
  };

  private readonly onVisibilityChange = (): void => {
    if (!this.port.document.hidden) return;
    this.session.loseFocus();
    this.releasePointerLock();
    this.onChange();
  };

  private readonly onPointerLockChange = (): void => {
    const locked = this.port.canvas !== null && this.port.document.pointerLockElement === this.port.canvas;
    if (locked) {
      const currentRequest = this.requestPending && this.pendingGeneration === this.requestGeneration;
      if ((currentRequest || this.ownsPointerLock) && this.session.mode === 'ON_FOOT' && !this.session.paused && this.session.groundReady && this.mounted) {
        this.requestPending = false;
        this.ownsPointerLock = true;
        this.drag = null;
        return;
      }
      this.requestPending = false;
      this.releasePointerLock();
      this.detachLockListeners();
      return;
    }
    if (!this.ownsPointerLock) return;
    this.ownsPointerLock = false;
    this.session.loseFocus();
    this.onChange();
  };

  private readonly onCanvasClick = (): void => {
    if (this.dragged) { this.dragged = false; return; }
    if (this.port.canvas === null || this.session.mode !== 'ON_FOOT' || this.session.paused || !this.session.groundReady) return;
    this.focusRoot();
    this.requestPointerLock();
  };

  private readonly onMouseMove = (event: any): void => {
    if (!this.ownsPointerLock || !Number.isFinite(event.movementX) || !Number.isFinite(event.movementY)) return;
    this.session.look(event.movementX * CHARACTER_MOUSE_SENSITIVITY_RAD, -event.movementY * CHARACTER_MOUSE_SENSITIVITY_RAD);
  };

  /** Embedded browsers may deny pointer lock; dragging still owns the look. */
  private readonly onDragStart = (event: any): void => {
    if (event.button !== 0 || this.drag !== null || this.ownsPointerLock || this.session.mode !== 'ON_FOOT'
      || this.session.paused || !this.session.groundReady
      || ![event.pointerId, event.clientX, event.clientY].every(Number.isFinite)) return;
    this.focusRoot();
    this.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    this.dragged = false;
    event.preventDefault();
  };

  private readonly onDragMove = (event: any): void => {
    const drag = this.drag;
    if (drag === null || event.pointerId !== drag.pointerId || this.ownsPointerLock
      || ![event.clientX, event.clientY].every(Number.isFinite)) return;
    if (Number.isFinite(event.buttons) && (event.buttons & 1) === 0) { this.drag = null; return; }
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag.x = event.clientX; drag.y = event.clientY;
    if (dx === 0 && dy === 0) return;
    this.dragged = true;
    this.session.look(dx * CHARACTER_MOUSE_SENSITIVITY_RAD, -dy * CHARACTER_MOUSE_SENSITIVITY_RAD);
  };

  private readonly onDragEnd = (event: any): void => {
    if (event.pointerId === this.drag?.pointerId) this.drag = null;
  };

  private requestPointerLock(): void {
    const canvas = this.port.canvas;
    if (canvas === null || this.requestPending || this.ownsPointerLock) return;
    const generation = ++this.requestGeneration;
    this.pendingGeneration = generation;
    this.requestPending = true;
    let result: void | Promise<void>;
    try {
      result = canvas.requestPointerLock();
    } catch {
      if (generation === this.requestGeneration) this.requestPending = false;
      return;
    }
    if (result === undefined) return;
    result.then(() => {
      if (generation === this.pendingGeneration) this.requestPending = false;
      if (generation !== this.requestGeneration || !this.mounted || this.session.mode !== 'ON_FOOT' || this.session.paused || !this.session.groundReady) {
        // An older request must not release a newer, already accepted lock.
        if (!this.ownsPointerLock) this.releasePointerLock();
        this.detachLockListeners();
        return;
      }
      this.ownsPointerLock = this.port.document.pointerLockElement === canvas;
    }).catch(() => {
      if (generation === this.pendingGeneration) this.requestPending = false;
      this.detachLockListeners();
    });
  }

  private releasePointerLock(): void {
    this.drag = null;
    this.requestGeneration += 1;
    const ownsElement = this.port.canvas !== null && this.port.document.pointerLockElement === this.port.canvas;
    this.ownsPointerLock = false;
    if (!ownsElement) return;
    try {
      this.port.document.exitPointerLock();
    } catch {
      // A browser may reject an already-lost lock; controls are already clear.
    }
  }
}

export interface UseCharacterInputOptions {
  readonly enabled: boolean;
  readonly session: CharacterSession | null;
  readonly rootRef: { current: HTMLElement | null };
  readonly canvas: HTMLCanvasElement | null;
  readonly onChange?: () => void;
}

/** Install the exclusive adapter only for the opt-in character route. */
export function useCharacterInput(options: UseCharacterInputOptions): { focusRoot: () => void } {
  const { enabled, session, rootRef, canvas, onChange } = options;
  useEffect(() => {
    if (!enabled || session === null || rootRef.current === null || typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    const adapter = new CharacterInputAdapter({
      session,
      onChange,
      port: { root: rootRef.current, window, document, canvas },
    });
    adapter.mount();
    adapter.focusRoot();
    return () => adapter.unmount();
  }, [canvas, enabled, onChange, rootRef, session]);
  const focusRoot = useCallback(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, [rootRef]);
  return { focusRoot };
}
