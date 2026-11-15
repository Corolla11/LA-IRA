/*
 * config.js - shared constants and default assumptions (no logic, no imports).
 * Used by: terrain.js, route.js, candidates.js, map.js, ui.js, main.js.
 */
export const DOSE_RATE = 6.55;               // µGy/h, Curiosity RAD, dose E, sols 4669–4673
export const RAD_POINT = { lat: -4.8082, lng: 137.3811 };
export const M_PER_DEG = Math.PI * 3396190 / 180;
export const DI = [1, 1, 0, -1, -1, -1, 0, 1];
export const DJ = [0, 1, 1, 1, 0, -1, -1, -1];
export const TOBLER_MAX = Math.exp(0.175);   // maximum speed ratio (descent of ~3°)
export const MAX_STOPS = 6;
export const RM = 250;                       // side of the radiation grid
export const HAB_PX = [2290, 2880];          // default habitat, HiRISE mosaic pixel
export const DEFAULT_PARAMS = { v0: 1.5, maxSlope: 25, maxCross: 20, sand: 1.5, eva: 6, reserve: 30, work: 20, carry: false, optimize: true };
export const CRISM_LEGEND = {
  hyd: 'Red: polyhydrated sulfate (SINDEX2). Green: monohydrated sulfate (BD2100). Blue: hydration (BD1900).',
  phy: 'Red: Fe/Mg clays (D2300). Green: Al clays or hydrated silica (D2200). Blue: hydration (BD1900R2).',
  car: 'Red: Fe/Mg-OH (D2300). Green: carbonate (BD2500). Blue: hydration (BD1900). Almost no signal here.',
  tru: 'Approximate visible color, to compare alignment with HiRISE.'
};
