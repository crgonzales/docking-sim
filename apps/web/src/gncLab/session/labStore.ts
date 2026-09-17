import { create } from 'zustand';
import type { PlaybackRate, SessionState } from './labSession';

/** Presentation controls only. The atomic telemetry bus owns all stamped data. */
export interface LabStoreState {
  status: SessionState;
  playbackRate: PlaybackRate;
  publishHz: number;
  playbackLimited: boolean;
  error: string | null;
}
export const useLabStore = create<LabStoreState>(() => ({
  status: 'STOPPED', playbackRate: 1, publishHz: 10, playbackLimited: false, error: null,
}));
