/// <reference types="vite/client" />
import { create } from 'zustand';
export const RCS_INSPECTION = import.meta.env.DEV && typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('thrusterProbe') === '1';
export const useRcsInspection = create<{
  jet: string; vectors: boolean; select: (jet: string) => void; toggleVectors: () => void;
}>(set => ({ jet: 'J1', vectors: true, select: jet => set({ jet }), toggleVectors: () => set(s => ({ vectors: !s.vectors })) }));
