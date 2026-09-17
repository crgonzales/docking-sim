#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const fixturePath = path.join(here, 'fixtures/reference.json');

const SOURCE_FILES = [
  'tools/matlab-port/exportReference.mjs',
  'packages/sim-core/src/attitude.ts',
  'packages/sim-core/src/constants.ts',
  'packages/sim-core/src/control.ts',
  'packages/sim-core/src/crewDragon.ts',
  'packages/sim-core/src/dynamics.ts',
  'packages/sim-core/src/ekf.ts',
  'packages/sim-core/src/index.ts',
  'packages/sim-core/src/thrusters.ts',
  'packages/sim-core/src/types.ts',
];

function sha256(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) return null;
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
}

function sourceHashes() {
  return Object.fromEntries(SOURCE_FILES.map((relativePath) => [relativePath, sha256(relativePath)]));
}

function assertHashes(reference) {
  const expected = reference?.sourceHashes;
  if (!expected || typeof expected !== 'object') throw new Error('fixture has no sourceHashes');
  for (const relativePath of SOURCE_FILES) {
    const actual = sha256(relativePath);
    if (!actual) throw new Error(`source file is missing: ${relativePath}`);
    if (expected[relativePath] !== actual) {
      throw new Error(`source hash mismatch for ${relativePath}: fixture=${expected[relativePath] ?? 'missing'} current=${actual}`);
    }
  }
  for (const [relativePath, expectedHash] of Object.entries(expected)) {
    const actual = sha256(relativePath);
    if (!actual || actual !== expectedHash) throw new Error(`source hash mismatch for ${relativePath}`);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeCommands(specs, windows) {
  const choices = [0, 0.02, 0.03, 0.04, 0.07];
  return Array.from({ length: windows }, (_, windowIndex) => {
    const requested = Object.fromEntries(specs.map((spec, specIndex) => [
      spec.id,
      choices[(windowIndex * 3 + specIndex * 2 + 1) % choices.length],
    ]));
    const quantized = Object.fromEntries(specs.map((spec) => {
      const value = requested[spec.id];
      return [spec.id, value >= 0.02 ? Math.round(value * 100) / 100 : 0];
    }));
    return { windowIndex: windowIndex + 1, requestedOnTime_s: requested, quantizedOnTime_s: quantized };
  });
}

function runPulseCase(sim, config, definition) {
  const states = {};
  let remaining = {};
  let state = clone(config.initial.state);
  const samples = [{ tick: 0, time_s: definition.startTime_s, state: clone(state) }];
  const events = [...definition.events].sort((a, b) => a.tick - b.tick);
  let eventIndex = 0;
  for (let tick = 1; tick <= definition.ticks; tick += 1) {
    while (eventIndex < events.length && events[eventIndex].tick === tick) {
      const event = events[eventIndex];
      states[event.thrusterId] = event.kind === 'STUCK_OPEN' ? 'stuck_open' : 'isolated';
      remaining[event.thrusterId] = 0;
      eventIndex += 1;
    }
    if ((tick - 1) % config.ticksPerWindow === 0) {
      const window = definition.commands[(tick - 1) / config.ticksPerWindow];
      remaining = clone(window.quantizedOnTime_s);
    }
    const command = Object.fromEntries(sim.specs.map((spec) => [
      spec.id,
      states[spec.id] === undefined || states[spec.id] === 'nominal'
        ? Math.min(config.dt_s, remaining[spec.id] ?? 0)
        : 0,
    ]));
    const application = sim.applyThrusterCommand(command, {
      specs: sim.specs,
      states,
      prop_kg: state[13],
      dryMass_kg: config.dryMass_kg,
      truthHz: config.truthHz,
      window_s: config.dt_s,
      minOnTime_s: 0,
    });
    const truthState = {
      t_s: definition.startTime_s + (tick - 1) * config.dt_s,
      r_hill_m: state.slice(0, 3),
      v_hill_mps: state.slice(3, 6),
      q_BI: state.slice(6, 10),
      w_body_rps: state.slice(10, 13),
      prop_kg: state[13],
    };
    const nextTruth = sim.stepTruth(truthState, {
      dt_s: config.dt_s,
      meanMotionRadS: config.meanMotionRadS,
      externalSpecificForce_body_mps2: application.specificForce_body_mps2,
      torque_body_Nm: application.torque_Nm,
      inertia_kg_m2: config.inertia_kg_m2,
      propellantRate_kg_s: application.propellantRate_kg_s,
    });
    state = [
      ...nextTruth.r_hill_m,
      ...nextTruth.v_hill_mps,
      ...nextTruth.q_BI,
      ...nextTruth.w_body_rps,
      nextTruth.prop_kg,
    ];
    for (const spec of sim.specs) {
      if (states[spec.id] === undefined || states[spec.id] === 'nominal') {
        remaining[spec.id] = Math.max(0, (remaining[spec.id] ?? 0) - config.dt_s);
      }
    }
    samples.push({ tick, time_s: definition.startTime_s + tick * config.dt_s, state: clone(state) });
  }
  return { ...definition, states: clone(states), truthSamples: samples };
}

async function loadSimCore() {
  const { createServer } = await import(path.join(repoRoot, 'apps/web/node_modules/vite/dist/node/index.js'));
  const server = await createServer({
    configFile: false,
    root: repoRoot,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
  });
  try {
    return await server.ssrLoadModule('/packages/sim-core/src/index.ts');
  } finally {
    await server.close();
  }
}

async function generate() {
  const hashes = sourceHashes();
  for (const [relativePath, hash] of Object.entries(hashes)) {
    if (!hash) throw new Error(`source file is missing: ${relativePath}`);
  }
  const sim = await loadSimCore();
  const specs = sim.CREW_DRAGON_THRUSTERS.map((spec) => ({
    id: spec.id,
    position_body_m: [...spec.position_body_m],
    direction_body: [...spec.direction_body],
    thrust_N: spec.thrust_N,
    nozzleRadiusM: spec.nozzleRadiusM,
    sourceComponent: spec.sourceComponent,
  }));
  const config = {
    schemaVersion: 1,
    truthHz: sim.TRUTH_HZ,
    fswHz: sim.FSW_HZ,
    ticksPerWindow: sim.TRUTH_HZ / sim.FSW_HZ,
    dt_s: 1 / sim.TRUTH_HZ,
    window_s: 1 / sim.FSW_HZ,
    meanMotionRadS: sim.MEAN_MOTION_RAD_S,
    earthRadius_m: sim.R_EARTH_M,
    muEarth_m3_s2: sim.MU_EARTH_M3_S2,
    dryMass_kg: sim.DEFAULT_DRY_MASS_KG,
    initialProp_kg: sim.DEFAULT_PROP_KG,
    isp_s: sim.DEFAULT_ISP_S,
    g0_mps2: sim.G0_MPS2,
    minOnTime_s: sim.DEFAULT_MIN_ON_TIME_S,
    inertia_kg_m2: [...sim.DEFAULT_INERTIA_KG_M2],
    specs,
    initial: {
      time_s: 37.25,
      state: [3.0, -42.0, 1.5, 0.02, 0.1, -0.01,
        Math.cos(0.31 / 2), 0.0, Math.sin(0.31 / 2), 0.0,
        0.001, -0.002, 0.0015, 24.0],
    },
  };
  const commands = makeCommands(specs, 100);
  const baseCase = {
    startTime_s: config.initial.time_s,
    dt_s: config.dt_s,
    ticks: 1000,
    commands,
    events: [],
  };
  const simApi = {
    specs,
    applyThrusterCommand: sim.applyThrusterCommand,
    stepTruth: sim.stepTruth,
  };
  const nominal = runPulseCase(simApi, config, { ...baseCase, id: 'NOMINAL' });
  const stuckOpen = runPulseCase(simApi, config, {
    ...baseCase,
    id: 'J6_STUCK_OPEN_ISOLATED',
    events: [
      { tick: 400, kind: 'STUCK_OPEN', thrusterId: 'J6' },
      { tick: 700, kind: 'ISOLATE', thrusterId: 'J6' },
    ],
  });
  const actuatorOptions = { specs: sim.CREW_DRAGON_THRUSTERS, truthHz: 100, window_s: 0.1 };
  const actuatorCases = [
    ['PULSE_THRESHOLD', { J1: 0.02 }, { ...actuatorOptions, prop_kg: 24 }],
    ['ISOLATED', { J2: 0.1 }, { ...actuatorOptions, prop_kg: 24, states: { J2: 'isolated' } }],
    ['DEPLETED_FUEL', { J3: 0.1 }, { ...actuatorOptions, prop_kg: 0 }],
  ].map(([id, command, options]) => ({
    id,
    command,
    application: sim.applyThrusterCommand(command, options),
  }));
  const qWeights = [1, 1, 1, 10, 10, 10];
  const rWeights = [1, 1, 1];
  const lqr = sim.createLqrController({
    meanMotionRadS: config.meanMotionRadS,
    dt_s: 0.1,
    mass_kg: 1000,
    qWeights,
    rWeights,
  });
  const matrices = sim.cwDiscreteMatrices(config.meanMotionRadS, 0.1);
  const reference = {
    schemaVersion: 1,
    generatedBy: 'tools/matlab-port/exportReference.mjs',
    sourceFiles: SOURCE_FILES,
    sourceHashes: hashes,
    config,
    cases: { nominal, stuckOpen },
    actuatorCases,
    lqr: {
      dt_s: 0.1,
      mass_kg: 1000,
      qWeights,
      rWeights,
      phi: matrices.phi,
      gamma: matrices.gamma,
      gain_3x6: lqr.gain_3x6,
      riccatiResidual: lqr.riccatiResidual,
      closedLoopMatrix: lqr.closedLoopMatrix,
    },
  };
  await mkdir(path.dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, `${JSON.stringify(reference, null, 2)}\n`, 'utf8');
  console.log(`wrote ${path.relative(repoRoot, fixturePath)}`);
}

async function main() {
  if (process.argv.includes('--check')) {
    if (!existsSync(fixturePath)) throw new Error(`fixture is missing: ${fixturePath}`);
    assertHashes(JSON.parse(readFileSync(fixturePath, 'utf8')));
    console.log('MATLAB port source hashes are current');
    return;
  }
  await generate();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
