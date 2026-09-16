# Codebase map — 2026-09-16

Rough map of the current primary checkout. Solid arrows show existing ownership/data paths; dashed arrows show unfinished integration or port work. No release or whole-system acceptance is implied.

**Status:** 🟢 **Done** · 🟡 **In progress** · 🔴 **TBC**

Colors apply to the scope named in each box. Green rendering means the existing Takram baseline; its Volumetric Weather replacement is yellow. Runpod execution and remote evidence remain TBC; the local Monte Carlo runners are complete.

The red MATLAB / SIL / HWIL integration block reuses the green simulation, telemetry and offline MATLAB model. It groups the shared live interface, software/hardware adapters and synchronized comparison mode; implementation has not started. The green MATLAB box covers the verified offline model only.

```mermaid
---
config:
  layout: dagre
  theme: base
  fontFamily: "Arial, sans-serif"
  themeCSS: ".label { font-family: Arial, sans-serif; } .edgeLabel span, .edgeLabel p { color: #b7c6d9 !important; } .node rect { rx: 8; ry: 8; }"
  themeVariables:
    fontSize: "16px"
    lineColor: "#8a9aaf"
    textColor: "#e7e9ee"
    edgeLabelBackground: "#10151e"
    clusterBkg: "#0d121b"
    clusterBorder: "#2a3443"
    primaryTextColor: "#e7e9ee"
    secondaryTextColor: "#e7e9ee"
    tertiaryTextColor: "#e7e9ee"
    titleColor: "#b7c6d9"
  flowchart:
    nodeSpacing: 28
    rankSpacing: 46
    padding: 20
    curve: linear
---
flowchart TB
    accTitle: Docking simulator architecture and development status
    accDescr: A vertical flow connects the application, simulation, presentation, and verification systems. Green is done, yellow is in progress, red is TBC. Solid arrows are existing paths; dashed arrows are unfinished integrations.
        UI["React app · apps/web<br/>Mission, sandbox, flight, analysis"]
        LAUNCH["Rocket builder + launch<br/>Implementation starting"]
        SESS["Sessions + input<br/>Pacing, pause, commands, restart"]

        SCEN["Scenario package<br/>Mission rules, faults, outcomes"]
        CORE["Simulation core<br/>6-DOF, sensors, navigation,<br/>guidance, controllers, thrusters"]
        TEL["Telemetry + render state"]

        HUD["HUD, instruments,<br/>mission feedback"]
        LAB["GNC lab · integration in progress<br/>Signal diagram, inspector,<br/>plots, fault controls"]
        RENDER["Three.js renderer<br/>Craft, Earth, terrain,<br/>atmosphere, clouds"]
        PORT["Volumetric Weather · in progress<br/>Shaders, precompute tables,<br/>cloud profiles"]

        REMOTE["Runpod execution + evidence<br/>Remote workflow unfinished"]
        MC["Monte Carlo runners<br/>Seeded cases, parallel workers, reports"]
        MATLAB["MATLAB / Simulink<br/>Verified native plant<br/>+ separate LQR analysis"]
        INTEGRATION["MATLAB / SIL / HWIL<br/>integration · TBC<br/>Shared live interface<br/>+ software/hardware adapters<br/>Synchronized twin comparison"]

    UI --> SESS
    SESS --> SCEN
    SESS --> CORE
    SCEN --> CORE
    CORE --> TEL
    TEL --> HUD
    TEL --> RENDER
    TEL --> LAB
    LAB -. "app route pending" .-> UI
    PORT -. "replacement integration pending" .-> RENDER
    MC --> CORE
    MC --> SCEN
    REMOTE -. "distributed runs" .-> MC
    CORE <-->|"offline fixtures and comparison"| MATLAB
    LAUNCH -.-> SESS
    SESS -. "live sensor exchange" .-> INTEGRATION
    CORE -. "comparison inputs/state" .-> INTEGRATION
    MATLAB -. "reference model / future software controller" .-> INTEGRATION
    INTEGRATION -. "controller commands" .-> SESS
    INTEGRATION -. "comparison results" .-> LAB

    classDef done fill:#14532d,stroke:#4ade80,color:#f0fdf4,stroke-width:2px;
    classDef inProgress fill:#713f12,stroke:#facc15,color:#fefce8,stroke-width:2px;
    classDef tbc fill:#7f1d1d,stroke:#f87171,color:#fef2f2,stroke-width:2px;
    class UI,SESS,SCEN,CORE,TEL,HUD,RENDER,MC,MATLAB done;
    class LAB,PORT,LAUNCH inProgress;
    class REMOTE,INTEGRATION tbc;
```

## Responsibilities

| Area | Main location | Boundary |
| --- | --- | --- |
| Application and mode ownership | `apps/web/src/App.tsx`, `appModeStore.ts` | Current routes select SANDBOX, MISSION, ANALYSIS or FLIGHT; GNC and launch routes are unfinished. |
| Simulation and flight software | `packages/sim-core/src` | Pure TypeScript with no renderer dependency. FSW consumes sensor data, not privileged truth. Orbital truth runs at 100 Hz, FSW at 10 Hz and MPC at 1 Hz. |
| Mission logic | `packages/scenario/src` | Commands/fault injection through public simulation APIs; mission rules do not read private truth. |
| Session/telemetry bridge | `apps/web/src/telemetry`, `flight`, `gncLab/session` | Each active mode owns its clock/session and publishes state for presentation. Aircraft physics is separate from orbital FSW. |
| Rendering | `apps/web/src/scene` | Three.js owns the visible world. The Takram baseline still runs; Volumetric Weather is being built and verified before replacement. |
| GNC instrumentation | `apps/web/src/gncLab` | Traces/graph/session are implemented; inspector integration approved, plots/fault controls and mounted entry remain in progress. |
| Monte Carlo | `packages/scenario`, `apps/web/src/analysis`, `gncLab/mc`, `tools/gnc-mc-infra` | Browser analysis and headless campaign work exist; remote Runpod orchestration/evidence completion is separate. |
| MATLAB companion | `tools/matlab-port` | Native plant, executable Simulink pulse experiments and separate LQR analysis were executed and verified. Full sensors/FSW and a live SIL link are not included in that result. |
| MATLAB / SIL / HWIL integration | Planned: `apps/web/src/gncLab/sil`, `tools/gnc-bridge`; later hardware-specific adapter | Share signal definitions, run identity, clock ownership, command validation and evidence logging. SIL connects a software controller; HWIL supplies a hardware adapter, target GNC software and suitable timing host. Twin comparison is an optional synchronized reference/analysis mode within this integration. Live implementation and hardware verification are TBC; the browser/local bridge alone is not a hard-real-time host. |

The core feedback loop is **dynamics → simulated sensors → navigation estimate → guidance/control → thruster allocation → actual forces and torques → dynamics**. Rendering observes the result and does not provide physical feedback.

Within the external integration, **SIL and HWIL select where the controller executes; twin mode selects whether a second model runs for comparison**. Reuse the interface and evidence machinery across these options. Privileged comparison truth goes to the reference/analysis path, not to the controller's sensor input.

Reference: `docs/ARCHI.md`, current `App.tsx`, F015/F016/F019/F020 plans and `tools/matlab-port/VERIFICATION.md`. Dashed features must not be presented as already running.
