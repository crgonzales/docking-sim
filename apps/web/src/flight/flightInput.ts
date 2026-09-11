import { FLIGHT_KEYS, type FlightSession } from './flightSession';

type KeyEvent = Pick<KeyboardEvent, 'code' | 'repeat' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing' | 'defaultPrevented' | 'preventDefault'>;
type KeyTarget = Pick<HTMLElement, 'tagName' | 'isContentEditable'> & { type?: string };

const CONTROL_CHORD_KEYS = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** Return true when a discrete command needs a UI update, even while rendering is paused. */
export function handleFlightKeyDown(event: KeyEvent, session: FlightSession, target: KeyTarget | null): boolean {
  if (!FLIGHT_KEYS.has(event.code) || event.defaultPrevented || event.isComposing || (event.ctrlKey && !CONTROL_CHORD_KEYS.has(event.code)) || event.metaKey || event.altKey) return false;
  if (target?.isContentEditable || target?.tagName === 'TEXTAREA' || target?.tagName === 'BUTTON') return false;
  if (target?.tagName === 'INPUT' || target?.tagName === 'SELECT') {
    const flightWidget = target.tagName === 'SELECT' || target.type === 'range';
    if (!flightWidget || (event.code !== 'KeyP' && event.code !== 'KeyR')) return false;
  }
  event.preventDefault();
  if (event.repeat) return false;
  session.key(event.code, true);
  return event.code === 'KeyP' || event.code === 'KeyR' || event.code === 'KeyC';
}
