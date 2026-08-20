/**
 * LOAD (~12-row) animations: continuous 3D light fields and the sparse
 * dot-chain, for cold start / long tool waits / provider waits — phases with
 * NO active token stream. While tokens are painting, the LINE animation owns
 * the row budget and these must not render (handoff §0.1/§0.6).
 *
 * Every field cell is a sample of a continuous function — no sparse point
 * clouds with holes. Light is the cool white/cyan ramp from cells.ts; crest
 * spec warmth is a tint, never rainbow. All noise is tick-derived: no
 * Math.random anywhere, so a frame is a pure function of (tick, width).
 *
 * Formulas follow the animation handoff §4 verbatim.
 */
import type { AnimFactory, AnimInstance, Cell, Frame } from "./types.js";
import { LOAD_HEIGHT } from "./types.js";
import { clamp01, emptyFrame, light, shade } from "./cells.js";

/** A field sample: luminance 0–1 plus an optional warm-tint amount 0–1. */
interface Lum {
  lum: number;
  warm?: number;
}

/**
 * Shared field sampler (handoff §4.1): maps each cell to normalised coords
 * (nx aspect-corrected, ny in [-1,1]), samples, shades, colours.
 */
function lumField(
  w: number,
  h: number,
  sample: (nx: number, ny: number) => Lum,
): Frame {
  const rows: Frame = [];
  const ax = 1 / Math.max(1, w - 1);
  const ay = 1 / Math.max(1, h - 1);
  for (let y = 0; y < h; y++) {
    const ny = y * ay * 2 - 1;
    const row: Cell[] = [];
    for (let x = 0; x < w; x++) {
      const nx = (x * ax * 2 - 1) * (w / Math.max(h * 2.1, 1)); // aspect
      const s = sample(nx, ny);
      const lum = clamp01(s.lum);
      const [r, g, b] = light(lum, s.warm ?? 0);
      row.push({ ch: shade(lum), r, g, b, bold: lum > 0.78 });
    }
    rows.push(row);
  }
  return rows;
}

/** Perspective sheet mapping (handoff §4.1) used by the floor-style fields. */
function sheet(nx: number, ny: number): { v: number; z: number; x: number; zz: number; fog: number } {
  const v = (ny + 1) * 0.5; // 0 top → 1 bottom
  const z = 0.45 + v * 3.0; // depth
  const x = nx * z * 0.9; // world x
  return { v, z, x, zz: z - 2.0, fog: 0.2 + v * 0.8 }; // near brighter
}

/** Slope lighting helper (handoff §4.1): spec highlight from finite slopes. */
function specFrom(dhx: number, dhz: number): number {
  const nx = -dhx;
  const ny = 1;
  const nz = -dhz;
  const inv = 1 / Math.hypot(nx, ny, nz);
  return clamp01(nx * inv * 0.35 + ny * inv * 0.78 + nz * inv * -0.4);
}

/** Inverse of lumField's coordinate mapping: normalised → cell indices. */
function toCell(nx: number, ny: number, w: number, h: number): [number, number] {
  const cx = Math.round((((nx / (w / Math.max(h * 2.1, 1))) + 1) / 2) * (w - 1));
  const cy = Math.round(((ny + 1) / 2) * (h - 1));
  return [cx, cy];
}

/** Plot a bright bead over a field (deterministic seeds only). */
function plotBead(rows: Frame, w: number, h: number, nx: number, ny: number, ch: string, lum: number): void {
  const [cx, cy] = toCell(nx, ny, w, h);
  if (cx < 0 || cy < 0 || cx >= w || cy >= h) return;
  const [r, g, b] = light(lum);
  rows[cy][cx] = { ch, r, g, b, bold: lum > 0.78 };
}

// ---------------------------------------------------------------------------
// Field pattern factories. Each returns the handoff §4 AnimFactory shape.
// ---------------------------------------------------------------------------

const circularRipple: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const { x, zz, fog } = sheet(nx, ny);
      const rho = Math.hypot(x, zz);
      const wave = Math.sin(rho * 4.2 - t) * Math.exp(-rho * 0.28);
      const wave2 = Math.sin((rho + 0.06) * 4.2 - t) * Math.exp(-rho * 0.28);
      const spec = specFrom(wave2 - wave, 0.03);
      return { lum: clamp01((0.16 + wave * 0.7 + spec * 0.55) * fog), warm: spec * 0.6 };
    }),
});

