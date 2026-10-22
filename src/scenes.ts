export type DepthRole = 'backdrop' | 'atmosphere' | 'architecture' | 'subject' | 'foreground';
export type SourceKind = 'attached' | 'demo' | 'upload';
export type Point = { x: number; y: number };
export type DepthLayer = {
  id: string;
  name: string;
  role: DepthRole;
  z: number;
  opacity: number;
  feather: number;
  points: Point[];
  full?: boolean;
  custom?: boolean;
};
export type SceneRecord = {
  id: string;
  title: string;
  subtitle: string;
  sourceName: string;
  sourceUrl: string;
  sourceKind: SourceKind;
  sourceBlob?: Blob;
  image?: HTMLImageElement;
  objectUrl?: string;
  width: number;
  height: number;
  layers: DepthLayer[];
};

export const ROLE_LABELS: Record<DepthRole, string> = {
  backdrop: 'Distant backdrop',
  atmosphere: 'Atmosphere',
  architecture: 'Architecture',
  subject: 'Subject',
  foreground: 'Foreground cutout',
};

export const ROLE_DEFAULT_Z: Record<DepthRole, number> = {
  backdrop: 0.12,
  atmosphere: 0.36,
  architecture: 0.62,
  subject: 0.94,
  foreground: 1.28,
};

const layer = (
  id: string,
  role: DepthRole,
  points: Point[] = [],
  options: Partial<DepthLayer> = {},
): DepthLayer => ({
  id,
  name: ROLE_LABELS[role],
  role,
  z: ROLE_DEFAULT_Z[role],
  opacity: role === 'backdrop' ? 0.65 : 0.96,
  feather: role === 'backdrop' ? 0 : 0.25,
  points,
  full: points.length === 0,
  ...options,
});

// These authored masks are an explicitly provisional reading of visible pixels.
// They are not automatic segmentation and do not imply unseen geometry.
export const attachedWorldLayers = (): DepthLayer[] => [
  layer('world-backdrop', 'backdrop', [], { name: 'Distant backdrop · full source', z: 0.1, opacity: 0.58, feather: 0, full: true }),
  layer('world-atmosphere', 'atmosphere', [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.405 }, { x: 0.91, y: 0.427 },
    { x: 0.84, y: 0.397 }, { x: 0.76, y: 0.432 }, { x: 0.66, y: 0.411 },
    { x: 0.58, y: 0.448 }, { x: 0.47, y: 0.414 }, { x: 0.38, y: 0.439 },
    { x: 0.26, y: 0.408 }, { x: 0.15, y: 0.441 }, { x: 0.07, y: 0.414 }, { x: 0, y: 0.44 },
  ], { name: 'Cloud vault · atmosphere', z: 0.35, opacity: 0.85, feather: 0.35 }),
  layer('world-architecture', 'architecture', [
    { x: 0, y: 0.52 }, { x: 0.06, y: 0.50 }, { x: 0.12, y: 0.56 }, { x: 0.18, y: 0.54 },
    { x: 0.24, y: 0.59 }, { x: 0.32, y: 0.57 }, { x: 0.39, y: 0.61 }, { x: 0.46, y: 0.57 },
    { x: 0.54, y: 0.62 }, { x: 0.61, y: 0.58 }, { x: 0.69, y: 0.62 }, { x: 0.76, y: 0.57 },
    { x: 0.84, y: 0.60 }, { x: 0.91, y: 0.55 }, { x: 1, y: 0.52 }, { x: 1, y: 1 }, { x: 0, y: 1 },
  ], { name: 'Breakwater & city · architecture', z: 0.62, opacity: 0.88, feather: 0.2 }),
  layer('world-subject', 'subject', [
    { x: 0.505, y: 0.73 }, { x: 0.525, y: 0.665 }, { x: 0.55, y: 0.626 }, { x: 0.564, y: 0.58 },
    { x: 0.581, y: 0.52 }, { x: 0.604, y: 0.451 }, { x: 0.631, y: 0.399 }, { x: 0.665, y: 0.344 },
    { x: 0.691, y: 0.302 }, { x: 0.713, y: 0.281 }, { x: 0.735, y: 0.29 }, { x: 0.749, y: 0.31 },
    { x: 0.725, y: 0.337 }, { x: 0.696, y: 0.371 }, { x: 0.675, y: 0.414 }, { x: 0.653, y: 0.469 },
    { x: 0.633, y: 0.523 }, { x: 0.613, y: 0.58 }, { x: 0.593, y: 0.632 }, { x: 0.569, y: 0.681 },
    { x: 0.542, y: 0.72 }, { x: 0.522, y: 0.751 },
  ], { name: 'Tidal leviathan · subject', z: 0.93, opacity: 0.99, feather: 0.18 }),
  layer('world-foreground', 'foreground', [
    { x: 0.79, y: 0.684 }, { x: 0.828, y: 0.665 }, { x: 0.863, y: 0.65 }, { x: 0.896, y: 0.663 },
    { x: 0.934, y: 0.648 }, { x: 0.97, y: 0.676 }, { x: 1, y: 0.724 }, { x: 1, y: 1 },
    { x: 0.79, y: 1 }, { x: 0.82, y: 0.942 }, { x: 0.79, y: 0.892 }, { x: 0.814, y: 0.842 },
    { x: 0.785, y: 0.795 },
  ], { name: 'Crystal-shelled visitor · foreground', z: 1.28, opacity: 1, feather: 0.2 }),
];

