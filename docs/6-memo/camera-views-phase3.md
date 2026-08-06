# Memo: Camera views for Phase 3 (user request, 2026-08-06)

Input for the Phase 3 `planning` (6-DOF + MEKF + docking camera + manual fly).

Requested view system — switchable at runtime:

1. **Cockpit FPV**: camera inside the chaser, viewport frame looking out along
   the docking axis (+ŷ), HUD and (later) switch panel composed around it.
   Attitude-coupled: the view rotates with the vehicle body (needs Phase 3
   6-DOF attitude to be meaningful).
2. **Third-person chase**: the existing cinematic view, kept and switchable
   (chase-cam variant that follows the chaser is the natural evolution).
3. **Docking camera PiP**: boresight camera with capture-envelope numbers
   (already in the Phase 3 roadmap) — available as an overlay in either view.

Notes:
- Spacecraft mass/inertia are Phase 2/3 dynamics work and independent of this;
  `prop_kg` depletion already typed in TruthState.
- View switching is rendering-side only — must stay behind the telemetry bus /
  public API seam like everything else in apps/web.
- A modeled cockpit interior (viewport frame, struts) is new asset scope on
  top of the craft glTF follow-up in `apps/web/public/assets/ASSETS.md`.
