/** Physical constants and loop rates. SI units throughout (see docs/ARCHI.md). */
export const MU_EARTH_M3_S2 = 3.986004418e14;
export const R_EARTH_M = 6.371e6;

/** Fixed-step loop rates (Hz). Truth integrates RK4; FSW runs on sensor data only. */
export const TRUTH_HZ = 100;
export const FSW_HZ = 10;
export const MPC_HZ = 1;