const circular3d: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const { x, zz, fog } = sheet(nx, ny);
      const rho = Math.hypot(x, zz);
      const e = Math.sin(rho * 3.6 - t) * Math.exp(-rho * 0.18);
      const ring = Math.pow(Math.max(0, Math.cos(rho * 3.6 - t)), 6) * Math.exp(-rho * 0.15);
      const wave2 = Math.sin((rho + 0.06) * 3.6 - t) * Math.exp(-rho * 0.18);
      const spec = specFrom(wave2 - e, 0.03);
      return { lum: clamp01((0.14 + e * 0.45 + ring * 0.85 + spec * 0.35) * fog), warm: Math.min(ring, 1) * 0.5 };
    }),
});

const sineSheet: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const { x, z, fog } = sheet(nx, ny);
      const e = 0.42 * Math.sin(x * 2.2 - t) * Math.cos(z * 1.1 + t * 0.4);
      return { lum: clamp01((0.18 + e * 0.65) * fog), warm: Math.max(0, e) * 0.4 };
    }),
});

const sineRibbon: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const y0 = 0.42 * Math.sin(nx * 3.2 - t);
      const y1 = 0.18 * Math.sin(nx * 6.4 - t * 1.7);
      const d = Math.abs(ny - (y0 + y1));
      return { lum: clamp01(Math.exp(-d * d * 42) + Math.exp(-d * d * 8) * 0.35) };
    }),
});

const beatSines: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const a = 0.38 * Math.sin(nx * 2.6 - t);
      const b = 0.38 * Math.sin(nx * 3.05 - t * 1.04);
      const da = ny - a;
      const db = ny - b;
      return { lum: clamp01(Math.exp(-da * da * 28) + 0.85 * Math.exp(-db * db * 28)) };
    }),
});

function sourceSum(centers: [number, number][], freq: number, amp: number): AnimFactory {
  return () => ({
    render: (f, w) =>
      lumField(w, LOAD_HEIGHT, (nx, ny) => {
        const t = f * 0.11;
        const { x, zz, fog } = sheet(nx, ny);
        let e = 0;
        centers.forEach(([cx, cz], i) => {
          const r = Math.hypot(x - cx, zz - cz);
          e += Math.sin(r * freq - t * (1 - i * 0.06)) * Math.exp(-r * 0.22) * amp;
        });
        return { lum: clamp01((0.14 + e * 1.1) * fog), warm: Math.max(0, e) * 0.3 };
      }),
  });
}

const twinRipple: AnimFactory = sourceSum([[0.55, 0], [-0.55, 0]], 3.8, 0.38);
const tripleSource: AnimFactory = sourceSum([[0.55, 0.3], [-0.55, 0.25], [0, -0.35]], 3.6, 0.28);

const sphericalPulse: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const R = ((t * 0.35) % 1.6) + 0.15;
      const rho = Math.hypot(nx * 1.05, ny * 0.95);
      const dr = rho - R;
      return { lum: clamp01(Math.exp(-dr * dr * 28) + Math.exp(-rho) * 0.08) };
    }),
});

const volumeShells: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const rho = Math.hypot(nx * 1.05, ny * 0.95);
      let lum = 0;
      for (let k = 0; k < 4; k++) {
        const Rk = (((t * 0.35) + k * 0.4) % 1.6) + 0.15;
        const dr = rho - Rk;
        lum += Math.exp(-dr * dr * 22) * (1 - k * 0.18);
      }
      return { lum: clamp01(lum) };
    }),
});

const radialBloom: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const rho = Math.hypot(nx * 1.15, ny);
      const rings = 0.5 + 0.5 * Math.cos(rho * 7 - t);
      const glow = Math.exp(-rho * 1.1);
      return { lum: clamp01(Math.pow(rings, 3) * glow * 1.4 + glow * 0.18) };
    }),
});

const besselDrum: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const { x, z, fog } = sheet(nx, ny);
      const rho = Math.hypot(x, z - 2) * 3.4 + 1e-3;
      const j0 = Math.sin(rho) / rho;
      const e = j0 * Math.cos(rho - t) * 1.6;
      return { lum: clamp01((0.18 + e * 0.5) * fog) };
    }),
});