export const orchardLayers = (): DepthLayer[] => [
  layer('orchard-backdrop', 'backdrop', [], { name: 'Dusk field · full source', z: 0.1, opacity: 0.62, feather: 0, full: true }),
  layer('orchard-atmosphere', 'atmosphere', [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.46 }, { x: 0.82, y: 0.43 },
    { x: 0.7, y: 0.48 }, { x: 0.57, y: 0.44 }, { x: 0.42, y: 0.47 }, { x: 0.25, y: 0.43 }, { x: 0, y: 0.48 },
  ], { name: 'Dusk & vapor · atmosphere', z: 0.34, opacity: 0.82, feather: 0.35 }),
  layer('orchard-architecture', 'architecture', [
    { x: 0, y: 0.65 }, { x: 0.18, y: 0.61 }, { x: 0.33, y: 0.65 }, { x: 0.48, y: 0.62 },
    { x: 0.64, y: 0.66 }, { x: 0.82, y: 0.61 }, { x: 1, y: 0.64 }, { x: 1, y: 1 }, { x: 0, y: 1 },
  ], { name: 'Tidewalk & towers · architecture', z: 0.61, opacity: 0.91, feather: 0.25 }),
  layer('orchard-subject', 'subject', [
    { x: 0.22, y: 0.72 }, { x: 0.26, y: 0.51 }, { x: 0.27, y: 0.32 }, { x: 0.31, y: 0.19 },
    { x: 0.37, y: 0.13 }, { x: 0.44, y: 0.14 }, { x: 0.49, y: 0.22 }, { x: 0.53, y: 0.39 },
    { x: 0.51, y: 0.7 }, { x: 0.47, y: 0.7 }, { x: 0.46, y: 0.39 }, { x: 0.42, y: 0.22 },
    { x: 0.37, y: 0.2 }, { x: 0.33, y: 0.29 }, { x: 0.32, y: 0.53 }, { x: 0.3, y: 0.74 },
  ], { name: 'Glass orchard arches · subject', z: 0.94, opacity: 0.98, feather: 0.15 }),
  layer('orchard-foreground', 'foreground', [
    { x: 0, y: 0.75 }, { x: 0.07, y: 0.67 }, { x: 0.1, y: 0.81 }, { x: 0.15, y: 0.59 },
    { x: 0.18, y: 1 }, { x: 0, y: 1 }, { x: 0.83, y: 1 }, { x: 0.86, y: 0.78 },
    { x: 0.9, y: 0.88 }, { x: 0.96, y: 0.69 }, { x: 1, y: 0.75 }, { x: 1, y: 1 }, { x: 0.83, y: 1 },
  ], { name: 'Nearest glass reeds · foreground', z: 1.26, opacity: 1, feather: 0.25 }),
];

export const engineLayers = (): DepthLayer[] => [
  layer('engine-backdrop', 'backdrop', [], { name: 'Unlit vault · full source', z: 0.1, opacity: 0.62, feather: 0, full: true }),
  layer('engine-atmosphere', 'atmosphere', [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.48 }, { x: 0.84, y: 0.43 },
    { x: 0.7, y: 0.48 }, { x: 0.53, y: 0.44 }, { x: 0.38, y: 0.49 }, { x: 0.21, y: 0.45 }, { x: 0, y: 0.51 },
  ], { name: 'Ribbed vault · atmosphere', z: 0.35, opacity: 0.84, feather: 0.2 }),
  layer('engine-architecture', 'architecture', [
    { x: 0, y: 0.69 }, { x: 0.16, y: 0.66 }, { x: 0.31, y: 0.69 }, { x: 0.46, y: 0.65 },
    { x: 0.61, y: 0.68 }, { x: 0.77, y: 0.64 }, { x: 0.9, y: 0.68 }, { x: 1, y: 0.66 },
    { x: 1, y: 1 }, { x: 0, y: 1 },
  ], { name: 'Walkway & plinths · architecture', z: 0.62, opacity: 0.92, feather: 0.2 }),
  layer('engine-subject', 'subject', [
    { x: 0.34, y: 0.48 }, { x: 0.37, y: 0.36 }, { x: 0.42, y: 0.25 }, { x: 0.49, y: 0.2 },
    { x: 0.57, y: 0.21 }, { x: 0.63, y: 0.27 }, { x: 0.67, y: 0.37 }, { x: 0.68, y: 0.48 },
    { x: 0.63, y: 0.57 }, { x: 0.56, y: 0.62 }, { x: 0.47, y: 0.61 }, { x: 0.4, y: 0.56 },
  ], { name: 'Suspended engine · subject', z: 0.95, opacity: 0.99, feather: 0.15 }),
  layer('engine-foreground', 'foreground', [
    { x: 0, y: 0.25 }, { x: 0.07, y: 0.24 }, { x: 0.1, y: 0.29 }, { x: 0.11, y: 0.79 },
    { x: 0.17, y: 0.8 }, { x: 0.17, y: 1 }, { x: 0, y: 1 }, { x: 0.84, y: 1 },
    { x: 0.84, y: 0.82 }, { x: 0.89, y: 0.8 }, { x: 0.89, y: 0.28 }, { x: 0.94, y: 0.25 },
    { x: 1, y: 0.29 }, { x: 1, y: 1 }, { x: 0.84, y: 1 },
  ], { name: 'Nearest pillars · foreground', z: 1.28, opacity: 1, feather: 0.12 }),
];

