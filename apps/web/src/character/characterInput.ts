import { FLIGHT_KEYS } from '../flight/flightSession';
import type { CharacterSession } from './characterSession';

export const CHARACTER_KEYS = new Set([
  'KeyF', 'Digit1', 'Digit2', 'Digit3', 'Escape',
]);

/** Keys routed through the coordinator while the character experiment is on. */
export const CHARACTER_ROUTED_KEYS = new Set([...FLIGHT_KEYS, ...CHARACTER_KEYS]);

const CONTROL_CHORD_KEYS = new Set([
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight',
  'KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

export type CharacterKeyEvent = Pick<KeyboardEvent,
  'code' | 'repeat' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing' | 'defaultPrevented' | 'preventDefault'>;
export type CharacterKeyTarget = Pick<HTMLElement, 'tagName' | 'isContentEditable'> & { type?: string };

function acceptsModifiers(event: CharacterKeyEvent): boolean {
  return !(event.metaKey || event.altKey || (event.ctrlKey && !CONTROL_CHORD_KEYS.has(event.code)) || event.isComposing);
}

function isEditableTarget(event: CharacterKeyEvent, target: CharacterKeyTarget | null): boolean {
  if (target?.isContentEditable || target?.tagName === 'TEXTAREA' || target?.tagName === 'BUTTON') return true;
  if (target?.tagName === 'INPUT' || target?.tagName === 'SELECT') {
    const flightWidget = target.tagName === 'SELECT' || target.type === 'range';
    return !flightWidget || (event.code !== 'KeyP' && event.code !== 'KeyR');
  }
  return false;
}

/**
 * Pure keyboard routing for the exclusive character surface. DOM ownership,
 * focus and pointer-lock lifecycle remain with the later React adapter.
 */
export function handleCharacterKeyDown(
  event: CharacterKeyEvent,
  session: CharacterSession,
  target: CharacterKeyTarget | null,
): boolean {
  if (!CHARACTER_ROUTED_KEYS.has(event.code) || event.defaultPrevented || !acceptsModifiers(event) || isEditableTarget(event, target)) return false;
  event.preventDefault();
  if (event.repeat) return false;
  return session.key(event.code, true);
}

export function handleCharacterKeyUp(
  event: Pick<KeyboardEvent, 'code'>,
  session: CharacterSession,
): boolean {
  if (!CHARACTER_ROUTED_KEYS.has(event.code)) return false;
  session.key(event.code, false);
  return true;
}
