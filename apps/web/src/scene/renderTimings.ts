import type { EffectComposer, Pass } from 'postprocessing';
import type { WebGLRenderer } from 'three';
import { PROBE_PROFILE } from './renderProbeConfig';

const MAX_GPU_QUERIES = 16;
const GPU_POLL_BUDGET = 16;
const MAX_REPORTED_MS = 60_000;

interface TimerExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

type WebGL2TimerContext = Pick<WebGL2RenderingContext,
  'QUERY_RESULT' | 'QUERY_RESULT_AVAILABLE' | 'createQuery' | 'beginQuery'
  | 'endQuery' | 'getQueryParameter' | 'deleteQuery'>;

interface MetricState {
  windowCount: number;
  windowTotalMs: number;
  windowMaxMs: number;
  totalCount: number;
  totalMs: number;
  totalMaxMs: number;
  lastMs: number;
}

export interface TimingAggregate {
  readonly count: number;
  readonly totalMs: number;
  readonly averageMs: number;
  readonly maxMs: number;
  readonly lastMs: number;
}

export interface RenderBufferContext {
  readonly owner: 'effect-composer' | 'canvas';
  readonly input?: RenderTargetContext;
  readonly output?: RenderTargetContext;
}

export interface RenderTargetContext {
  readonly size: readonly [number, number];
  readonly format: number;
  readonly type: number;
  readonly samples: number;
  readonly colorSpace: string;
}

export interface RenderDeviceContext {
  readonly backend: 'library' | 'legacy';
  readonly webgl: 'webgl1' | 'webgl2' | 'unknown';
  readonly vendor: string | null;
  readonly renderer: string | null;
  readonly version: string | null;
  readonly shadingLanguageVersion: string | null;
  readonly canvas: readonly [number, number];
  readonly drawingBuffer: readonly [number, number];
  readonly dpr: number | null;
  readonly contextAttributes: {
    readonly alpha: boolean | null;
    readonly antialias: boolean | null;
    readonly depth: boolean | null;
    readonly stencil: boolean | null;
  } | null;
  readonly buffer: RenderBufferContext | null;
}

export type GpuTimingStatus =
  | 'profile-disabled'
  | 'renderer-unavailable'
  | 'webgl2-required'
  | 'extension-unavailable'
  | 'query-allocation-failed'
  | 'query-error'
  | 'supported';

export interface TerrainTimingState {
  readonly resident: number;
  readonly displayed: number;
  readonly desired: number;
  readonly pendingBuilds: number;
  readonly pendingWorkerQueue: number;
  readonly activeWorkerBuilds: number;
  readonly coverageReady: boolean;
}

interface MutableTerrainTimingState {
  resident: number;
  displayed: number;
  desired: number;
  pendingBuilds: number;
  pendingWorkerQueue: number;
  activeWorkerBuilds: number;
  coverageReady: boolean;
}

export interface PipTimingState {
  readonly visible: boolean;
  readonly renderedLastFrame: boolean;
  /** Completed PiP passes since the preceding snapshot. */
  readonly renderCount: number;
  readonly renderCountCumulative: number;
}

export interface RenderTimingSnapshot {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly cpu: Readonly<Record<string, TimingAggregate>>;
  readonly cpuCumulative: Readonly<Record<string, TimingAggregate>>;
  readonly gpu: {
    readonly status: GpuTimingStatus;
    readonly pendingQueries: number;
    readonly disjointEvents: number;
    readonly discardedQueries: number;
    readonly timings: Readonly<Record<string, TimingAggregate>>;
    readonly cumulative: Readonly<Record<string, TimingAggregate>>;
  };
  readonly context: RenderDeviceContext | null;
  readonly terrain: TerrainTimingState;
  readonly pip: PipTimingState;
}

interface GpuQuerySlot {
  query: WebGLQuery | null;
  state: 'free' | 'active' | 'pending';
  name: string;
  discard: boolean;
}