const standingMembrane: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const { x, z, fog } = sheet(nx, ny);
      const e = Math.sin(x * 2.6) * Math.sin(z * 2.1) * Math.cos(t * 1.15);
      return { lum: clamp01((0.18 + e * 0.62) * fog), warm: Math.max(0, e) * 0.3 };
    }),
});

const wavePacket: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const { x, fog } = sheet(nx, ny);
      const c = ((t * 0.45) % 4.2) - 2.1;
      const dx = x - c;
      const env = Math.exp(-dx * dx * 1.6);
      const e = env * Math.sin(dx * 6 - t * 2);
      return { lum: clamp01((0.14 + env * 0.35 + e * 0.45) * fog) };
    }),
});

const soliton: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const c = ((t * 0.5) % 3.6) - 1.8;
      const sech = 1 / Math.cosh((nx - c) * 3.4);
      const y0 = 0.55 * sech * sech;
      const d = Math.abs(ny - y0);
      return { lum: clamp01(Math.exp(-d * d * 90) + Math.exp(-d * d * 20) * 0.3) };
    }),
});

const spiralLight: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const rho = Math.hypot(nx * 1.15, ny) + 1e-4;
      const th = Math.atan2(ny, nx);
      const arm = Math.cos(th * 2 - rho * 5 + t * 1.4);
      return { lum: clamp01(Math.exp(-rho * 0.55) * (0.2 + Math.pow(Math.max(0, arm), 2) * 1.2)) };
    }),
});

const lightTunnel: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const rho = Math.hypot(nx * 1.05, ny * 0.95) + 0.04;
      const zInv = 1 / rho;
      const rings = 0.5 + 0.5 * Math.cos(zInv * 2.8 - t * 2.2);
      return { lum: clamp01(Math.pow(rings, 2.4) * Math.exp(-rho * 0.35) + Math.exp(-rho * 6) * 0.35) };
    }),
});

const sineTunnel: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const rho = Math.hypot(nx * 1.05, ny * 0.95);
      const wall = Math.exp(-((rho - 0.62) ** 2) * 18);
      const travel = 0.5 + 0.5 * Math.sin(nx * 4 - t * 2.1);
      return { lum: clamp01(wall * (0.25 + travel * 0.75) + Math.exp(-((rho - 0.62) ** 2) * 60) * travel) };
    }),
});

const causticFloor: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const { x, z, fog } = sheet(nx, ny);
      const e = Math.sin(x * 2.1 + t) * Math.cos(z * 1.7 - t * 0.6)
        + 0.45 * Math.sin(x * 3.8 - z * 1.2 + t * 1.3);
      const focus = Math.pow(Math.max(0, e), 2.2);
      return { lum: clamp01((0.08 + focus * 0.9) * fog), warm: focus * 0.7 };
    }),
});

const auroraWave: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const curtain = 0.5 + 0.5 * Math.sin(nx * 2.4 + Math.sin(ny * 2.2 + t) + t * 0.7);
      const height = Math.exp(-((ny + 0.15) ** 2) * 1.6);
      return { lum: clamp01(Math.pow(curtain, 2) * height) };
    }),
});

const heartbeatSphere: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      // Mechanical breathing shell. The name is a shape descriptor only —
      // this is NOT bound to any "the model is thinking" vital-sign story.
      const breath = 0.55 + 0.22 * Math.sin(t * 1.1);
      const rho = Math.hypot(nx * 1.05, ny * 0.92);
      const surf = Math.exp(-((rho - breath) ** 2) * 40);
      const fill = rho < breath ? (0.12 + 0.18 * Math.sin(rho * 12 - t * 2)) * (1 - rho / breath) : 0;
      return { lum: clamp01(surf + Math.max(0, fill)) };
    }),
});

const dopplerWake: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const { x, zz, fog } = sheet(nx, ny);
      const cx = Math.sin(t * 0.45) * 0.9;
      const rho = Math.hypot(x - cx, zz);
      const e = Math.sin(rho * 5.2 - t * 1.6) * Math.exp(-rho * 0.45);
      return { lum: clamp01((0.14 + e * 0.72) * fog) };
    }),
});

const fiberPulse: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const y0 = 0.38 * Math.sin(nx * 2.2);
      const head = ((t * 0.35) % 2) - 1;
      const fiber = Math.exp(-(Math.abs(ny - y0) ** 2) * 30);
      const pulse = Math.exp(-((nx - head) ** 2) * 18);
      return { lum: clamp01(fiber * 0.3 + fiber * pulse) };
    }),
});

