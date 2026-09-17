import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { BlockDiagram } from './ui/BlockDiagram';
import { BlockNode } from './ui/BlockNode';
import { Inspector, type InspectorProps } from './ui/Inspector';
import { GncLabView } from './ui/GncLab';
import { createLabSession } from './session/labSession';
import { NOMINAL_CASE } from './session/demoRun';
import { useLabStore } from './session/labStore';

const local = vi.hoisted(() => ({ selection: null as unknown }));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useState: (initial: unknown) => [local.selection ?? initial, (value: unknown) => { local.selection = value; }],
}));
afterEach(() => { local.selection = null; });

function elements(root: React.ReactNode): React.ReactElement[] {
  const result: React.ReactElement[] = [];
  React.Children.forEach(root, child => {
    if (React.isValidElement<{ children?: React.ReactNode }>(child))
      result.push(child, ...elements(child.props.children));
  });
  return result;
}

it('opens the actual Command blocks with a captured stamp, keeps it through ticks, and closes', () => {
  const run = createLabSession({ ...NOMINAL_CASE, maxTicks: 30 }, { runId: 'inspector', epoch: 1, poseEpoch: 1 });
  try {
    const tick = run.snapshot();
    const node = elements(BlockDiagram({ tick })).find(el => el.type === BlockNode && el.props.title === 'Command')!;
    node.props.onSelect(node.props.id);
    run.advanceTo(10);
    const inspector = elements(BlockDiagram({ tick: run.snapshot() })).find(el => el.type === Inspector)!;
    const props = inspector.props as InspectorProps;
    expect(props.selection).toEqual({ stamp: { runId: 'inspector', epoch: 1, source: 'LIVE' },
      blockIds: ['fsw.modeSwitch', 'control.attitude'] });
    expect(props.tick).toEqual(run.snapshot());
    expect(renderToStaticMarkup(React.createElement(Inspector, props))).toContain('Stage inspector');
    const close = elements(BlockDiagram({ tick: run.snapshot() })).find(el => el.props['aria-label'] === 'Close stage connections')!;
    close.props.onClick();
    expect(elements(BlockDiagram({ tick })).some(el => el.type === Inspector)).toBe(false);
  } finally { run.dispose(); }
});

it('does not relabel a retained selection on replacement, and keys the diagram by source, run and epoch', () => {
  const run = createLabSession({ ...NOMINAL_CASE, maxTicks: 30 }, { runId: 'first', epoch: 1, poseEpoch: 1 });
  try {
    const tick = run.snapshot();
    const node = elements(BlockDiagram({ tick })).find(el => el.type === BlockNode)!;
    node.props.onSelect(node.props.id);
    const replacement = { ...tick, stamp: { ...tick.stamp, runId: 'second', epoch: 2 } };
    const inspector = elements(BlockDiagram({ tick: replacement })).find(el => el.type === Inspector)!;
    expect(inspector.props.selection.stamp.runId).toBe('first');
    expect(renderToStaticMarkup(React.createElement(Inspector, inspector.props))).toContain('Selection unavailable');
    local.selection = null;
    const key = (value: typeof tick) => elements(GncLabView({ tick: value, presentation: useLabStore.getState() }))
      .find(el => el.type === BlockDiagram)!.key;
    expect(key(tick)).not.toBe(key(replacement));
    expect(key(tick)).not.toBe(key({ ...tick, stamp: { ...tick.stamp, runId: 'changed-only' } }));
    expect(key(tick)).not.toBe(key({ ...tick, stamp: { ...tick.stamp, source: 'REPLAY' } }));
  } finally { run.dispose(); }
});
