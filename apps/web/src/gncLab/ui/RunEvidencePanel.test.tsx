import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { useAppModeStore } from '../../appModeStore';
import { useTelemetryBus } from '../../telemetry/bus';
import { getGncSession, startGncSession, stopGncSession } from '../../telemetry/gncEmitter';
import { useLabStore } from '../session/labStore';
import { NOMINAL_CASE } from '../session/demoRun';
import { exportRun, importRun } from '../session/runExport';
import { RunEvidencePanelView } from './RunEvidencePanel';
import { createRunFileOwner, FILE_BYTE_LIMITS, type RunFileOwner } from './runFileOwner';
import { createLabEvidence } from './labEvidence';
import { LabTools } from './LabTools';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); stopGncSession(); useAppModeStore.setState({ mode: 'MISSION' }); vi.restoreAllMocks(); vi.useRealTimers(); });
function begin() {
  vi.useFakeTimers(); useAppModeStore.setState({ mode: 'GNC' });
  startGncSession({ ...NOMINAL_CASE, maxTicks: 35 }, { paused: true, playbackRate: 4 });
  getGncSession()!.advanceTo(25);
  useTelemetryBus.getState().publishGncTick(getGncSession()!.snapshot());
  const blobs = new Map<string, Blob>(); let next = 0;
  const urls = { create: vi.fn((blob: Blob) => { const id = `blob:test-${++next}`; blobs.set(id, blob); return id; }),
    revoke: vi.fn((url: string) => { blobs.delete(url); }) };
  const shown = { ...useTelemetryBus.getState().gnc!.stamp };
  const owner = createRunFileOwner(shown, urls), stop = owner.connect(); cleanups.push(stop);
  return { owner, urls, blobs, stop, shown };
}
function elements(root: React.ReactNode): React.ReactElement[] {
  const result: React.ReactElement[] = [];
  React.Children.forEach(root, child => {
    if (React.isValidElement<{ children?: React.ReactNode }>(child)) result.push(child, ...elements(child.props.children));
  }); return result;
}
const view = (owner: RunFileOwner) => RunEvidencePanelView({ owner, state: owner.getSnapshot() });
const file = (name: string, text: string) => ({ name, size: new Blob([text]).size, text: vi.fn(async () => text) });
const deferred = () => {
  let resolve!: (text: string) => void, reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
};

it('uses the actual export button for paired current-recorder downloads and imports the same summary without touching live state', async () => {
  const { owner, blobs } = begin(), session = getGncSession()!, bus = useTelemetryBus.getState(), store = useLabStore.getState();
  elements(view(owner)).find(el => el.type === 'button' && el.props.children === 'Export current run')!.props.onClick();
  const prepared = owner.getSnapshot().prepared!, links = elements(view(owner)).filter(el => el.type === 'a');
  expect(links.map(el => el.props.download)).toEqual(['run.json', 'signals.csv']); expect(blobs.size).toBe(2);
  const artifact = { runJson: await blobs.get(prepared.jsonUrl)!.text(), signalsCsv: await blobs.get(prepared.csvUrl)!.text() };
  expect(artifact).toEqual(exportRun(session, 4)); expect(importRun(artifact).metadata.rows).toBe(2);
  expect(blobs.get(prepared.csvUrl)!.type).toBe('text/csv;charset=utf-8');
  const preventDefault = vi.fn(); links[0].props.onClick({ preventDefault }); expect(preventDefault).not.toHaveBeenCalled();
  const inputs = elements(view(owner)).filter(el => el.type === 'input');
  const jsonInput = { files: [file('run.json', artifact.runJson)], value: 'selection' };
  inputs[0].props.onChange({ currentTarget: jsonInput }); expect(jsonInput.value).toBe('');
  inputs[1].props.onChange({ currentTarget: { files: [file('signals.csv', artifact.signalsCsv)], value: '' } });
  await owner.load();
  expect(owner.getSnapshot().imported!.metrics).toEqual(prepared.metadata.metrics);
  expect(owner.getSnapshot().imported).not.toHaveProperty('signalsCsv');
  expect(useTelemetryBus.getState()).toBe(bus); expect(useLabStore.getState()).toBe(store);
  expect(getGncSession()).toBe(session); expect(session.tick).toBe(25); expect(vi.getTimerCount()).toBe(1);
  const html = renderToStaticMarkup(view(owner));
  expect(html).toContain('Imported recorded evidence — not live telemetry'); expect(html).toContain('source at capture: LIVE');
  expect(html).toContain('Recorded prefix'); expect(html).toContain('Pending slices are excluded');
  expect(html).toContain('not a 100 Hz peak'); expect(html).toContain('Session-owned REPLAY playback is not implemented');
});