const phasedPlane: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const { x, z, fog } = sheet(nx, ny);
      const e = Math.sin(z * 3.4 - t * 1.8 + x * 0.15);
      return { lum: clamp01((0.16 + e * 0.6) * fog) };
    }),
});

const cardioidLamp: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const th = Math.atan2(ny, nx);
      const rho = Math.hypot(nx * 1.1, ny);
      const cardio = 0.5 * (1 - Math.cos(th - t * 0.4));
      const beam = Math.exp(-((rho - cardio * 1.1) ** 2) * 10);
      return { lum: clamp01(beam * (0.3 + cardio) + 0.1 * Math.exp(-rho * 2)), warm: beam * cardio * 0.5 };
    }),
});

const dishRipple: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const rho = Math.hypot(nx * 1.1, ny);
      const dish = -0.18 * rho * rho;
      const wave = 0.22 * Math.sin(rho * 5.5 - t);
      const e = dish + wave;
      return { lum: clamp01(0.2 + e * 1.4), warm: Math.max(0, wave) * 0.5 };
    }),
});

const latticeWave: AnimFactory = () => ({
  render: (f, w) =>
    lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const t = f * 0.11;
      const { x, z, fog } = sheet(nx, ny);
      const e = Math.sin(x * 2.2 + t) * Math.cos(z * 2.0 - t * 0.7) * Math.sin((x + z) * 0.8 + t * 0.5);
      return { lum: clamp01((0.18 + e * 0.62) * fog) };
    }),
});

// X. particle-flow / particle-orbit — motes over a continuous field.
const particleFlow: AnimFactory = () => ({
  render: (f, w) => {
    const t = f * 0.11;
    const ridge = (nx: number) => 0.38 * Math.sin(nx * 2.2);
    const frame = lumField(w, LOAD_HEIGHT, (nx, ny) => ({
      lum: clamp01(Math.exp(-((ny - ridge(nx)) ** 2) * 24) * 0.35),
    }));
    for (let i = 0; i < 90; i++) {
      const nx = ((i / 90 + t * 0.06) % 1) * 2 - 1;
      plotBead(frame, w, LOAD_HEIGHT, nx, ridge(nx), i % 9 === 0 ? "●" : "·", 1);
    }
    return frame;
  },
});

const particleOrbit: AnimFactory = () => ({
  render: (f, w) => {
    const t = f * 0.11;
    const frame = lumField(w, LOAD_HEIGHT, (nx, ny) => {
      const rho = Math.hypot(nx * 1.1, ny * 0.95);
      return { lum: clamp01(Math.exp(-((rho - 0.62) ** 2) * 30) * 0.25) };
    });
    const radii = [0.38, 0.62, 0.86];
    for (let i = 0; i < 64; i++) {
      const r = radii[i % 3];
      const dir = i % 2 === 0 ? 1 : -1;
      const th = (i / 64) * Math.PI * 2 + t * dir * 0.45 * (1.25 - r);
      plotBead(frame, w, LOAD_HEIGHT, Math.cos(th) * r, Math.sin(th) * r * 0.9, i % 16 === 0 ? "●" : "·", 1);
    }
    return frame;
  },
});

// ---------------------------------------------------------------------------
// Dot-chain (handoff §4.3): one object, sparse, continuous motion — the
// cheap default loader when full fields are too heavy.
// ---------------------------------------------------------------------------

/** Rotate: Rx(ax) then Ry(ay). */
function rot3(x: number, y: number, z: number, ax: number, ay: number): [number, number, number] {
  const ca = Math.cos(ax);
  const sa = Math.sin(ax);
  const y1 = y * ca - z * sa;
  const z1 = y * sa + z * ca;
  const cb = Math.cos(ay);
  const sb = Math.sin(ay);
  const x2 = x * cb + z1 * sb;
  const z2 = -x * sb + z1 * cb;
  return [x2, y1, z2];
}

