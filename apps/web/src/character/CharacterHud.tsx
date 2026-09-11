import type { CharacterEquipment, CharacterSession } from './characterSession';
import './character.css';

export interface CharacterHudProps {
  readonly session: CharacterSession;
  readonly onChange?: () => void;
  readonly focusRoot?: () => void;
}

function action(session: CharacterSession, code: string, onChange: (() => void) | undefined, focusRoot: (() => void) | undefined): void {
  session.key(code, true);
  session.key(code, false);
  onChange?.();
  focusRoot?.();
}

function EquipmentIcon({ equipment }: { equipment: CharacterEquipment }): React.JSX.Element | null {
  if (equipment === 'EMPTY') return null;
  return <div className={`character-held-item character-held-item--${equipment.toLowerCase()}`} aria-label={`Inert ${equipment.toLowerCase()} placeholder`}>
    <svg viewBox="0 0 100 100" aria-hidden="true">
      {equipment === 'TOOL'
        ? <><path d="M47 91V39" /><path d="M26 32c0-10 9-18 21-18s21 8 21 18" /><path d="M38 39h24" /></>
        : <><path d="M47 91V31" /><path d="M35 31h24l-5-17H40z" /><path d="M39 48h16" /></>}
    </svg>
  </div>;
}

export function CharacterHud({ session, onChange, focusRoot }: CharacterHudProps): React.JSX.Element {
  const onFoot = session.mode === 'ON_FOOT';
  const status = session.flight.state.status !== 'FLYING'
    ? 'FLIGHT STOPPED · R TO RESET'
    : session.paused
    ? 'PAUSED · P TO RESUME'
    : session.parked && !session.groundReady
      ? 'LOADING TERRAIN · WAIT'
      : onFoot
        ? 'ON FOOT · F TO BOARD'
        : session.parked
          ? 'PARKED AIRCRAFT · NO TAKEOFF'
          : 'AIRBORNE VEHICLE · F TO EXIT';
  return <div className="character-hud" aria-label="First-person character controls">
    <div className="character-card character-card--status" role="status">
      <span>{session.start === 'GROUND' ? 'FLIGHT BASE / 01' : 'CHARACTER'}</span>
      <strong>{status}</strong>
      {session.interaction.message !== '' && <em>{session.interaction.message}</em>}
    </div>
    {onFoot && <>
      <div className="character-card character-card--instructions">
        <b>WASD</b> walk · <b>SHIFT</b> run · click or drag scene to look · arrows look<br />
        <b>F</b> board nearby aircraft · <b>P</b> pause · <b>R</b> reset
      </div>
      <div className="character-card character-card--equipment" aria-label="Equipment">
        <span>EQUIPMENT</span>
        <div className="character-equipment-buttons">
          {(['EMPTY', 'TOOL', 'WEAPON'] as const).map((equipment) => <button
            key={equipment}
            type="button"
            disabled={session.paused || !session.groundReady}
            aria-pressed={session.equipment === equipment}
            onClick={() => action(session, equipment === 'EMPTY' ? 'Digit1' : equipment === 'TOOL' ? 'Digit2' : 'Digit3', onChange, focusRoot)}
          >{equipment === 'EMPTY' ? '1 EMPTY' : equipment === 'TOOL' ? '2 TOOL' : '3 WEAPON'}</button>)}
        </div>
      </div>
      <EquipmentIcon equipment={session.equipment} />
    </>}
    <div className="character-card character-card--actions">
      {!onFoot && session.parked && <button type="button" onClick={() => action(session, 'KeyC', onChange, focusRoot)}>Camera: {session.flight.camera.toLowerCase()} · C</button>}
      <button type="button" onClick={() => action(session, 'KeyF', onChange, focusRoot)}>{onFoot ? 'Board · F' : 'Exit · F'}</button>
      <button type="button" onClick={() => action(session, 'KeyP', onChange, focusRoot)}>{session.paused ? 'Resume · P' : 'Pause · P'}</button>
      <button type="button" onClick={() => action(session, 'KeyR', onChange, focusRoot)}>Reset · R</button>
    </div>
  </div>;
}