it('rolls back partial URL creation, preserves the prior pair on refusal, and revokes replaced/cleared/retired links', () => {
  const { owner, urls, blobs, stop } = begin(); owner.prepare();
  const first = owner.getSnapshot().prepared!, oldLink = elements(view(owner)).find(el => el.type === 'a')!;
  urls.create.mockImplementationOnce(blob => { blobs.set('blob:candidate', blob); return 'blob:candidate'; })
    .mockImplementationOnce(() => { throw new Error('URL allocation refused'); });
  owner.prepare(); expect(owner.getSnapshot().prepared).toBe(first);
  expect(owner.getSnapshot().error).toContain('URL allocation refused'); expect(blobs.size).toBe(2);
  expect(urls.revoke).toHaveBeenCalledWith('blob:candidate');
  owner.prepare(); expect(blobs.size).toBe(2); expect(blobs.has(first.jsonUrl)).toBe(false);
  const preventDefault = vi.fn(); oldLink.props.onClick({ preventDefault }); expect(preventDefault).toHaveBeenCalledOnce();
  owner.clear(); expect(blobs.size).toBe(0); owner.prepare(); stop(); expect(blobs.size).toBe(0);
  const calls = urls.create.mock.calls.length; owner.prepare(); expect(urls.create).toHaveBeenCalledTimes(calls);
  expect(getGncSession()).not.toBeNull(); expect(vi.getTimerCount()).toBe(1);
});

it.each(['mode', 'source', 'run', 'epoch', 'config', 'replacement'] as const)('retires callbacks and URLs on current %s change', change => {
  const { owner, blobs, shown } = begin(); owner.prepare(); const links = elements(view(owner)).filter(el => el.type === 'a');
  const tick = useTelemetryBus.getState().gnc!;
  if (change === 'mode') useAppModeStore.setState({ mode: 'MISSION' });
  else if (change === 'replacement') startGncSession({ ...NOMINAL_CASE, maxTicks: 35 }, { paused: true });
  else useTelemetryBus.setState({ gnc: { ...tick, stamp: { ...tick.stamp,
    ...(change === 'source' ? { source: 'REPLAY' as const } : change === 'run' ? { runId: 'other' }
      : change === 'epoch' ? { epoch: tick.stamp.epoch + 1 } : { configHash: 'other' }) } } });
  Object.assign(shown, useTelemetryBus.getState().gnc!.stamp); // Cannot retarget the captured scalar identity.
  const before = owner.getSnapshot(), live = getGncSession(), store = useLabStore.getState();
  owner.prepare(); owner.select('json', file('fake.json', '{}')); owner.clear();
  expect(owner.getSnapshot()).toBe(before); expect(blobs.size).toBe(0); expect(getGncSession()).toBe(live); expect(useLabStore.getState()).toBe(store);
  for (const link of links) { const preventDefault = vi.fn(); link.props.onClick({ preventDefault }); expect(preventDefault).toHaveBeenCalledOnce(); }
});

it('invalidates pending file results on new selection and admits only one read until both inputs settle', async () => {
  const { owner } = begin(), artifact = exportRun(getGncSession()!, 4), a = deferred(), b = deferred();
  owner.select('json', { name: 'old.json', size: 1, text: () => a.promise });
  owner.select('csv', { name: 'old.csv', size: 1, text: () => b.promise }); const pending = owner.load();
  const next = file('next.json', artifact.runJson); owner.select('json', next);
  await owner.load(); expect(next.text).not.toHaveBeenCalled(); expect(owner.getSnapshot().busy).toBe(true);
  a.reject(new Error('old read failed')); b.resolve(artifact.signalsCsv); await pending;
  expect(owner.getSnapshot().error).toBeNull(); expect(owner.getSnapshot().imported).toBeNull(); expect(owner.getSnapshot().busy).toBe(false);
  owner.select('csv', file('next.csv', artifact.signalsCsv)); await owner.load(); expect(owner.getSnapshot().imported!.rows).toBe(2);
});