/** Perspective-project one bead and overwrite by z/luminance priority. */
function plotDot(
  rows: Frame,
  lumBuf: number[][],
  w: number,
  h: number,
  x: number,
  y: number,
  z: number,
  ch: string,
  lum: number,
): void {
  const zc = z + 3.05;
  if (zc < 0.45) return;
  const sx = Math.round(w * 0.5 + (x / zc) * w * 0.48);
  const sy = Math.round(h * 0.5 + (y / zc) * h * 0.7);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
  if (lum <= lumBuf[sy][sx]) return;
  lumBuf[sy][sx] = lum;
  const [r, g, b] = light(lum);
  rows[sy][sx] = { ch, r, g, b, bold: lum > 0.78 };
}

type ChainPath = (s: number, t: number) => [number, number, number];

function makeChain(path: ChainPath, beads = 22, spin = 0.028): AnimFactory {
  return () => ({
    render: (f, w) => {
      const rows = emptyFrame(w, LOAD_HEIGHT);
      const lumBuf: number[][] = Array.from({ length: LOAD_HEIGHT }, () => new Array<number>(w).fill(0));
      const t = f * 0.055;
      const head = ((f * 0.016) % 1 + 1) % 1;
      for (let i = beads - 1; i >= 0; i--) {
        const s = (head - i / beads + 2) % 1;
        const p = path(s, t);
        const [x, y, z] = rot3(p[0], p[1], p[2], 0.32, t * spin);
        const fall = 1 - i / Math.max(1, beads - 1);
        const lum = 0.16 + fall * 0.84;
        const ch = i === 0 ? "●" : fall > 0.5 ? "•" : "·";
        plotDot(rows, lumBuf, w, LOAD_HEIGHT, x, y, z, ch, lum);
      }
      return rows;
    },
  });
}

const CHAIN_PATHS: Record<string, ChainPath> = {
  sine: (s, _t) => [(s - 0.5) * 2.15, Math.sin(2 * Math.PI * s) * 0.52, Math.cos(2 * Math.PI * s) * 0.22],
  loop: (s, _t) => [Math.cos(2 * Math.PI * s) * 1.15, Math.sin(2 * Math.PI * s) * 0.58, Math.sin(4 * Math.PI * s) * 0.18],
  helix: (s, _t) => [Math.cos(4 * Math.PI * s) * 0.72, (s - 0.5) * 1.55, Math.sin(4 * Math.PI * s) * 0.72],
  eight: (s, _t) => [Math.sin(2 * Math.PI * s) * 1.15, Math.sin(4 * Math.PI * s) * 0.5, Math.cos(2 * Math.PI * s) * 0.28],
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const LOAD_ANIMS: Record<string, AnimFactory> = {
  "circular-ripple": circularRipple,
  "circular-3d": circular3d,
  "sine-sheet": sineSheet,
  "sine-ribbon": sineRibbon,
  "beat-sines": beatSines,
  "twin-ripple": twinRipple,
  "triple-source": tripleSource,
  "spherical-pulse": sphericalPulse,
  "volume-shells": volumeShells,
  "radial-bloom": radialBloom,
  "bessel-drum": besselDrum,
  "standing-membrane": standingMembrane,
  "wave-packet": wavePacket,
  soliton: soliton,
  "spiral-light": spiralLight,
  "light-tunnel": lightTunnel,
  "sine-tunnel": sineTunnel,
  "caustic-floor": causticFloor,
  "aurora-wave": auroraWave,
  "heartbeat-sphere": heartbeatSphere,
  "doppler-wake": dopplerWake,
  "fiber-pulse": fiberPulse,
  "phased-plane": phasedPlane,
  "cardioid-lamp": cardioidLamp,
  "dish-ripple": dishRipple,
  "lattice-wave": latticeWave,
  "particle-flow": particleFlow,
  "particle-orbit": particleOrbit,
  "dot-chain-sine": makeChain(CHAIN_PATHS.sine),
  "dot-chain-loop": makeChain(CHAIN_PATHS.loop),
  "dot-chain-helix": makeChain(CHAIN_PATHS.helix),
  "dot-chain-eight": makeChain(CHAIN_PATHS.eight),
};

export const LOAD_ANIM_IDS = Object.keys(LOAD_ANIMS);

/** Default cheap loader (routine waits) and default atmospheric field. */
export const DEFAULT_LOAD_ANIM = "dot-chain-sine";
export const DEFAULT_FIELD_ANIM = "circular-ripple";

export function makeLoadAnim(id: string): AnimInstance | null {
  const factory = LOAD_ANIMS[id];
  return factory ? factory() : null;
}