const METRIC_NAMES = [
  'frame.callbacksCpuWall',
  'cameraRig.frameCpuWall',
  'cameraRig.groundCpuWall',
  'profiling.gpuPollCpuWall',
  'pip.render',
  'terrain.selection',
  'terrain.reconciliation',
  'terrain.worker.dispatch',
  'terrain.worker.roundTrip',
  'terrain.worker.cpuBuild',
  'terrain.geometryPreparation',
  'composer.setup',
  'composer.renderCpuWall',
  'composer.firstUseCpuWall',
  'composer.pass.renderScene',
  'composer.pass.surfaceNormals',
  'composer.pass.lightingMask',
  'composer.pass.clouds',
  'composer.pass.atmosphereToneMapping',
  'cloud.setup',
  'cloud.assetsAssignmentCpuWall',
  'cloud.schedule.reprojectionBefore',
  'cloud.schedule.shadowRange',
  'cloud.schedule.lightingMask',
  'cloud.schedule.reprojectionAfter',
] as const;

function emptyTerrainState(): MutableTerrainTimingState {
  return {
    resident: 0,
    displayed: 0,
    desired: 0,
    pendingBuilds: 0,
    pendingWorkerQueue: 0,
    activeWorkerBuilds: 0,
    coverageReady: false,
  };
}

function emptyPipState() {
  return { visible: false, renderedLastFrame: false, renderCount: 0, renderCountCumulative: 0 };
}

function makeMetric(): MetricState {
  return {
    windowCount: 0,
    windowTotalMs: 0,
    windowMaxMs: 0,
    totalCount: 0,
    totalMs: 0,
    totalMaxMs: 0,
    lastMs: 0,
  };
}

function aggregate(count: number, totalMs: number, maxMs: number, lastMs: number): TimingAggregate {
  return {
    count,
    totalMs: +totalMs.toFixed(4),
    averageMs: +(count > 0 ? totalMs / count : 0).toFixed(4),
    maxMs: +maxMs.toFixed(4),
    lastMs: +lastMs.toFixed(4),
  };
}

function cloneTargetContext(target: RenderTargetContext): RenderTargetContext {
  return { ...target, size: [target.size[0], target.size[1]] };
}

function safeString(gl: WebGLRenderingContext | WebGL2RenderingContext, parameter: number): string | null {
  try {
    const value = gl.getParameter(parameter);
    return typeof value === 'string' ? value : value === null || value === undefined ? null : String(value);
  } catch {
    return null;
  }
}

function safeContextAttributes(gl: WebGLRenderingContext | WebGL2RenderingContext): RenderDeviceContext['contextAttributes'] {
  try {
    const attributes = gl.getContextAttributes();
    if (attributes === null) return null;
    return {
      alpha: attributes.alpha ?? null,
      antialias: attributes.antialias ?? null,
      depth: attributes.depth ?? null,
      stencil: attributes.stencil ?? null,
    };
  } catch {
    return null;
  }
}

export class RenderTimingCollector {
  readonly enabled = PROBE_PROFILE;

  private readonly metrics = new Map<string, MetricState>();
  private readonly gpuMetrics = new Map<string, MetricState>();
  private readonly gpuSlots: GpuQuerySlot[] = [];
  private gpuContext: WebGL2TimerContext | null = null;
  private timerExtension: TimerExtension | null = null;
  private webgl2Available = false;
  private gpuStatus: GpuTimingStatus = PROBE_PROFILE ? 'renderer-unavailable' : 'profile-disabled';
  private activeGpuSlot = -1;
  private pollCursor = 0;
  private disjointEvents = 0;
  private discardedQueries = 0;
  private wasDisjoint = false;
  private lastSnapshotMs = typeof performance === 'undefined' ? 0 : performance.now();
  private renderer: WebGLRenderer | null = null;
  private deviceContext: {
    backend: 'library' | 'legacy';
    webgl: 'webgl1' | 'webgl2' | 'unknown';
    vendor: string | null;
    renderer: string | null;
    version: string | null;
    shadingLanguageVersion: string | null;
    canvasWidth: number;
    canvasHeight: number;
    drawingBufferWidth: number;
    drawingBufferHeight: number;
    dpr: number | null;
    contextAttributes: RenderDeviceContext['contextAttributes'];
  } | null = null;
  private bufferContext: RenderBufferContext | null = null;
  private terrainState = emptyTerrainState();
  private pipState = emptyPipState();