it('retires the old effect generation across cleanup/reconnect, including pending reads and download links', async () => {
  const { owner, stop, blobs } = begin(); owner.prepare();
  const link = elements(view(owner)).find(el => el.type === 'a')!, pendingText = deferred();
  const artifact = exportRun(getGncSession()!, 4);
  owner.select('json', { name: 'run.json', size: 1, text: () => pendingText.promise });
  owner.select('csv', file('signals.csv', artifact.signalsCsv)); const pending = owner.load();
  stop(); const disconnect = owner.connect(); cleanups.push(disconnect);
  owner.prepare(); expect(blobs.size).toBe(2);
  const before = owner.getSnapshot(); pendingText.resolve(artifact.runJson); await pending;
  expect(owner.getSnapshot()).toBe(before); expect(before.imported).toBeNull();
  const preventDefault = vi.fn(); link.props.onClick({ preventDefault }); expect(preventDefault).toHaveBeenCalledOnce();
});

it.each(['replacement', 'unmount'] as const)('discards late file successes and failures after %s', async change => {
  const { owner, stop } = begin(), a = deferred(), b = deferred();
  owner.select('json', { name: 'run.json', size: 1, text: () => a.promise });
  owner.select('csv', { name: 'signals.csv', size: 1, text: () => b.promise }); const pending = owner.load();
  if (change === 'unmount') stop(); else startGncSession({ ...NOMINAL_CASE, maxTicks: 35 }, { paused: true });
  const before = owner.getSnapshot(); a.resolve('{}'); b.reject(new Error('retired failure')); await pending;
  expect(owner.getSnapshot()).toBe(before); expect(before.imported).toBeNull(); expect(before.error).toBeNull();
});

it('releases the shared read slot for new file selections after effect reconnect', async () => {
  const { owner, stop } = begin(), artifact = exportRun(getGncSession()!, 4), old = deferred();
  owner.select('json', { name: 'old.json', size: 1, text: () => old.promise });
  owner.select('csv', file('old.csv', artifact.signalsCsv)); const pending = owner.load();
  stop(); cleanups.push(owner.connect());
  owner.select('json', file('new.json', artifact.runJson));
  owner.select('csv', file('new.csv', artifact.signalsCsv));
  expect(owner.getSnapshot().busy).toBe(true);
  old.resolve(artifact.runJson); await pending;
  expect(owner.getSnapshot().imported).toBeNull();
  expect(owner.getSnapshot().error).toBeNull();
  expect(owner.getSnapshot().busy).toBe(false);
  await owner.load(); expect(owner.getSnapshot().imported!.rows).toBe(2);
});

it('refuses oversized/invalid pairs without losing the previous summary and preserves artifact provenance as recorded', async () => {
  const { owner } = begin(), artifact = exportRun(getGncSession()!, 4);
  owner.select('json', file('run.json', artifact.runJson)); owner.select('csv', file('signals.csv', artifact.signalsCsv)); await owner.load();
  const previous = owner.getSnapshot().imported;
  const oversized = { ...file('large.json', ''), size: FILE_BYTE_LIMITS.json + 1 };
  owner.select('json', oversized); await owner.load(); expect(oversized.text).not.toHaveBeenCalled(); expect(owner.getSnapshot().imported).toBe(previous);
  owner.select('json', file('bad.json', '{}')); await owner.load(); expect(owner.getSnapshot().error).not.toBeNull(); expect(owner.getSnapshot().imported).toBe(previous);
  // Only artifact provenance changes. No session/source setter is invoked by import.
  owner.select('json', file('recorded.json', artifact.runJson.replace('"source":"LIVE"', '"source":"REPLAY"'))); await owner.load();
  expect(owner.getSnapshot().imported!.stamp.source).toBe('REPLAY'); expect(useTelemetryBus.getState().gnc!.stamp.source).toBe('LIVE');
});

it('adds the disclosure in the existing tools with no simulation startup during rendering', () => {
  const { owner } = begin(), model = createLabEvidence(), disconnect = model.connect(); cleanups.push(disconnect);
  const session = getGncSession()!, before = useTelemetryBus.getState();
  const html = renderToStaticMarkup(<LabTools model={model} state={model.getSnapshot()} tick={before.gnc} />);
  expect(html).toContain('<summary>Run files</summary>'); expect(html).toContain('Export current run');
  expect(html).toContain('even when previous-run plots are selected'); expect(html).not.toContain('Prepared recorded capture');
  expect(getGncSession()).toBe(session); expect(useTelemetryBus.getState()).toBe(before); expect(owner.getSnapshot().prepared).toBeNull();
});
