import { useAppModeStore, type AppMode } from '../appModeStore';

const MODES: AppMode[] = ['SANDBOX', 'MISSION', 'ANALYSIS'];

export function ModeSwitcher() {
  const mode = useAppModeStore((state) => state.mode);
  const setMode = useAppModeStore((state) => state.setMode);
  return (
    <nav className="mode-switcher" aria-label="application mode">
      {MODES.map((candidate) => (
        <button
          type="button"
          key={candidate}
          className={candidate === mode ? 'active' : ''}
          onClick={() => setMode(candidate)}
        >
          {candidate}
        </button>
      ))}
    </nav>
  );
}