  constructor() {
    for (const name of METRIC_NAMES) {
      this.metrics.set(name, makeMetric());
      this.gpuMetrics.set(name, makeMetric());
    }
  }

  start(): number;
  start(name: string): number;
  start(name?: string): number {
    if (!this.enabled || name === undefined) return -1;
    return performance.now();
  }

  end(name: string, startedAt: number): void {
    if (!this.enabled || startedAt < 0) return;
    this.record(name, performance.now() - startedAt);
  }

  record(name: string, durationMs: number): void {
    if (!this.enabled || !Number.isFinite(durationMs) || durationMs < 0) return;
    const duration = Math.min(MAX_REPORTED_MS, durationMs);
    let metric = this.metrics.get(name);
    if (metric === undefined) {
      metric = makeMetric();
      this.metrics.set(name, metric);
    }
    metric.windowCount += 1;
    metric.windowTotalMs += duration;
    metric.windowMaxMs = Math.max(metric.windowMaxMs, duration);
    metric.totalCount += 1;
    metric.totalMs += duration;
    metric.totalMaxMs = Math.max(metric.totalMaxMs, duration);
    metric.lastMs = duration;
  }

  setTerrainState(
    resident: number,
    displayed: number,
    desired: number,
    pendingBuilds: number,
    pendingWorkerQueue: number,
    activeWorkerBuilds: number,
    coverageReady: boolean,
  ): void {
    if (!this.enabled) return;
    this.terrainState.resident = resident;
    this.terrainState.displayed = displayed;
    this.terrainState.desired = desired;
    this.terrainState.pendingBuilds = pendingBuilds;
    this.terrainState.pendingWorkerQueue = pendingWorkerQueue;
    this.terrainState.activeWorkerBuilds = activeWorkerBuilds;
    this.terrainState.coverageReady = coverageReady;
  }

  setBufferContext(buffer: RenderBufferContext | null): void {
    if (!this.enabled) return;
    this.bufferContext = buffer;
  }

  /** Call with rendered=false at callback entry, and true only after both PiP draws complete. */
  setPipState(visible: boolean, rendered = false): void {
    if (!this.enabled) return;
    this.pipState.visible = visible;
    this.pipState.renderedLastFrame = rendered;
    if (rendered) {
      this.pipState.renderCount += 1;
      this.pipState.renderCountCumulative += 1;
    }
  }

