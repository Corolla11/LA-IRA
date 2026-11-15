/*
 * config.js - shared constants and default assumptions (no logic, no imports).
 * Used by: terrain.js, route.js, candidates.js, map.js, ui.js, main.js. Per-body values (radius, dose,
 * habitat, targets, v0) live in app/bodies/<id>.json and the package meta.json.
 */
export const DI = [1, 1, 0, -1, -1, -1, 0, 1];
export const DJ = [0, 1, 1, 1, 0, -1, -1, -1];
export const TOBLER_MAX = Math.exp(0.175);   // maximum speed ratio (descent of ~3°)
export const MAX_STOPS = 6;
export const RM = 250;                       // side of the radiation grid
export const DEFAULT_PARAMS = { v0: 1.5, maxSlope: 25, maxCross: 20, sand: 1.5, eva: 6, reserve: 30, work: 20, carry: false, optimize: true, algorithm: 'astar' };
export const CRISM_LEGEND = {
  hyd: 'Red: polyhydrated sulfate (SINDEX2). Green: monohydrated sulfate (BD2100). Blue: hydration (BD1900).',
  phy: 'Red: Fe/Mg clays (D2300). Green: Al clays or hydrated silica (D2200). Blue: hydration (BD1900R2).',
  car: 'Red: Fe/Mg-OH (D2300). Green: carbonate (BD2500). Blue: hydration (BD1900). Almost no signal here.',
  tru: 'Approximate visible color, to compare alignment with HiRISE.'
};