export const createGenericLayers = (): DepthLayer[] => [
  layer('user-backdrop', 'backdrop', [], { name: 'Full image · distant backdrop', z: 0.1, opacity: 0.55, feather: 0, full: true }),
  layer('user-atmosphere', 'atmosphere', [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.42 }, { x: 0.83, y: 0.47 },
    { x: 0.66, y: 0.42 }, { x: 0.5, y: 0.47 }, { x: 0.32, y: 0.42 }, { x: 0.16, y: 0.46 }, { x: 0, y: 0.43 },
  ], { z: 0.36, opacity: 0.78, feather: 0.4 }),
  layer('user-architecture', 'architecture', [
    { x: 0, y: 0.58 }, { x: 0.13, y: 0.53 }, { x: 0.27, y: 0.59 }, { x: 0.41, y: 0.55 },
    { x: 0.58, y: 0.6 }, { x: 0.73, y: 0.55 }, { x: 0.88, y: 0.59 }, { x: 1, y: 0.54 }, { x: 1, y: 1 }, { x: 0, y: 1 },
  ], { z: 0.62, opacity: 0.88, feather: 0.3 }),
  layer('user-subject', 'subject', [
    { x: 0.34, y: 0.72 }, { x: 0.33, y: 0.53 }, { x: 0.37, y: 0.34 }, { x: 0.44, y: 0.22 },
    { x: 0.52, y: 0.17 }, { x: 0.61, y: 0.23 }, { x: 0.66, y: 0.37 }, { x: 0.67, y: 0.55 },
    { x: 0.62, y: 0.7 }, { x: 0.54, y: 0.77 }, { x: 0.44, y: 0.77 },
  ], { z: 0.94, opacity: 0.94, feather: 0.35 }),
  layer('user-foreground', 'foreground', [
    { x: 0, y: 0.73 }, { x: 0.13, y: 0.68 }, { x: 0.22, y: 0.73 }, { x: 0.28, y: 0.69 },
    { x: 0.34, y: 0.75 }, { x: 0.31, y: 1 }, { x: 0, y: 1 },
  ], { z: 1.28, opacity: 1, feather: 0.3 }),
];

export const freshBuiltInScenes = (): SceneRecord[] => [
  {
    id: 'attached-world',
    title: 'The World Between Two Frames',
    subtitle: 'A painted sea, held at the edge of becoming.',
    sourceName: 'file_00000000f77881f5987cd6d628ca6347.png',
    sourceUrl: import.meta.env.BASE_URL + 'artwork/file_00000000f77881f5987cd6d628ca6347.png',
    sourceKind: 'attached',
    width: 1671,
    height: 941,
    layers: attachedWorldLayers(),
  },
  {
    id: 'glass-orchard',
    title: 'The Glass Orchard',
    subtitle: 'A tidewalk passes through the quiet arches.',
    sourceName: 'glass-orchard.svg',
    sourceUrl: import.meta.env.BASE_URL + 'artwork/glass-orchard.svg',
    sourceKind: 'demo',
    width: 1600,
    height: 900,
    layers: orchardLayers(),
  },
  {
    id: 'quiet-engine',
    title: 'The Quiet Engine',
    subtitle: 'A suspended mechanism in an unlit archive.',
    sourceName: 'quiet-engine.svg',
    sourceUrl: import.meta.env.BASE_URL + 'artwork/quiet-engine.svg',
    sourceKind: 'demo',
    width: 1600,
    height: 900,
    layers: engineLayers(),
  },
];