  updateRendererContext(renderer: WebGLRenderer, backend: 'library' | 'legacy', dpr: number | null): void {
    if (!this.enabled) return;
    const gl = renderer.getContext();
    if (this.renderer !== renderer) {
      this.releaseGpuQueries();
      this.renderer = renderer;
      this.deviceContext = null;
      this.configureGpuContext(gl);
    }
    const isWebGL2 = this.webgl2Available;
    if (this.deviceContext === null) {
      const gpuInfo = gl.getExtension('WEBGL_debug_renderer_info');
      this.deviceContext = {
        backend,
        webgl: isWebGL2 ? 'webgl2' : typeof gl.getParameter === 'function' ? 'webgl1' : 'unknown',
        vendor: safeString(gl, gpuInfo?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR),
        renderer: safeString(gl, gpuInfo?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
        version: safeString(gl, gl.VERSION),
        shadingLanguageVersion: safeString(gl, gl.SHADING_LANGUAGE_VERSION),
        canvasWidth: renderer.domElement.width,
        canvasHeight: renderer.domElement.height,
        drawingBufferWidth: gl.drawingBufferWidth,
        drawingBufferHeight: gl.drawingBufferHeight,
        dpr,
        contextAttributes: safeContextAttributes(gl),
      };
    } else {
      this.deviceContext.backend = backend;
      this.deviceContext.canvasWidth = renderer.domElement.width;
      this.deviceContext.canvasHeight = renderer.domElement.height;
      this.deviceContext.drawingBufferWidth = gl.drawingBufferWidth;
      this.deviceContext.drawingBufferHeight = gl.drawingBufferHeight;
      this.deviceContext.dpr = dpr;
    }
  }

  beginFrame(): void {
    if (!this.enabled) return;
    this.pollGpuQueries();
  }

  /**
   * Begins one outer render-pass query (composer or the later PiP). The integer
   * token prevents nested queries; -1 means the pass is CPU-only for this frame.
   */
  beginGpu(name: string): number {
    if (!this.enabled || this.gpuStatus !== 'supported' || this.gpuContext === null || this.timerExtension === null || this.activeGpuSlot >= 0) return -1;
    const slotIndex = this.gpuSlots.findIndex(slot => slot.state === 'free' && slot.query !== null);
    if (slotIndex < 0) return -1;
    const slot = this.gpuSlots[slotIndex]!;
    const query = slot.query;
    if (query === null) return -1;
    try {
      this.gpuContext.beginQuery(this.timerExtension.TIME_ELAPSED_EXT, query);
      slot.state = 'active';
      slot.name = name;
      slot.discard = false;
      this.activeGpuSlot = slotIndex;
      return slotIndex;
    } catch {
      slot.state = 'free';
      slot.name = '';
      this.gpuStatus = 'query-error';
      return -1;
    }
  }

  endGpu(slotIndex: number): void {
    if (slotIndex < 0 || slotIndex !== this.activeGpuSlot || this.gpuContext === null || this.timerExtension === null) return;
    const slot = this.gpuSlots[slotIndex];
    this.activeGpuSlot = -1;
    if (slot === undefined || slot.state !== 'active') return;
    try {
      this.gpuContext.endQuery(this.timerExtension.TIME_ELAPSED_EXT);
      slot.state = 'pending';
    } catch {
      slot.state = 'free';
      slot.name = '';
      this.gpuStatus = 'query-error';
    }
  }

  snapshot(): RenderTimingSnapshot {
    if (!this.enabled) {
      return {
        enabled: false,
        intervalMs: 0,
        cpu: {},
        cpuCumulative: {},
        gpu: { status: 'profile-disabled', pendingQueries: 0, disjointEvents: 0, discardedQueries: 0, timings: {}, cumulative: {} },
        context: null,
        terrain: emptyTerrainState(),
        pip: emptyPipState(),
      };
    }
    this.pollGpuQueries();
    const now = performance.now();
    const intervalMs = Math.max(0, now - this.lastSnapshotMs);
    this.lastSnapshotMs = now;
    const cpu = this.copyAndReset(this.metrics);
    const cpuCumulative = this.copyCumulative(this.metrics);
    const timings = this.copyAndReset(this.gpuMetrics);
    const cumulative = this.copyCumulative(this.gpuMetrics);
    const pip = { ...this.pipState };
    this.pipState.renderCount = 0;
    return {
      enabled: true,
      intervalMs: +intervalMs.toFixed(1),
      cpu,
      cpuCumulative,
      gpu: {
        status: this.gpuStatus,
        pendingQueries: this.gpuSlots.filter(slot => slot.state !== 'free').length,
        disjointEvents: this.disjointEvents,
        discardedQueries: this.discardedQueries,
        timings,
        cumulative,
      },
      context: this.copyDeviceContext(),
      terrain: { ...this.terrainState },
      pip,
    };
  }

  detachRenderer(renderer: WebGLRenderer): void {
    if (!this.enabled || this.renderer !== renderer) return;
    this.releaseGpuQueries();
    this.renderer = null;
    this.gpuContext = null;
    this.timerExtension = null;
    this.webgl2Available = false;
    this.gpuStatus = 'renderer-unavailable';
    this.deviceContext = null;
    this.bufferContext = null;
  }

  private copyAndReset(metrics: Map<string, MetricState>): Record<string, TimingAggregate> {
    const output: Record<string, TimingAggregate> = {};
    for (const [name, metric] of metrics) {
      output[name] = aggregate(metric.windowCount, metric.windowTotalMs, metric.windowMaxMs, metric.lastMs);
      metric.windowCount = 0;
      metric.windowTotalMs = 0;
      metric.windowMaxMs = 0;
    }
    return output;
  }

  private copyCumulative(metrics: Map<string, MetricState>): Record<string, TimingAggregate> {
    const output: Record<string, TimingAggregate> = {};
    for (const [name, metric] of metrics) output[name] = aggregate(metric.totalCount, metric.totalMs, metric.totalMaxMs, metric.lastMs);
    return output;
  }

  private copyDeviceContext(): RenderDeviceContext | null {
    const context = this.deviceContext;
    if (context === null) return null;
    return {
      backend: context.backend,
      webgl: context.webgl,
      vendor: context.vendor,
      renderer: context.renderer,
      version: context.version,
      shadingLanguageVersion: context.shadingLanguageVersion,
      canvas: [context.canvasWidth, context.canvasHeight],
      drawingBuffer: [context.drawingBufferWidth, context.drawingBufferHeight],
      dpr: context.dpr,
      contextAttributes: context.contextAttributes === null ? null : { ...context.contextAttributes },
      buffer: this.bufferContext === null ? null : {
        owner: this.bufferContext.owner,
        input: this.bufferContext.input === undefined ? undefined : cloneTargetContext(this.bufferContext.input),
        output: this.bufferContext.output === undefined ? undefined : cloneTargetContext(this.bufferContext.output),
      },
    };
  }

  private configureGpuContext(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.gpuContext = null;
    this.timerExtension = null;
    this.webgl2Available = false;
    this.gpuStatus = 'webgl2-required';
    const possibleWebGL2 = gl as unknown as Partial<WebGL2TimerContext>;
    if (typeof possibleWebGL2.createQuery !== 'function'
      || typeof possibleWebGL2.beginQuery !== 'function'
      || typeof possibleWebGL2.endQuery !== 'function'
      || typeof possibleWebGL2.getQueryParameter !== 'function') return;
    this.webgl2Available = true;
    this.gpuContext = possibleWebGL2 as WebGL2TimerContext;
    const extension = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null;
    if (extension === null) {
      this.gpuContext = null;
      this.gpuStatus = 'extension-unavailable';
      return;
    }
    this.timerExtension = extension;
    for (let index = 0; index < MAX_GPU_QUERIES; index += 1) {
      const query = this.gpuContext.createQuery();
      if (query === null) {
        this.releaseGpuQueries();
        this.gpuContext = null;
        this.timerExtension = null;
        this.gpuStatus = 'query-allocation-failed';
        return;
      }
      this.gpuSlots.push({ query, state: 'free', name: '', discard: false });
    }
    this.gpuStatus = 'supported';
  }

  private pollGpuQueries(): void {
    if (!this.enabled || this.gpuStatus !== 'supported' || this.gpuContext === null || this.timerExtension === null || this.gpuSlots.length === 0) return;
    const startedAt = this.start('profiling.gpuPollCpuWall');
    try {
      let disjoint = false;
      try {
        disjoint = this.gpuContext === null ? false : Boolean((this.renderer?.getContext() as WebGL2RenderingContext).getParameter(this.timerExtension.GPU_DISJOINT_EXT));
      } catch {
        this.gpuStatus = 'query-error';
        return;
      }
      if (disjoint && !this.wasDisjoint) this.disjointEvents += 1;
      this.wasDisjoint = disjoint;
      if (disjoint) for (const slot of this.gpuSlots) if (slot.state !== 'free') slot.discard = true;
      const count = this.gpuSlots.length;
      for (let visited = 0; visited < Math.min(GPU_POLL_BUDGET, count); visited += 1) {
        const index = (this.pollCursor + visited) % count;
        const slot = this.gpuSlots[index]!;
        if (slot.state !== 'pending') continue;
        if (slot.query === null) { slot.state = 'free'; continue; }
        let available = false;
        try {
          available = Boolean(this.gpuContext.getQueryParameter(slot.query, this.gpuContext.QUERY_RESULT_AVAILABLE));
        } catch {
          this.gpuStatus = 'query-error';
          continue;
        }
        if (!available) continue;
        if (disjoint || slot.discard) {
          this.discardedQueries += 1;
          this.recycleGpuSlot(slot);
          continue;
        }
        try {
          const nanoseconds = Number(this.gpuContext.getQueryParameter(slot.query, this.gpuContext.QUERY_RESULT));
          if (Number.isFinite(nanoseconds) && nanoseconds >= 0) this.recordGpu(slot.name, Math.min(MAX_REPORTED_MS, nanoseconds / 1_000_000));
        } catch {
          // A result that became invalid is simply omitted from the aggregate.
        }
        this.recycleGpuSlot(slot);
      }
      this.pollCursor = (this.pollCursor + Math.min(GPU_POLL_BUDGET, count)) % count;
    } finally {
      this.end('profiling.gpuPollCpuWall', startedAt);
    }
  }

  private recordGpu(name: string, durationMs: number): void {
    let metric = this.gpuMetrics.get(name);
    if (metric === undefined) {
      metric = makeMetric();
      this.gpuMetrics.set(name, metric);
    }
    metric.windowCount += 1;
    metric.windowTotalMs += durationMs;
    metric.windowMaxMs = Math.max(metric.windowMaxMs, durationMs);
    metric.totalCount += 1;
    metric.totalMs += durationMs;
    metric.totalMaxMs = Math.max(metric.totalMaxMs, durationMs);
    metric.lastMs = durationMs;
  }

  private recycleGpuSlot(slot: GpuQuerySlot): void {
    // Completed query objects can be reused; profiling must not churn GPU objects.
    slot.state = 'free';
    slot.name = '';
    slot.discard = false;
  }

  private releaseGpuQueries(): void {
    if (this.gpuContext !== null) {
      for (const slot of this.gpuSlots) {
        if (slot.query !== null) {
          try { this.gpuContext.deleteQuery(slot.query); } catch { /* Context loss cleanup is best effort. */ }
        }
      }
    }
    this.gpuSlots.length = 0;
    this.activeGpuSlot = -1;
    this.pollCursor = 0;
    this.wasDisjoint = false;
  }
}

export const renderTimings = new RenderTimingCollector();

export type ComposerPassTimingSpec = readonly [pass: Pass, name: string];

/** Wraps only composer-owned outer passes; nested pass queries are never installed. */
export function installComposerPassTimings(
  composer: EffectComposer,
  timing: RenderTimingCollector,
  specs: readonly ComposerPassTimingSpec[],
): () => void {
  if (!timing.enabled) return () => undefined;
  const restorations: Array<{ pass: Pass; render: Pass['render'] }> = [];
  for (const [pass, name] of specs) {
    if (!composer.passes.includes(pass)) continue;
    const original = pass.render;
    restorations.push({ pass, render: original });
    pass.render = function wrappedRender(renderer, inputBuffer, outputBuffer, deltaTime, stencilTest) {
      const cpuStartedAt = timing.start(name);
      const gpuSlot = timing.beginGpu(name);
      try {
        return original.call(this, renderer, inputBuffer, outputBuffer, deltaTime, stencilTest);
      } finally {
        timing.endGpu(gpuSlot);
        timing.end(name, cpuStartedAt);
      }
    };
  }
  return () => {
    for (const { pass, render } of restorations) pass.render = render;
  };
}
