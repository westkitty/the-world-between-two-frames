import * as THREE from 'three';
import {
  createGenericLayers,
  freshBuiltInScenes,
  ROLE_DEFAULT_Z,
  ROLE_LABELS,
  type DepthLayer,
  type DepthRole,
  type Point,
  type SceneRecord,
  type SourceKind,
} from './scenes';
import './styles.css';

type Mode = 'FLAT' | 'PEEL' | 'EXPLORE' | 'CROSSING';
type Pose = { x: number; y: number; z: number; yaw: number; pitch: number };
type GripSide = 'left' | 'right' | 'top' | 'bottom';
type PointerGesture =
  | { kind: 'look'; x: number; y: number; yaw: number; pitch: number; moved: boolean }
  | { kind: 'depth'; x: number; y: number; side: GripSide; startDepth: number; moved: boolean };
type LayerEntry = { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; layer: DepthLayer };
type PortalEntry = { direction: -1 | 1; x: number; y: number; z: number; hit: THREE.Mesh; ringMaterials: THREE.MeshBasicMaterial[]; aura: THREE.MeshBasicMaterial };
type ProjectSnapshot = {
  id: 'current';
  schemaVersion: number;
  updatedAt: number;
  order: string[];
  activeSceneId: string;
  depth: number;
  builtIns: Array<{ id: string; title: string; subtitle: string; layers: DepthLayer[] }>;
  uploads: Array<{ id: string; title: string; subtitle: string; sourceName: string; width: number; height: number; layers: DepthLayer[]; blob: Blob }>;
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element as T;
};
const WORLD_HEIGHT = 5.2;
const FIELD_OF_VIEW = 32;
const MAX_TEXTURE_SIDE = 2048;
const DB_NAME = 'world-between-two-frames';
const DB_STORE = 'projects';
const PROJECT_KEY = 'current';
const ROLE_ORDER: DepthRole[] = ['backdrop', 'atmosphere', 'architecture', 'subject', 'foreground'];
const ROLE_COLORS: Record<DepthRole, string> = {
  backdrop: '#9ca8a2', atmosphere: '#9ac3cb', architecture: '#d1b792', subject: '#b6acdf', foreground: '#e0c98e',
};

const canvas = $('worldCanvas') as HTMLCanvasElement;
const frameOutline = $('frameOutline');
const sceneRail = $('sceneRail');
const editorShell = $('editorShell');
const maskCanvas = $('maskCanvas') as HTMLCanvasElement;
const maskContext = maskCanvas.getContext('2d');
const imageInput = $('imageInput') as HTMLInputElement;
const projectInput = $('projectInput') as HTMLInputElement;
const depthSlider = $('depthSlider') as HTMLInputElement;
const depthOutput = $('depthValue');
const sliderHint = $('sliderHint');
const enterButton = $('enterButton') as HTMLButtonElement;
const enterLabel = enterButton.querySelector('span') as HTMLSpanElement;
const statusText = $('statusText');
const editorLayerList = $('editorLayerList');
const layerLegendList = $('layerLegendList');
const toastElement = $('toast');
const editorSaveStatus = $('editorSaveStatus');
const modeLabel = $('modeLabel');
const sceneCountLabel = $('sceneCount');
const layerCountLabel = $('layerCountLabel');
const roleSelect = $('roleSelect') as HTMLSelectElement;
const featherRange = $('featherRange') as HTMLInputElement;
const layerDistanceRange = $('layerDistance') as HTMLInputElement;
const saveMaskButton = $('saveMaskButton') as HTMLButtonElement;
const startMaskButton = $('startMaskButton') as HTMLButtonElement;

const builtInTemplates = freshBuiltInScenes();
let scenes: SceneRecord[] = [...builtInTemplates];
let activeIndex = 0;
let currentMode: Mode = 'FLAT';
let depth = 0;
let renderer: THREE.WebGLRenderer | null = null;
let threeScene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let worldGroup: THREE.Group | null = null;
let baseMesh: THREE.Mesh | null = null;
let baseMaterial: THREE.MeshBasicMaterial | null = null;
let layerEntries: LayerEntry[] = [];
let portalEntries: PortalEntry[] = [];
let particlePoints: THREE.Points | null = null;
let fitDistance = 12;
let imageWorldWidth = 9.2;
let imageWorldHeight = WORLD_HEIGHT;
let frameWidthPx = 1000;
let frameHeightPx = 560;
let pointerX = 0;
let pointerY = 0;
let pointerDown: PointerGesture | null = null;
let cameraPose: Pose = { x: 0, y: 0, z: 12, yaw: 0, pitch: 0 };
let cameraTween: { from: Pose; to: Pose; elapsed: number; duration: number; onComplete?: () => void } | null = null;
let busy = false;
let lowGpu = false;
let reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
let editorOpen = false;
let drawingMask = false;
let maskClosed = false;
let draftPoints: Point[] = [];
let selectedLayerId: string | null = null;
let toastTimer = 0;
let saveTimer = 0;
let storageUnavailable = false;
let dbPromise: Promise<IDBDatabase> | null = null;
let rafId = 0;
let running = false;
let elapsedSeconds = 0;
let lastDepthSound = 0;
let audioContext: AudioContext | null = null;
let soundEnabled = false;
let sourceCanvasCache = new WeakMap<HTMLImageElement, HTMLCanvasElement>();
let lastFrameTime = 0;
const pointerNdc = new THREE.Vector2();
const raycaster = new THREE.Raycaster();

function currentScene(): SceneRecord {
  return scenes[activeIndex] ?? scenes[0];
}
function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('input,select,textarea,[contenteditable="true"]');
}
function cloneLayers(layers: DepthLayer[]): DepthLayer[] {
  return layers.map((item) => ({ ...item, points: item.points.map((p) => ({ x: p.x, y: p.y })) }));
}
function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}
function sanitizeLayers(input: unknown): DepthLayer[] {
  if (!Array.isArray(input)) return createGenericLayers();
  return input.slice(0, 32).map((raw, index) => {
    const item = raw && typeof raw === 'object' ? raw as Partial<DepthLayer> : {};
    const role = ROLE_ORDER.includes(item.role as DepthRole) ? item.role as DepthRole : 'subject';
    const points = Array.isArray(item.points)
      ? item.points.slice(0, 64).map((rawPoint) => {
        const point = rawPoint as Partial<Point> | null;
        return {
          x: boundedNumber(point?.x, 0, 0, 1),
          y: boundedNumber(point?.y, 0, 0, 1),
        };
      })
      : [];
    return {
      id: typeof item.id === 'string' && item.id.trim() ? item.id.slice(0, 120) : `layer-restored-${index}`,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.slice(0, 120) : ROLE_LABELS[role],
      role,
      z: boundedNumber(item.z, ROLE_DEFAULT_Z[role], 0.05, 1.6),
      opacity: boundedNumber(item.opacity, 0.95, 0.05, 1),
      feather: boundedNumber(item.feather, 0, 0, 8),
      points,
      full: Boolean(item.full) || points.length < 3,
      custom: Boolean(item.custom),
    };
  });
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
function easeInOut(value: number): number {
  const t = clamp(value, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function titleFromFilename(filename: string): string {
  const withoutExt = filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return withoutExt.replace(/\b\w/g, (letter) => letter.toUpperCase()) || 'Imported artwork';
}
function pad(value: number): string {
  return String(value).padStart(2, '0');
}
function setStatus(message: string): void {
  statusText.innerHTML = `<i></i>${message}`;
}
function showToast(message: string, duration = 3300): void {
  toastElement.textContent = message;
  toastElement.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastElement.classList.remove('visible'), duration);
}
function makeImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load image: ${url}`));
    image.src = url;
  });
}
function makeSourceCanvas(image: HTMLImageElement): HTMLCanvasElement {
  const cached = sourceCanvasCache.get(image);
  if (cached) return cached;
  const ratio = Math.min(1, MAX_TEXTURE_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
  sourceCanvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
  // Keep transparent imports transparent; flattening them here would turn every alpha hole black.
  const context = sourceCanvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('Canvas texture creation is unavailable.');
  context.drawImage(image, 0, 0, sourceCanvas.width, sourceCanvas.height);
  sourceCanvasCache.set(image, sourceCanvas);
  return sourceCanvas;
}
function makeCanvasTexture(source: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(source);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer ? Math.min(renderer.capabilities.getMaxAnisotropy(), 4) : 1;
  texture.needsUpdate = true;
  return texture;
}
function createMaskTexture(source: HTMLCanvasElement, layer: DepthLayer): THREE.CanvasTexture {
  const output = document.createElement('canvas');
  output.width = source.width;
  output.height = source.height;
  const context = output.getContext('2d');
  if (!context) throw new Error('Could not create a layer mask.');
  context.drawImage(source, 0, 0);
  if (!layer.full && layer.points.length >= 3) {
    const mask = document.createElement('canvas');
    mask.width = source.width;
    mask.height = source.height;
    const maskContext = mask.getContext('2d');
    if (!maskContext) throw new Error('Could not create a layer mask.');
    maskContext.fillStyle = '#fff';
    maskContext.beginPath();
    layer.points.forEach((point, index) => {
      const x = point.x * mask.width;
      const y = point.y * mask.height;
      if (index === 0) maskContext.moveTo(x, y);
      else maskContext.lineTo(x, y);
    });
    maskContext.closePath();
    maskContext.fill();
    const featherPx = Math.max(0, Math.min(36, (layer.feather / 100) * Math.min(mask.width, mask.height)));
    let effectiveMask = mask;
    if (featherPx > 0.5) {
      const feathered = document.createElement('canvas');
      feathered.width = mask.width;
      feathered.height = mask.height;
      const featherContext = feathered.getContext('2d');
      if (featherContext) {
        featherContext.filter = `blur(${featherPx}px)`;
        featherContext.drawImage(mask, 0, 0);
        featherContext.filter = 'none';
        effectiveMask = feathered;
      }
    }
    context.globalCompositeOperation = 'destination-in';
    context.drawImage(effectiveMask, 0, 0);
    context.globalCompositeOperation = 'source-over';
    // A restrained paper-edge catch makes the cutout readable without changing its pixels.
    context.beginPath();
    layer.points.forEach((point, index) => {
      const x = point.x * output.width;
      const y = point.y * output.height;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.closePath();
    context.strokeStyle = 'rgba(162, 207, 211, 0.17)';
    context.lineWidth = Math.max(1, Math.min(output.width, output.height) / 650);
    context.stroke();
  }
  return makeCanvasTexture(output);
}
function makePortalImageTexture(image: HTMLImageElement): THREE.CanvasTexture {
  const output = document.createElement('canvas');
  output.width = 240;
  output.height = 420;
  const context = output.getContext('2d');
  if (!context) throw new Error('Portal canvas unavailable.');
  const ratio = Math.max(output.width / image.naturalWidth, output.height / image.naturalHeight);
  const drawW = image.naturalWidth * ratio;
  const drawH = image.naturalHeight * ratio;
  context.drawImage(image, (output.width - drawW) / 2, (output.height - drawH) / 2, drawW, drawH);
  const mask = document.createElement('canvas');
  mask.width = output.width;
  mask.height = output.height;
  const maskContext = mask.getContext('2d');
  if (!maskContext) throw new Error('Portal mask unavailable.');
  maskContext.fillStyle = '#fff';
  maskContext.beginPath();
  maskContext.moveTo(12, 420);
  maskContext.lineTo(12, 135);
  maskContext.quadraticCurveTo(15, 14, 120, 14);
  maskContext.quadraticCurveTo(225, 14, 228, 135);
  maskContext.lineTo(228, 420);
  maskContext.closePath();
  maskContext.fill();
  context.globalCompositeOperation = 'destination-in';
  context.drawImage(mask, 0, 0);
  return makeCanvasTexture(output);
}
function makeAuraTexture(): THREE.CanvasTexture {
  const source = document.createElement('canvas');
  source.width = 128;
  source.height = 256;
  const context = source.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(64, 125, 10, 64, 125, 125);
    gradient.addColorStop(0, 'rgba(130, 190, 199, .24)');
    gradient.addColorStop(0.4, 'rgba(130, 190, 199, .1)');
    gradient.addColorStop(1, 'rgba(130, 190, 199, 0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, source.width, source.height);
  }
  return makeCanvasTexture(source);
}
function createPlaneMaterial(texture: THREE.Texture, opacity: number, alphaTest = 0.006): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity,
    alphaTest,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}
function disposeWorldGroup(): void {
  if (!worldGroup) return;
  for (const child of [...worldGroup.children]) {
    worldGroup.remove(child);
    child.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) {
        material.forEach((item) => {
          if (item instanceof THREE.MeshBasicMaterial) item.map?.dispose();
          item.dispose();
        });
      } else if (material) {
        const mapped = material as THREE.Material & { map?: THREE.Texture | null };
        mapped.map?.dispose();
        material.dispose();
      }
    });
  }
  layerEntries = [];
  portalEntries = [];
  baseMesh = null;
  baseMaterial = null;
  particlePoints = null;
}
function createParticleField(width: number, height: number): THREE.Points {
  const count = lowGpu ? 28 : 92;
  const positions = new Float32Array(count * 3);
  let seed = 21 + activeIndex * 97;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (random() - 0.5) * width * 1.12;
    positions[i * 3 + 1] = (random() - 0.5) * height * 1.08;
    positions[i * 3 + 2] = -0.8 + random() * 2.3;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xc4d4d0,
    size: lowGpu ? 0.026 : 0.022,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 30;
  return points;
}
function createPortal(direction: -1 | 1, destination: SceneRecord, width: number, height: number): PortalEntry {
  if (!worldGroup || !destination.image) throw new Error('Portal destination is not ready.');
  const portalWidth = height * 0.145;
  const portalHeight = height * 0.31;
  const x = direction * (width * 0.475);
  const y = -height * 0.015;
  const z = height * 0.205;
  const group = new THREE.Group();
  group.position.set(x, y, z);
  worldGroup.add(group);

  const auraTexture = makeAuraTexture();
  const auraMaterial = new THREE.MeshBasicMaterial({ map: auraTexture, color: 0x9ac7ca, transparent: true, opacity: 0.72, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const aura = new THREE.Mesh(new THREE.PlaneGeometry(portalWidth * 2.5, portalHeight * 1.8), auraMaterial);
  aura.position.z = -0.045;
  aura.renderOrder = 42;
  group.add(aura);

  const apertureTexture = makePortalImageTexture(destination.image);
  const apertureMaterial = createPlaneMaterial(apertureTexture, 0.92, 0.025);
  const aperture = new THREE.Mesh(new THREE.PlaneGeometry(portalWidth, portalHeight), apertureMaterial);
  aperture.position.z = 0;
  aperture.renderOrder = 43;
  group.add(aperture);

  const radius = portalWidth * 0.52;
  const ringGeometry = new THREE.TorusGeometry(radius, Math.max(0.012, height * 0.004), 7, 56);
  const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x9dcbd0, transparent: true, opacity: 0.68, depthWrite: false, toneMapped: false });
  const ring = new THREE.Mesh(ringGeometry, ringMaterial);
  ring.scale.y = portalHeight / (radius * 2) * 1.02;
  ring.position.z = 0.03;
  ring.renderOrder = 45;
  group.add(ring);

  const innerRingMaterial = new THREE.MeshBasicMaterial({ color: 0xd5c19e, transparent: true, opacity: 0.22, depthWrite: false, toneMapped: false });
  const innerRing = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.88, Math.max(0.007, height * 0.0018), 6, 56), innerRingMaterial);
  innerRing.scale.y = portalHeight / (radius * 2) * 0.98;
  innerRing.position.z = 0.035;
  innerRing.renderOrder = 46;
  group.add(innerRing);

  const shape = new THREE.Shape();
  const hw = portalWidth * 0.62;
  const hh = portalHeight * 0.62;
  shape.moveTo(-hw, -hh);
  shape.lineTo(-hw, hh * 0.42);
  shape.quadraticCurveTo(-hw, hh, 0, hh);
  shape.quadraticCurveTo(hw, hh, hw, hh * 0.42);
  shape.lineTo(hw, -hh);
  shape.closePath();
  const hitMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.001, colorWrite: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const hit = new THREE.Mesh(new THREE.ShapeGeometry(shape, 20), hitMaterial);
  hit.position.z = 0.06;
  hit.userData.direction = direction;
  group.add(hit);

  const entry: PortalEntry = { direction, x, y, z, hit, ringMaterials: [ringMaterial, innerRingMaterial, apertureMaterial], aura: auraMaterial };
  portalEntries.push(entry);
  return entry;
}
function rebuildWorld(): void {
  if (!threeScene || !worldGroup || !renderer) return;
  disposeWorldGroup();
  const sourceScene = currentScene();
  if (!sourceScene.image) return;
  imageWorldHeight = WORLD_HEIGHT;
  imageWorldWidth = imageWorldHeight * (sourceScene.image.naturalWidth / sourceScene.image.naturalHeight);
  const source = makeSourceCanvas(sourceScene.image);
  const texture = makeCanvasTexture(source);
  const baseGeometry = new THREE.PlaneGeometry(imageWorldWidth, imageWorldHeight, 1, 1);
  baseMaterial = createPlaneMaterial(texture, 1, 0);
  baseMesh = new THREE.Mesh(baseGeometry, baseMaterial);
  baseMesh.position.z = 0;
  baseMesh.renderOrder = 0;
  worldGroup.add(baseMesh);

  const sortedLayers = cloneLayers(sourceScene.layers).sort((a, b) => a.z - b.z);
  sortedLayers.forEach((layer, index) => {
    if (!sourceScene.image) return;
    const layerTexture = createMaskTexture(source, layer);
    const material = createPlaneMaterial(layerTexture, 0, 0.004);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(imageWorldWidth, imageWorldHeight, 1, 1), material);
    mesh.renderOrder = 4 + index;
    mesh.userData.layerId = layer.id;
    worldGroup?.add(mesh);
    layerEntries.push({ mesh, material, layer });
  });

  particlePoints = createParticleField(imageWorldWidth, imageWorldHeight);
  worldGroup.add(particlePoints);

  const previousIndex = activeIndex - 1;
  const nextIndex = activeIndex + 1;
  if (previousIndex >= 0) createPortal(-1, scenes[previousIndex], imageWorldWidth, imageWorldHeight);
  if (nextIndex < scenes.length) createPortal(1, scenes[nextIndex], imageWorldWidth, imageWorldHeight);
  updatePlaneState();
  resizeStage();
}
function updatePlaneState(): void {
  const amount = currentMode === 'FLAT' ? 0 : currentMode === 'PEEL' ? depth / 100 : 1;
  if (baseMesh && baseMaterial) {
    baseMesh.position.z = amount === 0 ? 0 : -imageWorldHeight * 0.19 * amount;
    baseMaterial.opacity = currentMode === 'FLAT' ? 1 : currentMode === 'PEEL' ? 1 - amount * 0.48 : currentMode === 'CROSSING' ? 0.16 : 0.18;
  }
  for (const entry of layerEntries) {
    const planeZ = -imageWorldHeight * 0.17 + entry.layer.z * imageWorldHeight * 0.18;
    entry.mesh.position.z = planeZ * amount;
    const spread = (entry.layer.z - 0.62) * amount;
    entry.mesh.position.x = spread * imageWorldHeight * 0.055;
    entry.mesh.position.y = -spread * imageWorldHeight * 0.022;
    entry.material.opacity = (currentMode === 'FLAT' ? 0 : currentMode === 'PEEL' ? amount : 1) * entry.layer.opacity;
  }
  if (particlePoints) {
    particlePoints.visible = currentMode !== 'FLAT' && depth > 3;
    const material = particlePoints.material as THREE.PointsMaterial;
    material.opacity = currentMode === 'PEEL' ? Math.min(0.28, amount * 0.23) : currentMode === 'EXPLORE' ? 0.26 : currentMode === 'CROSSING' ? 0.34 : 0;
  }
}
function updateFrameCamera(delta: number): void {
  if (!camera) return;
  const amount = currentMode === 'FLAT' ? 0 : depth / 100;
  const orbit = currentMode === 'PEEL' ? amount : 0;
  const x = pointerX * 0.12 + orbit * imageWorldHeight * 0.34;
  const y = -pointerY * 0.08;
  const z = fitDistance * (1 - orbit * 0.018);
  camera.position.set(x, y, z);
  camera.lookAt(0, 0, 0);
  cameraPose = { x: camera.position.x, y: camera.position.y, z: camera.position.z, yaw: camera.rotation.y, pitch: camera.rotation.x };
  if (delta > 0 && worldGroup && currentMode === 'PEEL') {
    worldGroup.rotation.y = 0;
  }
}
function applyPose(pose: Pose): void {
  if (!camera) return;
  camera.position.set(pose.x, pose.y, pose.z);
  camera.rotation.order = 'YXZ';
  camera.rotation.set(pose.pitch, pose.yaw, 0);
  cameraPose = { ...pose };
}
function poseNow(): Pose {
  if (!camera) return cameraPose;
  return { x: camera.position.x, y: camera.position.y, z: camera.position.z, yaw: camera.rotation.y, pitch: camera.rotation.x };
}
function startCameraTween(target: Pose, duration: number, onComplete?: () => void): void {
  const from = poseNow();
  cameraTween = { from, to: { ...target }, elapsed: 0, duration: reducedMotion ? 0.16 : duration, onComplete };
}
function stepCameraTween(delta: number): boolean {
  if (!cameraTween) return false;
  cameraTween.elapsed += delta;
  const tween = cameraTween;
  const t = easeInOut(tween.elapsed / tween.duration);
  applyPose({
    x: THREE.MathUtils.lerp(tween.from.x, tween.to.x, t),
    y: THREE.MathUtils.lerp(tween.from.y, tween.to.y, t),
    z: THREE.MathUtils.lerp(tween.from.z, tween.to.z, t),
    yaw: THREE.MathUtils.lerp(tween.from.yaw, tween.to.yaw, t),
    pitch: THREE.MathUtils.lerp(tween.from.pitch, tween.to.pitch, t),
  });
  if (t >= 1) {
    cameraTween = null;
    tween.onComplete?.();
  }
  return true;
}
function resizeStage(): void {
  if (!renderer || !camera) return;
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  const aspect = currentScene().image ? currentScene().image!.naturalWidth / currentScene().image!.naturalHeight : 16 / 9;
  const isSmall = width < 681;
  const maxWidth = width * (isSmall ? 0.92 : width < 1000 ? 0.78 : 0.82);
  const maxHeight = height * (isSmall ? 0.62 : 0.68) * aspect;
  frameWidthPx = Math.max(160, Math.min(maxWidth, 1280, maxHeight));
  frameHeightPx = frameWidthPx / aspect;
  document.documentElement.style.setProperty('--frame-width', `${frameWidthPx}px`);
  document.documentElement.style.setProperty('--frame-height', `${frameHeightPx}px`);
  document.documentElement.style.setProperty('--image-ratio', String(aspect));
  const pixelRatio = lowGpu ? 0.75 : Math.min(window.devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.fov = FIELD_OF_VIEW;
  camera.near = 0.05;
  camera.far = 160;
  camera.updateProjectionMatrix();
  fitDistance = (WORLD_HEIGHT * height) / (2 * frameHeightPx * Math.tan(THREE.MathUtils.degToRad(FIELD_OF_VIEW / 2)));
  if (!cameraTween && (currentMode === 'FLAT' || currentMode === 'PEEL')) updateFrameCamera(0);
  if (editorOpen) resizeMaskCanvas();
}
function updatePortals(delta: number): void {
  const pulse = Math.sin(elapsedSeconds * 1.3) * 0.08;
  const reveal = currentMode === 'FLAT' ? 0 : currentMode === 'PEEL' ? clamp((depth - 2) / 38, 0, 1) : 1;
  for (const portal of portalEntries) {
    portal.ringMaterials[0].opacity = (0.64 + pulse) * reveal;
    portal.ringMaterials[1].opacity = (0.18 + pulse * 0.38) * reveal;
    portal.ringMaterials[2].opacity = 0.92 * reveal;
    portal.aura.opacity = (0.65 + pulse * 0.7) * reveal;
  }
  if (worldGroup && currentMode === 'EXPLORE' && delta > 0) {
    worldGroup.rotation.y = 0;
  }
}
function animationFrame(timestamp: number): void {
  if (!running || document.hidden) return;
  rafId = requestAnimationFrame(animationFrame);
  const delta = Math.min(Math.max((timestamp - lastFrameTime) / 1000, 0), 0.1);
  lastFrameTime = timestamp;
  elapsedSeconds += delta;
  if (!cameraTween && (currentMode === 'FLAT' || currentMode === 'PEEL')) updateFrameCamera(delta);
  else if (!stepCameraTween(delta) && currentMode === 'EXPLORE' && camera) applyPose(cameraPose);
  updatePlaneState();
  updatePortals(delta);
  if (particlePoints) particlePoints.rotation.z = elapsedSeconds * (lowGpu ? 0.0012 : 0.0018);
  if (renderer && threeScene && camera) renderer.render(threeScene, camera);
}
function startAnimation(): void {
  if (running) return;
  running = true;
  lastFrameTime = performance.now();
  rafId = requestAnimationFrame(animationFrame);
}
function pauseAnimation(): void {
  running = false;
  cancelAnimationFrame(rafId);
}
function updateCaption(): void {
  const selected = currentScene();
  $('sceneNumber').textContent = pad(activeIndex + 1);
  $('sceneTitle').textContent = selected.title;
  $('sceneSubtitle').textContent = selected.subtitle;
  $('sceneCount').textContent = `${pad(activeIndex + 1)} — ${pad(scenes.length)}`;
  $('sceneKind').textContent = selected.sourceKind === 'demo' ? 'PROCEDURAL DEMONSTRATION' : selected.sourceKind === 'attached' ? 'USER ARTWORK' : 'IMPORTED ARTWORK';
  const dimensions = `${selected.image?.naturalWidth ?? selected.width} × ${selected.image?.naturalHeight ?? selected.height}`;
  $('sceneProvenance').textContent = selected.sourceKind === 'demo'
    ? 'Procedural scene · not Starsilk canon · centered / contain'
    : selected.sourceKind === 'attached'
      ? `User-provided image · ${dimensions} · centered / contain`
      : `${selected.sourceName} · ${dimensions} · centered / contain`;
  renderSceneRail();
  updateLayerLegend();
  updatePortalMessage();
}
function renderSceneRail(): void {
  sceneRail.innerHTML = '';
  scenes.forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `scene-thumb${index === activeIndex ? ' active' : ''}`;
    button.setAttribute('aria-label', `Show image ${index + 1}: ${item.title}`);
    button.setAttribute('aria-pressed', String(index === activeIndex));
    button.title = item.title;
    const image = document.createElement('img');
    image.alt = '';
    image.src = item.objectUrl ?? item.sourceUrl;
    const number = document.createElement('span');
    number.className = 'thumb-number';
    number.textContent = pad(index + 1);
    const state = document.createElement('span');
    state.className = 'thumb-state';
    button.append(image, number, state);
    button.addEventListener('click', () => selectScene(index));
    sceneRail.append(button);
  });
  const caption = document.createElement('div');
  caption.className = 'rail-caption';
  caption.textContent = 'IMAGE SEQUENCE';
  sceneRail.append(caption);
}
function updateLayerLegend(): void {
  const list = cloneLayers(currentScene().layers).sort((a, b) => a.z - b.z);
  layerLegendList.innerHTML = '';
  list.forEach((item, index) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="legend-number">${pad(index + 1)}</span><span class="legend-tick" style="background:${ROLE_COLORS[item.role]}"></span><span>${escapeHtml(item.name)}</span>`;
    layerLegendList.append(li);
  });
  document.querySelector('.legend-heading span')!.textContent = pad(list.length);
  $('depthLegend').classList.toggle('visible', depth >= 18 && currentMode !== 'FLAT' && currentMode !== 'CROSSING');
  layerCountLabel.textContent = pad(currentScene().layers.length);
}
function updatePortalMessage(): void {
  const note = $('portalNote');
  const next = scenes[activeIndex + 1];
  if (currentMode === 'EXPLORE') {
    note.classList.add('visible');
    $('portalNoteText').textContent = next ? `A SLIVER OF “${next.title.toUpperCase()}” WAITS BEYOND` : 'THE RETURN APERTURE IS BEHIND YOU';
  } else if (currentMode === 'PEEL' && depth > 45 && next) {
    note.classList.add('visible');
    $('portalNoteText').textContent = `A SECOND IMAGE WAITS IN THE GAP · ${next.title.toUpperCase()}`;
  } else {
    note.classList.remove('visible');
  }
}
function updateModeUI(): void {
  const names: Record<Mode, string> = { FLAT: 'FLAT IMAGE', PEEL: 'PEEL / DEPTH', EXPLORE: 'EXPLORATION', CROSSING: 'CROSSING' };
  modeLabel.textContent = names[currentMode];
  const explored = currentMode === 'EXPLORE';
  $('exploreHud').classList.toggle('visible', explored);
  $('exploreHud').classList.toggle('has-previous', explored && activeIndex > 0);
  $('approachPortal').innerHTML = activeIndex < scenes.length - 1
    ? 'FOLLOW THE NEXT APERTURE <span>↗</span>'
    : 'RETURN THROUGH THE LAST APERTURE <span>↖</span>';
  $('depthLegend').classList.toggle('visible', depth >= 18 && currentMode !== 'FLAT' && currentMode !== 'CROSSING');
  depthSlider.disabled = editorOpen || explored || currentMode === 'CROSSING' || busy;
  if (currentMode === 'CROSSING') {
    enterLabel.textContent = 'CROSSING';
    enterButton.disabled = true;
    setStatus('PASSING BETWEEN SOURCE IMAGES');
  } else if (explored) {
    enterLabel.textContent = 'INSIDE THE IMAGE';
    enterButton.disabled = true;
    setStatus('CURATED TRAVEL VOLUME · PROVISIONAL SPATIAL INTERPRETATION');
  } else {
    enterLabel.textContent = 'ENTER IMAGE';
    enterButton.disabled = editorOpen || depth < 24 || busy;
    setStatus(currentMode === 'FLAT'
      ? 'ORIGINAL PIXELS · PROVISIONAL SPATIAL INTERPRETATION'
      : 'FIVE DEPTH ROLES · ORIGINAL PIXELS · NOT A VERIFIED 3D RECONSTRUCTION');
  }
  $('returnButton').setAttribute('aria-label', explored ? 'Return to the image frame' : 'Return to the flat image frame');
  if (storageUnavailable) setStatus('BROWSER STORAGE UNAVAILABLE · EXPORT TO KEEP CHANGES');
  updatePortalMessage();
}
function updateDepthUI(): void {
  depth = clamp(Math.round(depth), 0, 100);
  depthSlider.value = String(depth);
  depthSlider.style.setProperty('--slider-progress', `${depth}%`);
  depthOutput.textContent = pad(depth);
  sliderHint.textContent = currentMode === 'EXPLORE' ? 'MOVE THROUGH THE SCENE' : depth === 0 ? 'PULL THE FRAME APART' : 'FIVE PLANES · CONTROLLED DEPTH';
  if (currentMode !== 'EXPLORE' && currentMode !== 'CROSSING') {
    currentMode = depth === 0 ? 'FLAT' : 'PEEL';
  }
  // Depth changes arrive at pointer rate. Mode UI already handles the legend's
  // visibility, so do not rebuild captions, thumbnails, and list items per frame.
  updateModeUI();
  updatePlaneState();
}
function setDepth(value: number, makeSound = false): void {
  if (editorOpen || busy || currentMode === 'EXPLORE' || currentMode === 'CROSSING') return;
  const previous = depth;
  depth = clamp(Math.round(value), 0, 100);
  if (cameraTween) cameraTween = null;
  updateDepthUI();
  if (makeSound && soundEnabled && Math.abs(depth - previous) >= 12 && Math.abs(depth - lastDepthSound) >= 15) {
    playSound('peel');
    lastDepthSound = depth;
  }
  schedulePersistence();
}
function setMode(mode: Mode): void {
  currentMode = mode;
  updateModeUI();
  updatePlaneState();
  updateLayerLegend();
  updateCaption();
}
function entryDepth(): number {
  return Math.max(WORLD_HEIGHT * 0.88, fitDistance * 0.48);
}
function selectScene(index: number): void {
  if (index < 0 || index >= scenes.length || index === activeIndex || busy) return;
  if (cameraTween) cameraTween = null;
  busy = false;
  depth = 0;
  currentMode = 'FLAT';
  activeIndex = index;
  cameraPose = { x: 0, y: 0, z: fitDistance, yaw: 0, pitch: 0 };
  updateCaption();
  resizeStage();
  rebuildWorld();
  updateDepthUI();
  schedulePersistence();
}
function enterImage(): void {
  if (editorOpen || depth < 24 || busy || currentMode === 'EXPLORE' || currentMode === 'CROSSING') return;
  depth = 100;
  depthSlider.value = '100';
  depthOutput.textContent = '100';
  depthSlider.style.setProperty('--slider-progress', '100%');
  currentMode = 'PEEL';
  updateModeUI();
  updatePlaneState();
  busy = true;
  updateModeUI();
  const target: Pose = { x: imageWorldWidth * 0.025, y: 0, z: entryDepth(), yaw: 0, pitch: 0 };
  startCameraTween(target, 1.7, () => {
    busy = false;
    cameraPose = target;
    setMode('EXPLORE');
    updateExplorePosition();
    playSound('enter');
    schedulePersistence();
  });
}
function returnToFrame(resetDepth = false): void {
  const previousDepth = depth;
  if (resetDepth) {
    depth = 0;
    depthSlider.value = '0';
    depthOutput.textContent = '00';
    depthSlider.style.setProperty('--slider-progress', '0%');
  }
  const destinationMode: Mode = depth > 0 ? 'PEEL' : 'FLAT';
  const needsGlide = currentMode === 'EXPLORE' || currentMode === 'CROSSING' || Boolean(cameraTween) || (resetDepth && previousDepth > 0);
  if (needsGlide) {
    busy = true;
    const target: Pose = { x: 0, y: 0, z: fitDistance, yaw: 0, pitch: 0 };
    startCameraTween(target, 1.25, () => {
      busy = false;
      setMode(destinationMode);
      updateDepthUI();
      schedulePersistence();
    });
  } else {
    setMode(destinationMode);
    updateDepthUI();
  }
}
function setExplorePose(position: Partial<Pose>): void {
  cameraPose = { ...cameraPose, ...position };
  cameraPose.x = clamp(cameraPose.x, -imageWorldWidth * 0.49, imageWorldWidth * 0.49);
  cameraPose.y = clamp(cameraPose.y, -imageWorldHeight * 0.38, imageWorldHeight * 0.38);
  cameraPose.z = clamp(cameraPose.z, imageWorldHeight * 0.16, fitDistance * 1.1);
  applyPose(cameraPose);
  updateExplorePosition();
  checkPortalProximity();
}
function updateExplorePosition(): void {
  $('fieldPosition').textContent = `${cameraPose.x.toFixed(2)} / ${cameraPose.z.toFixed(2)}`;
}
function moveExplore(dx: number, dy: number, dz: number): void {
  if (currentMode !== 'EXPLORE' || busy) return;
  const step = imageWorldHeight * 0.11;
  setExplorePose({ x: cameraPose.x + dx * step, y: cameraPose.y + dy * step, z: cameraPose.z + dz * step });
}
function checkPortalProximity(): void {
  if (currentMode !== 'EXPLORE' || busy) return;
  const entry = portalEntries.find((portal) => Math.abs(portal.x - cameraPose.x) < imageWorldHeight * 0.11
    && Math.abs(portal.y - cameraPose.y) < imageWorldHeight * 0.19
    && cameraPose.z < portal.z + imageWorldHeight * 0.24
    && cameraPose.z > portal.z - imageWorldHeight * 0.34);
  if (entry) crossPortal(entry.direction);
}
function crossPortal(direction: -1 | 1): void {
  if (currentMode !== 'EXPLORE' || busy) return;
  const portal = portalEntries.find((entry) => entry.direction === direction);
  const nextIndex = activeIndex + direction;
  if (!portal || nextIndex < 0 || nextIndex >= scenes.length) {
    showToast('This is the end of the curated passage. Return through the visible aperture.');
    return;
  }
  busy = true;
  setMode('CROSSING');
  playSound('cross');
  const prePortal: Pose = { x: portal.x, y: portal.y, z: portal.z + imageWorldHeight * 0.25, yaw: 0, pitch: 0 };
  startCameraTween(prePortal, 0.88, () => {
    const through: Pose = { x: portal.x, y: portal.y, z: portal.z - imageWorldHeight * 0.16, yaw: 0, pitch: 0 };
    startCameraTween(through, 0.74, () => {
      activeIndex = nextIndex;
      updateCaption();
      resizeStage();
      rebuildWorld();
      const newEntryX = direction > 0 ? -imageWorldWidth * 0.34 : imageWorldWidth * 0.34;
      const newEntry: Pose = { x: newEntryX, y: 0, z: Math.max(imageWorldHeight * 0.9, fitDistance * 0.48), yaw: 0, pitch: 0 };
      startCameraTween(newEntry, 0.9, () => {
        busy = false;
        cameraPose = newEntry;
        setMode('EXPLORE');
        updateExplorePosition();
        showToast(`Crossed into ${currentScene().title}. The previous aperture remains behind you.`, 2800);
        schedulePersistence();
      });
    });
  });
}
function approachPortal(): void {
  if (currentMode !== 'EXPLORE' || busy) return;
  const direction: -1 | 1 = activeIndex < scenes.length - 1 ? 1 : -1;
  crossPortal(direction);
}
function activateSceneRecord(index: number, keepMode = false): void {
  activeIndex = index;
  updateCaption();
  resizeStage();
  rebuildWorld();
  if (!keepMode) {
    currentMode = 'FLAT';
    depth = 0;
    updateDepthUI();
  }
}
function updateCurrentSceneMetadata(): void {
  updateCaption();
  updateLayerLegend();
  if (editorOpen) refreshEditorLayerList();
}
function resizeMaskCanvas(): void {
  if (!editorOpen || !maskContext) return;
  const ratio = Math.min(window.devicePixelRatio || 1, lowGpu ? 1 : 1.6);
  maskCanvas.width = Math.round(frameWidthPx * ratio);
  maskCanvas.height = Math.round(frameHeightPx * ratio);
  maskCanvas.style.width = `${frameWidthPx}px`;
  maskCanvas.style.height = `${frameHeightPx}px`;
  maskContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  drawMaskOverlay();
}
function drawMaskOverlay(): void {
  if (!maskContext) return;
  maskContext.clearRect(0, 0, frameWidthPx, frameHeightPx);
  const selected = currentScene();
  selected.layers.forEach((layer) => {
    if (layer.full || layer.points.length < 3) return;
    const isSelected = layer.id === selectedLayerId;
    maskContext!.beginPath();
    layer.points.forEach((point, index) => {
      const x = point.x * frameWidthPx;
      const y = point.y * frameHeightPx;
      if (index === 0) maskContext!.moveTo(x, y);
      else maskContext!.lineTo(x, y);
    });
    maskContext!.closePath();
    maskContext!.strokeStyle = ROLE_COLORS[layer.role];
    maskContext!.globalAlpha = isSelected ? 0.95 : 0.34;
    maskContext!.lineWidth = isSelected ? 1.5 : 1;
    maskContext!.setLineDash(isSelected ? [] : [4, 4]);
    maskContext!.stroke();
    if (isSelected) {
      layer.points.forEach((point) => {
        maskContext!.beginPath();
        maskContext!.arc(point.x * frameWidthPx, point.y * frameHeightPx, 3.4, 0, Math.PI * 2);
        maskContext!.fillStyle = ROLE_COLORS[layer.role];
        maskContext!.fill();
      });
    }
  });
  if (draftPoints.length) {
    maskContext.beginPath();
    draftPoints.forEach((point, index) => {
      const x = point.x * frameWidthPx;
      const y = point.y * frameHeightPx;
      if (index === 0) maskContext!.moveTo(x, y);
      else maskContext!.lineTo(x, y);
    });
    maskContext.strokeStyle = '#b9e6e6';
    maskContext.globalAlpha = 0.98;
    maskContext.lineWidth = 1.5;
    maskContext.setLineDash([5, 3]);
    maskContext.stroke();
    draftPoints.forEach((point, index) => {
      maskContext!.beginPath();
      maskContext!.arc(point.x * frameWidthPx, point.y * frameHeightPx, index === 0 ? 4.5 : 3, 0, Math.PI * 2);
      maskContext!.fillStyle = index === 0 ? '#e4d0a7' : '#b9e6e6';
      maskContext!.fill();
    });
  }
  maskContext.setLineDash([]);
  maskContext.globalAlpha = 1;
}
function setEditorOpen(open: boolean): void {
  editorOpen = open;
  editorShell.classList.toggle('open', open);
  editorShell.setAttribute('aria-hidden', String(!open));
  updateModeUI();
  if (!open) {
    drawingMask = false;
    maskClosed = false;
    draftPoints = [];
    selectedLayerId = null;
    editorShell.classList.remove('drawing');
  } else {
    refreshEditorLayerList();
    resizeMaskCanvas();
  }
}
function refreshEditorLayerList(): void {
  editorLayerList.innerHTML = '';
  currentScene().layers.forEach((layer, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `editor-layer-row${selectedLayerId === layer.id ? ' selected' : ''}`;
    row.setAttribute('aria-label', `Edit ${layer.name}`);
    const number = document.createElement('span');
    number.className = 'row-number';
    number.textContent = pad(index + 1);
    const copy = document.createElement('span');
    copy.innerHTML = `${escapeHtml(layer.name)}<small class="row-meta">${ROLE_LABELS[layer.role].toUpperCase()} · Z ${layer.z.toFixed(2)}</small>`;
    const remove = document.createElement('span');
    remove.className = 'delete-layer';
    remove.textContent = '×';
    remove.setAttribute('aria-hidden', 'true');
    row.append(number, copy, remove);
    row.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('.delete-layer')) {
        const fullSourceLayers = currentScene().layers.filter((item) => item.full);
        if (layer.full && fullSourceLayers.length <= 1) {
          showToast('Keep at least one full-source layer to preserve the original pixels.');
          return;
        }
        currentScene().layers = currentScene().layers.filter((item) => item.id !== layer.id);
        selectedLayerId = null;
        rebuildWorld();
        refreshEditorLayerList();
        drawMaskOverlay();
        updateCurrentSceneMetadata();
        schedulePersistence();
        return;
      }
      selectedLayerId = layer.id;
      drawingMask = false;
      maskClosed = false;
      draftPoints = [];
      editorShell.classList.remove('drawing');
      startMaskButton.textContent = '＋ START OUTLINE';
      roleSelect.value = layer.role;
      featherRange.value = String(layer.feather);
      $('featherValue').textContent = `${Number(layer.feather).toFixed(1)}%`;
      layerDistanceRange.value = String(layer.z);
      $('distanceValue').textContent = Number(layer.z).toFixed(2);
      saveMaskButton.disabled = layer.full || layer.points.length < 3;
      saveMaskButton.textContent = 'SAVE LAYER';
      refreshEditorLayerList();
      drawMaskOverlay();
    });
    editorLayerList.append(row);
  });
  layerCountLabel.textContent = pad(currentScene().layers.length);
}
function closeDraftOutline(): void {
  if (draftPoints.length < 3) {
    showToast('Add at least three points to close a region.');
    return;
  }
  drawingMask = false;
  maskClosed = true;
  editorShell.classList.remove('drawing');
  startMaskButton.textContent = '＋ NEW OUTLINE';
  saveMaskButton.disabled = false;
  saveMaskButton.textContent = 'SAVE REGION';
  drawMaskOverlay();
}
function saveMask(): void {
  const role = roleSelect.value as DepthRole;
  const feather = Number(featherRange.value);
  const z = Number(layerDistanceRange.value);
  if (maskClosed && draftPoints.length >= 3) {
    if (currentScene().layers.length >= 32) {
      showToast('A project supports up to 32 depth planes. Remove a plane before adding another.');
      return;
    }
    const label = ROLE_LABELS[role];
    const layer: DepthLayer = {
      id: `user-mask-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e5).toString(36)}`,
      name: `${label} · manual mask`,
      role,
      z,
      opacity: 0.98,
      feather,
      points: draftPoints.map((point) => ({ ...point })),
      custom: true,
      full: false,
    };
    currentScene().layers.push(layer);
    selectedLayerId = layer.id;
    draftPoints = [];
    maskClosed = false;
  } else if (selectedLayerId) {
    const selected = currentScene().layers.find((layer) => layer.id === selectedLayerId);
    if (!selected) return;
    selected.role = role;
    selected.z = z;
    selected.feather = feather;
    if (selected.custom) selected.name = `${ROLE_LABELS[role]} · manual mask`;
  } else {
    showToast('Draw and close a polygon before saving a region.');
    return;
  }
  rebuildWorld();
  refreshEditorLayerList();
  drawMaskOverlay();
  updateCurrentSceneMetadata();
  editorSaveStatus.textContent = 'Saved to this browser project.';
  showToast('Depth region saved. The visible pixels remain from the source image.');
  schedulePersistence();
}
function openEditor(): void {
  if (currentMode === 'CROSSING' || busy) return;
  const alignEditorToOriginal = () => {
    depth = 0;
    depthSlider.value = '0';
    depthSlider.style.setProperty('--slider-progress', '0%');
    depthOutput.textContent = '00';
    currentMode = 'FLAT';
    updateDepthUI();
    setEditorOpen(true);
    schedulePersistence();
    showToast('Trace a few points over the original image; press CLOSE OUTLINE when ready.');
  };
  if (currentMode === 'EXPLORE') {
    busy = true;
    updateModeUI();
    startCameraTween({ x: 0, y: 0, z: fitDistance, yaw: 0, pitch: 0 }, 1.05, () => {
      busy = false;
      alignEditorToOriginal();
    });
    return;
  }
  if (currentMode === 'PEEL') {
    const wasSeparated = depth > 0;
    if (wasSeparated) {
      busy = true;
      updateModeUI();
      startCameraTween({ x: 0, y: 0, z: fitDistance, yaw: 0, pitch: 0 }, 0.75, () => {
        busy = false;
        alignEditorToOriginal();
      });
      return;
    }
  }
  alignEditorToOriginal();
}
function roleNameFor(role: DepthRole): string {
  return ROLE_LABELS[role];
}
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
}
function saveProjectDebounced(): void {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { void persistProject(); }, 450);
}
function schedulePersistence(): void {
  if (storageUnavailable) return;
  saveProjectDebounced();
  if (editorOpen) editorSaveStatus.textContent = 'Unsaved changes · writing locally…';
}
function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available in this browser.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DB_STORE)) database.createObjectStore(DB_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open browser storage.'));
    request.onblocked = () => reject(new Error('Browser storage is blocked by another tab.'));
  });
  return dbPromise;
}
function readProjectRecord(database: IDBDatabase): Promise<ProjectSnapshot | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DB_STORE, 'readonly');
    const request = transaction.objectStore(DB_STORE).get(PROJECT_KEY);
    request.onsuccess = () => resolve(request.result as ProjectSnapshot | undefined);
    request.onerror = () => reject(request.error ?? new Error('Could not read the saved project.'));
  });
}
function writeProjectRecord(database: IDBDatabase, record: ProjectSnapshot): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DB_STORE, 'readwrite');
    transaction.objectStore(DB_STORE).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not save the project.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Project save was interrupted.'));
  });
}
async function restoreProject(): Promise<void> {
  try {
    const database = await openDatabase();
    const record = await readProjectRecord(database);
    if (!record || record.schemaVersion !== 1) return;
    const builtInMap = new Map(scenes.filter((scene) => scene.sourceKind !== 'upload').map((scene) => [scene.id, scene]));
    for (const stored of record.builtIns ?? []) {
      const scene = builtInMap.get(stored.id);
      if (scene) {
        scene.title = stored.title || scene.title;
        scene.subtitle = stored.subtitle || scene.subtitle;
        scene.layers = sanitizeLayers(stored.layers);
      }
    }
    const restoredUploads: SceneRecord[] = [];
    for (const upload of record.uploads ?? []) {
      if (!(upload.blob instanceof Blob)) continue;
      const objectUrl = URL.createObjectURL(upload.blob);
      const image = await makeImage(objectUrl);
      restoredUploads.push({
        id: upload.id,
        title: upload.title,
        subtitle: upload.subtitle,
        sourceName: upload.sourceName,
        sourceUrl: objectUrl,
        objectUrl,
        sourceBlob: upload.blob,
        sourceKind: 'upload',
        width: image.naturalWidth,
        height: image.naturalHeight,
        image,
        layers: sanitizeLayers(upload.layers),
      });
    }
    const all = [...scenes.filter((scene) => scene.sourceKind !== 'upload'), ...restoredUploads];
    const map = new Map(all.map((scene) => [scene.id, scene]));
    scenes = (record.order ?? []).map((id) => map.get(id)).filter((scene): scene is SceneRecord => Boolean(scene));
    all.forEach((scene) => { if (!scenes.some((existing) => existing.id === scene.id)) scenes.push(scene); });
    activeIndex = Math.max(0, scenes.findIndex((scene) => scene.id === record.activeSceneId));
    depth = boundedNumber(record.depth, 0, 0, 100);
    currentMode = depth > 0 ? 'PEEL' : 'FLAT';
  } catch (error) {
    storageUnavailable = true;
    setStatus('BROWSER STORAGE UNAVAILABLE · EXPORT TO KEEP CHANGES');
    console.warn('Project persistence is unavailable:', error);
    showToast('Local project storage is unavailable. Export a ZIP to keep imported artwork and masks.', 5000);
  }
}
async function persistProject(): Promise<void> {
  if (storageUnavailable) return;
  try {
    const database = await openDatabase();
    const uploads = scenes.filter((scene) => scene.sourceKind === 'upload');
    const uploadStates = uploads.map((scene) => {
      if (!scene.sourceBlob) throw new Error(`The original file for ${scene.sourceName} is not available.`);
      return {
        id: scene.id,
        title: scene.title,
        subtitle: scene.subtitle,
        sourceName: scene.sourceName,
        width: scene.width,
        height: scene.height,
        layers: cloneLayers(scene.layers),
        blob: scene.sourceBlob,
      };
    });
    const record: ProjectSnapshot = {
      id: PROJECT_KEY,
      schemaVersion: 1,
      updatedAt: Date.now(),
      order: scenes.map((scene) => scene.id),
      activeSceneId: currentScene().id,
      depth,
      builtIns: scenes.filter((scene) => scene.sourceKind !== 'upload').map((scene) => ({
        id: scene.id, title: scene.title, subtitle: scene.subtitle, layers: cloneLayers(scene.layers),
      })),
      uploads: uploadStates,
    };
    await writeProjectRecord(database, record);
    if (editorOpen) editorSaveStatus.textContent = 'Changes saved locally.';
    if (storageUnavailable) {
      storageUnavailable = false;
      setStatus('LOCAL PROJECT SAVED · ORIGINAL PIXELS PRESERVED');
    }
  } catch (error) {
    storageUnavailable = true;
    setStatus('BROWSER STORAGE UNAVAILABLE · EXPORT TO KEEP CHANGES');
    if (editorOpen) editorSaveStatus.textContent = 'Storage denied · export a ZIP to keep changes.';
    console.warn('Could not save the local project:', error);
    showToast('Storage was denied. Your current session still works; export a ZIP before closing.', 5000);
  }
}
function mimeForName(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'svg') return 'image/svg+xml';
  return 'application/octet-stream';
}
function safeArchiveName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'artwork';
}
async function sourceBlobFor(scene: SceneRecord): Promise<Blob> {
  if (scene.sourceBlob) return scene.sourceBlob;
  const response = await fetch(scene.sourceUrl);
  if (!response.ok) throw new Error(`Could not package ${scene.sourceName}.`);
  return response.blob();
}
async function exportProject(): Promise<void> {
  try {
    const { default: JSZip } = await import('jszip');
    const archive = new JSZip();
    const sourceManifest: Array<Record<string, unknown>> = [];
    for (const scene of scenes) {
      const fileName = safeArchiveName(scene.sourceName);
      const path = `artwork/${safeArchiveName(scene.id)}-${fileName}`;
      const blob = await sourceBlobFor(scene);
      archive.file(path, blob);
      sourceManifest.push({
        id: scene.id,
        title: scene.title,
        subtitle: scene.subtitle,
        sourceName: scene.sourceName,
        sourceKind: scene.sourceKind,
        sourcePath: path,
        mimeType: blob.type || mimeForName(scene.sourceName),
        width: scene.width,
        height: scene.height,
        layers: cloneLayers(scene.layers),
      });
    }
    const manifest = {
      format: 'world-between-two-frames',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      activeSceneId: currentScene().id,
      depth,
      order: scenes.map((scene) => scene.id),
      scenes: sourceManifest,
      provenance: 'Source images are included as provided. Layer masks are provisional spatial interpretations, not verified 3D reconstructions or canon claims.',
    };
    archive.file('manifest.json', JSON.stringify(manifest, null, 2));
    const blob = await archive.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 5 } });
    downloadBlob(blob, 'the-world-between-two-frames-project.zip');
    showToast('Project ZIP exported with original image files, layer masks, and provenance notes.');
  } catch (error) {
    console.error('Project export failed:', error);
    showToast(`Export failed: ${error instanceof Error ? error.message : 'unknown error'}.`, 5000);
  }
}
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function openProjectArchive(file: File): Promise<void> {
  try {
    if (file.size > 128 * 1024 * 1024) throw new Error('The project ZIP exceeds the 128 MB safety limit.');
    const { default: JSZip } = await import('jszip');
    const archive = await JSZip.loadAsync(file);
    const manifestFile = archive.file('manifest.json');
    if (!manifestFile) throw new Error('The ZIP does not contain manifest.json.');
    const manifest = JSON.parse(await manifestFile.async('string')) as {
      format?: string;
      schemaVersion?: number;
      activeSceneId?: string;
      depth?: number;
      order?: string[];
      scenes?: Array<Record<string, unknown>>;
    };
    if (manifest.format !== 'world-between-two-frames' || manifest.schemaVersion !== 1 || !Array.isArray(manifest.scenes)) {
      throw new Error('This project archive has an unsupported format or version.');
    }
    if (manifest.scenes.length > 6) throw new Error('A project can contain up to three bundled scenes and three imported images.');
    const sceneIds = manifest.scenes.map((scene) => String(scene?.id ?? ''));
    if (sceneIds.some((id) => !id) || new Set(sceneIds).size !== sceneIds.length) {
      throw new Error('The project manifest contains an empty or duplicate scene ID.');
    }
    const builtInMap = new Map(scenes.filter((scene) => scene.sourceKind !== 'upload').map((scene) => [scene.id, scene]));
    if (sceneIds.filter((id) => !builtInMap.has(id)).length > 3) throw new Error('A project may contain no more than three imported user images.');
    const parsed: SceneRecord[] = [];
    for (const raw of manifest.scenes) {
      const id = String(raw.id ?? '');
      const sourcePath = String(raw.sourcePath ?? '');
      const archivedFile = archive.file(sourcePath);
      if (!id || !sourcePath || !archivedFile) throw new Error(`A source image is missing from the ZIP (${sourcePath || 'unknown path'}).`);
      const sourceName = String(raw.sourceName ?? sourcePath.split('/').pop() ?? 'project-image.png');
      const mime = String(raw.mimeType ?? mimeForName(sourceName));
      const blob = new Blob([await archivedFile.async('arraybuffer')], { type: mime });
      const existing = builtInMap.get(id);
      if (existing) {
        existing.title = String(raw.title ?? existing.title);
        existing.subtitle = String(raw.subtitle ?? existing.subtitle);
        existing.layers = sanitizeLayers(raw.layers);
        parsed.push(existing);
      } else {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime.toLowerCase())) {
          throw new Error(`${sourceName} must be a PNG, JPEG, or WebP image.`);
        }
        const objectUrl = URL.createObjectURL(blob);
        const image = await makeImage(objectUrl);
        validateDimensions(image.naturalWidth, image.naturalHeight, sourceName);
        parsed.push({
          id,
          title: String(raw.title ?? titleFromFilename(sourceName)),
          subtitle: String(raw.subtitle ?? 'A provisional spatial reading of an imported image.'),
          sourceName,
          sourceUrl: objectUrl,
          objectUrl,
          sourceBlob: blob,
          sourceKind: 'upload',
          width: image.naturalWidth,
          height: image.naturalHeight,
          image,
          layers: sanitizeLayers(raw.layers),
        });
      }
    }
    const userCount = parsed.filter((scene) => scene.sourceKind === 'upload').length;
    if (userCount > 3) throw new Error('This archive contains more than three imported user images.');
    scenes.filter((scene) => scene.sourceKind === 'upload').forEach((scene) => { if (scene.objectUrl) URL.revokeObjectURL(scene.objectUrl); });
    const parsedMap = new Map(parsed.map((scene) => [scene.id, scene]));
    const order = (manifest.order ?? []).map((id) => parsedMap.get(id)).filter((scene): scene is SceneRecord => Boolean(scene));
    parsed.forEach((scene) => { if (!order.some((item) => item.id === scene.id)) order.push(scene); });
    builtInMap.forEach((scene) => { if (!order.some((item) => item.id === scene.id)) order.push(scene); });
    scenes = order;
    activeIndex = Math.max(0, scenes.findIndex((scene) => scene.id === manifest.activeSceneId));
    depth = boundedNumber(manifest.depth, 0, 0, 100);
    currentMode = depth > 0 ? 'PEEL' : 'FLAT';
    busy = false;
    cameraTween = null;
    updateCaption();
    resizeStage();
    rebuildWorld();
    updateDepthUI();
    setMenuOpen(false);
    setEditorOpen(false);
    await persistProject();
    showToast(`Opened project · ${parsed.length} source images and saved mask definitions restored.`, 4200);
  } catch (error) {
    console.error('Project import failed:', error);
    showToast(`Project could not be opened: ${error instanceof Error ? error.message : 'unknown error'}.`, 5200);
  }
}
function validateDimensions(width: number, height: number, name: string): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 160 || height < 120) {
    throw new Error(`${name} is too small. Images must be at least 160 × 120 pixels.`);
  }
  if (width > 12000 || height > 12000 || width * height > 80_000_000) {
    throw new Error(`${name} exceeds the 12,000 px side / 80 megapixel import limit.`);
  }
}
async function importImages(files: FileList | File[]): Promise<void> {
  const selected = Array.from(files);
  const existingCount = scenes.filter((scene) => scene.sourceKind === 'upload').length;
  const room = Math.max(0, 3 - existingCount);
  if (room === 0) {
    showToast('Three imported images are already in this project. Delete the imported project to make room.');
    return;
  }
  if (selected.length > room) showToast(`This project accepts up to three imported images; only the first ${room} will be checked.`, 4200);
  let accepted = 0;
  for (const file of selected.slice(0, room)) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type.toLowerCase())) {
      showToast(`${file.name}: use a PNG, JPEG, or WebP image.`, 4300);
      continue;
    }
    if (file.size > 32 * 1024 * 1024) {
      showToast(`${file.name}: the 32 MB per-image limit was exceeded.`, 4300);
      continue;
    }
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = await makeImage(objectUrl);
      validateDimensions(image.naturalWidth, image.naturalHeight, file.name);
      const id = `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const title = titleFromFilename(file.name);
      scenes.push({
        id,
        title,
        subtitle: 'A provisional, user-authored spatial interpretation.',
        sourceName: file.name,
        sourceUrl: objectUrl,
        objectUrl,
        sourceBlob: file,
        sourceKind: 'upload',
        width: image.naturalWidth,
        height: image.naturalHeight,
        image,
        layers: createGenericLayers(),
      });
      accepted += 1;
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      showToast(error instanceof Error ? error.message : `Could not read ${file.name}.`, 4500);
    }
  }
  if (accepted) {
    activeIndex = scenes.length - accepted;
    depth = 0;
    currentMode = 'FLAT';
    busy = false;
    cameraTween = null;
    updateCaption();
    resizeStage();
    rebuildWorld();
    updateDepthUI();
    setEditorOpen(false);
    showToast(`${accepted} image${accepted === 1 ? '' : 's'} added. Layer guides are provisional—use Edit Layers to draw your own mask.`, 4700);
    schedulePersistence();
  }
}
function resetDemo(): void {
  setMenuOpen(false);
  if (cameraTween) cameraTween = null;
  busy = false;
  depth = 0;
  depthSlider.value = '0';
  depthSlider.style.setProperty('--slider-progress', '0%');
  depthOutput.textContent = '00';
  const firstBuiltIn = scenes.findIndex((scene) => scene.id === 'attached-world');
  activeIndex = firstBuiltIn >= 0 ? firstBuiltIn : 0;
  currentMode = 'FLAT';
  cameraPose = { x: 0, y: 0, z: fitDistance, yaw: 0, pitch: 0 };
  setEditorOpen(false);
  updateCaption();
  rebuildWorld();
  updateDepthUI();
  showToast('Demo reset · imported images and saved masks were kept.');
  schedulePersistence();
}
function deleteImportedProject(): void {
  const uploads = scenes.filter((scene) => scene.sourceKind === 'upload');
  setMenuOpen(false);
  if (!uploads.length) {
    showToast('There are no imported project images to delete.');
    return;
  }
  if (!window.confirm(`Delete ${uploads.length} imported image${uploads.length === 1 ? '' : 's'} and their masks from this browser? The bundled demo artwork will remain.`)) return;
  uploads.forEach((scene) => { if (scene.objectUrl) URL.revokeObjectURL(scene.objectUrl); });
  scenes = scenes.filter((scene) => scene.sourceKind !== 'upload');
  activeIndex = clamp(activeIndex, 0, scenes.length - 1);
  depth = 0;
  currentMode = 'FLAT';
  busy = false;
  cameraTween = null;
  updateCaption();
  resizeStage();
  rebuildWorld();
  updateDepthUI();
  setEditorOpen(false);
  schedulePersistence();
  showToast('Imported images and their project data were removed. The demo scenes remain.');
}
function playSound(kind: 'peel' | 'enter' | 'cross'): void {
  if (!soundEnabled) return;
  try {
    audioContext ??= new AudioContext();
    if (audioContext.state === 'suspended') void audioContext.resume();
    const context = audioContext;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const filter = context.createBiquadFilter();
    oscillator.type = kind === 'cross' ? 'triangle' : 'sine';
    const start = kind === 'peel' ? 170 : kind === 'enter' ? 115 : 78;
    oscillator.frequency.setValueAtTime(start, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(42, start * 0.58), context.currentTime + (kind === 'cross' ? 0.42 : 0.24));
    filter.type = 'lowpass';
    filter.frequency.value = kind === 'cross' ? 380 : 520;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(kind === 'cross' ? 0.026 : 0.014, context.currentTime + 0.035);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + (kind === 'cross' ? 0.48 : 0.28));
    oscillator.connect(filter).connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + (kind === 'cross' ? 0.5 : 0.3));
  } catch (error) {
    console.warn('Audio could not start:', error);
  }
}
function setMenuOpen(open: boolean): void {
  const menu = $('projectMenu');
  menu.classList.toggle('open', open);
  menu.setAttribute('aria-hidden', String(!open));
  $('moreButton').setAttribute('aria-expanded', String(open));
}
function syncMobileUtilityLabels(): void {
  const soundMenuButton = $('menuSoundButton');
  if (soundMenuButton.firstChild) soundMenuButton.firstChild.textContent = soundEnabled ? 'SOUND ON ' : 'SOUND OFF ';
  soundMenuButton.setAttribute('aria-pressed', String(soundEnabled));
  const fullscreen = Boolean(document.fullscreenElement);
  const fullscreenMenuButton = $('menuFullscreenButton');
  if (fullscreenMenuButton.firstChild) fullscreenMenuButton.firstChild.textContent = fullscreen ? 'EXIT FULLSCREEN ' : 'ENTER FULLSCREEN ';
  fullscreenMenuButton.setAttribute('aria-label', fullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
}
function toggleSound(): void {
  soundEnabled = !soundEnabled;
  $('soundButton').classList.toggle('active', soundEnabled);
  $('soundButton').title = soundEnabled ? 'Subtle sound on' : 'Sound off';
  $('soundButton').setAttribute('aria-label', soundEnabled ? 'Disable subtle sound' : 'Enable subtle sound');
  $('soundButton').setAttribute('aria-pressed', String(soundEnabled));
  syncMobileUtilityLabels();
  if (soundEnabled) playSound('peel');
}
async function toggleFullscreen(): Promise<void> {
  try {
    if (!document.fullscreenElement) await $('app').requestFullscreen();
    else await document.exitFullscreen();
  } catch {
    showToast('Fullscreen is unavailable in this preview.');
  }
}
function enableLowGpu(enabled: boolean): void {
  lowGpu = enabled;
  $('gpuButton').classList.toggle('active', enabled);
  $('gpuButton').title = enabled ? 'Low GPU mode on' : 'Low GPU mode off';
  $('gpuButton').setAttribute('aria-pressed', String(enabled));
  resizeStage();
  if (worldGroup && currentScene().image) rebuildWorld();
  showToast(enabled ? 'Low GPU mode · reduced render resolution and particle count.' : 'Standard display quality restored.');
}
function setReducedMotion(enabled: boolean): void {
  reducedMotion = enabled;
  document.body.classList.toggle('reduce-motion', enabled);
  ($('reducedMotionToggle') as HTMLInputElement).checked = enabled;
  $('reducedMotionToggle').setAttribute('aria-checked', String(enabled));
  if (enabled && cameraTween) {
    const tween = cameraTween;
    cameraTween = null;
    applyPose(tween.to);
    // Complete the transition's state change as well as its pose; dropping the
    // callback here could leave `busy` latched and the mode stranded forever.
    tween.onComplete?.();
  }
}
function frameGripSide(clientX: number, clientY: number): GripSide | null {
  const rect = frameOutline.getBoundingClientRect();
  const tolerance = 24;
  const nearFrame = clientX >= rect.left - tolerance && clientX <= rect.right + tolerance
    && clientY >= rect.top - tolerance && clientY <= rect.bottom + tolerance;
  if (!nearFrame) return null;
  const distances: Array<[GripSide, number]> = [
    ['left', Math.abs(clientX - rect.left)],
    ['right', Math.abs(clientX - rect.right)],
    ['top', Math.abs(clientY - rect.top)],
    ['bottom', Math.abs(clientY - rect.bottom)],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][1] < tolerance ? distances[0][0] : null;
}
function drawFrameGrip(clientX: number, clientY: number): void {
  const active = pointerDown?.kind === 'depth' || (frameGripSide(clientX, clientY) !== null && currentMode === 'FLAT');
  frameOutline.classList.toggle('grip-active', active);
  sliderHint.classList.toggle('grip-hint', active);
}
function onCanvasPointerMove(event: PointerEvent): void {
  pointerX = clamp((event.clientX / window.innerWidth) * 2 - 1, -1, 1);
  pointerY = clamp((event.clientY / window.innerHeight) * 2 - 1, -1, 1);
  drawFrameGrip(event.clientX, event.clientY);
  if (pointerDown?.kind === 'depth') {
    const dx = event.clientX - pointerDown.x;
    const dy = event.clientY - pointerDown.y;
    const inward = pointerDown.side === 'left' ? dx
      : pointerDown.side === 'right' ? -dx
        : pointerDown.side === 'top' ? dy : -dy;
    const span = pointerDown.side === 'left' || pointerDown.side === 'right'
      ? Math.max(120, frameWidthPx * 0.46)
      : Math.max(90, frameHeightPx * 0.55);
    if (Math.abs(dx) + Math.abs(dy) > 4) pointerDown.moved = true;
    if (pointerDown.moved) setDepth(pointerDown.startDepth + inward * 100 / span, true);
  } else if (pointerDown?.kind === 'look' && currentMode === 'EXPLORE' && !busy && camera) {
    const dx = event.clientX - pointerDown.x;
    const dy = event.clientY - pointerDown.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) pointerDown.moved = true;
    if (pointerDown.moved) {
      cameraPose.yaw = clamp(pointerDown.yaw - dx * 0.0034, -0.85, 0.85);
      cameraPose.pitch = clamp(pointerDown.pitch - dy * 0.0032, -0.4, 0.4);
      applyPose(cameraPose);
    }
  }
}
function onCanvasPointerDown(event: PointerEvent): void {
  if (editorOpen || currentMode === 'CROSSING' || busy) return;
  if (currentMode === 'EXPLORE') {
    pointerDown = { kind: 'look', x: event.clientX, y: event.clientY, yaw: cameraPose.yaw, pitch: cameraPose.pitch, moved: false };
    canvas.setPointerCapture?.(event.pointerId);
    return;
  }
  if (currentMode === 'FLAT' || currentMode === 'PEEL') {
    const side = frameGripSide(event.clientX, event.clientY);
    if (!side) return;
    pointerDown = { kind: 'depth', x: event.clientX, y: event.clientY, side, startDepth: depth, moved: false };
    canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }
}
function tryRaycastPortal(clientX: number, clientY: number): void {
  if (!camera || currentMode !== 'EXPLORE' || portalEntries.length === 0) return;
  pointerNdc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, camera);
  const hits = raycaster.intersectObjects(portalEntries.map((portal) => portal.hit), false);
  const direction = hits[0]?.object.userData.direction as -1 | 1 | undefined;
  if (direction) crossPortal(direction);
}
function onCanvasPointerUp(event: PointerEvent): void {
  if (!pointerDown) return;
  const shouldRaycast = pointerDown.kind === 'look' && !pointerDown.moved;
  pointerDown = null;
  drawFrameGrip(event.clientX, event.clientY);
  if (shouldRaycast) tryRaycastPortal(event.clientX, event.clientY);
}
function handleWheel(event: WheelEvent): void {
  if (currentMode !== 'EXPLORE' || busy) return;
  event.preventDefault();
  const direction = Math.sign(event.deltaY);
  setExplorePose({ z: cameraPose.z + direction * imageWorldHeight * 0.065 });
}
function addPolygonPoint(event: PointerEvent): void {
  if (!drawingMask || !maskClosed && !editorOpen) return;
  const rect = maskCanvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const point = { x: clamp((event.clientX - rect.left) / rect.width, 0, 1), y: clamp((event.clientY - rect.top) / rect.height, 0, 1) };
  if (draftPoints.length >= 24) {
    showToast('A manual region is limited to 24 points. Close the outline or undo a point.');
    return;
  }
  draftPoints.push(point);
  saveMaskButton.disabled = true;
  $('undoPointButton').removeAttribute('disabled');
  drawMaskOverlay();
}
function bindEvents(): void {
  $('importButton').addEventListener('click', () => imageInput.click());
  $('openProjectButton').addEventListener('click', () => projectInput.click());
  $('exportButton').addEventListener('click', () => { void exportProject(); });
  $('layersButton').addEventListener('click', openEditor);
  $('closeEditor').addEventListener('click', () => setEditorOpen(false));
  $('startMaskButton').addEventListener('click', () => {
    if (drawingMask) {
      closeDraftOutline();
      return;
    }
    selectedLayerId = null;
    draftPoints = [];
    maskClosed = false;
    drawingMask = true;
    editorShell.classList.add('drawing');
    startMaskButton.textContent = 'CLOSE OUTLINE';
    saveMaskButton.disabled = true;
    saveMaskButton.textContent = 'SAVE REGION';
    $('undoPointButton').setAttribute('disabled', '');
    roleSelect.value = 'foreground';
    layerDistanceRange.value = String(ROLE_DEFAULT_Z.foreground);
    $('distanceValue').textContent = ROLE_DEFAULT_Z.foreground.toFixed(2);
    drawMaskOverlay();
    maskCanvas.focus?.();
  });
  $('undoPointButton').addEventListener('click', () => {
    if (draftPoints.length) draftPoints.pop();
    $('undoPointButton').toggleAttribute('disabled', draftPoints.length === 0);
    drawMaskOverlay();
  });
  $('clearMaskButton').addEventListener('click', () => {
    draftPoints = [];
    drawingMask = false;
    maskClosed = false;
    editorShell.classList.remove('drawing');
    startMaskButton.textContent = '＋ START OUTLINE';
    saveMaskButton.disabled = true;
    $('undoPointButton').setAttribute('disabled', '');
    drawMaskOverlay();
  });
  saveMaskButton.addEventListener('click', saveMask);
  roleSelect.addEventListener('change', () => {
    const role = roleSelect.value as DepthRole;
    if (drawingMask || !selectedLayerId) {
      layerDistanceRange.value = String(ROLE_DEFAULT_Z[role]);
      $('distanceValue').textContent = ROLE_DEFAULT_Z[role].toFixed(2);
    }
    if (selectedLayerId) saveMaskButton.disabled = false;
  });
  featherRange.addEventListener('input', () => { $('featherValue').textContent = `${Number(featherRange.value).toFixed(1)}%`; });
  layerDistanceRange.addEventListener('input', () => { $('distanceValue').textContent = Number(layerDistanceRange.value).toFixed(2); });
  maskCanvas.addEventListener('pointerdown', (event) => {
    if (!drawingMask) return;
    event.preventDefault();
    addPolygonPoint(event);
  });
  maskCanvas.addEventListener('dblclick', (event) => { event.preventDefault(); closeDraftOutline(); });
  depthSlider.addEventListener('input', () => setDepth(Number(depthSlider.value), true));
  enterButton.addEventListener('click', enterImage);
  $('returnButton').addEventListener('click', () => returnToFrame(currentMode === 'PEEL'));
  $('resetButton').addEventListener('click', () => {
    returnToFrame(true);
    showToast('Returned to the unaltered source image. Imported artwork remains in the project.');
  });
  $('approachPortal').addEventListener('click', approachPortal);
  $('approachPrevious').addEventListener('click', () => crossPortal(-1));
  $('moveLeft').addEventListener('click', () => moveExplore(-1, 0, 0));
  $('moveRight').addEventListener('click', () => moveExplore(1, 0, 0));
  $('moveForward').addEventListener('click', () => moveExplore(0, 0, -1));
  $('moveBack').addEventListener('click', () => moveExplore(0, 0, 1));
  imageInput.addEventListener('change', () => {
    if (imageInput.files) void importImages(imageInput.files);
    imageInput.value = '';
  });
  projectInput.addEventListener('change', () => {
    const file = projectInput.files?.[0];
    if (file) void openProjectArchive(file);
    projectInput.value = '';
  });
  $('moreButton').addEventListener('click', () => setMenuOpen(!$('projectMenu').classList.contains('open')));
  $('menuOpenProjectButton').addEventListener('click', () => {
    setMenuOpen(false);
    projectInput.click();
  });
  $('menuExportButton').addEventListener('click', () => {
    setMenuOpen(false);
    void exportProject();
  });
  $('menuSoundButton').addEventListener('click', toggleSound);
  $('menuFullscreenButton').addEventListener('click', () => {
    setMenuOpen(false);
    void toggleFullscreen();
  });
  document.addEventListener('pointerdown', (event) => {
    const menu = $('projectMenu');
    if (menu.classList.contains('open') && !(event.target as HTMLElement).closest('#projectMenu,#moreButton')) setMenuOpen(false);
  });
  $('resetDemoButton').addEventListener('click', resetDemo);
  $('deleteProjectButton').addEventListener('click', deleteImportedProject);
  $('reducedMotionToggle').addEventListener('change', (event) => setReducedMotion((event.target as HTMLInputElement).checked));
  $('soundButton').addEventListener('click', toggleSound);
  $('gpuButton').addEventListener('click', () => enableLowGpu(!lowGpu));
  $('fullscreenButton').addEventListener('click', () => { void toggleFullscreen(); });
  canvas.addEventListener('pointermove', onCanvasPointerMove);
  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  canvas.addEventListener('pointerup', onCanvasPointerUp);
  canvas.addEventListener('pointercancel', (event) => {
    pointerDown = null;
    drawFrameGrip(event.clientX, event.clientY);
  });
  canvas.addEventListener('wheel', handleWheel, { passive: false });
  window.addEventListener('resize', resizeStage);
  window.addEventListener('keydown', (event) => {
    if (isEditableTarget(event.target)) return;
    if (editorOpen && event.key === 'Escape') {
      setEditorOpen(false);
      return;
    }
    if (event.key === 'Escape') {
      if (currentMode === 'EXPLORE' || currentMode === 'CROSSING') returnToFrame(false);
      else if (depth > 0) setDepth(0);
      setMenuOpen(false);
      return;
    }
    if (event.key === ' ' && (currentMode === 'FLAT' || currentMode === 'PEEL')) {
      event.preventDefault();
      enterImage();
      return;
    }
    if (event.key === 'f' || event.key === 'F') {
      void $('fullscreenButton').click();
      return;
    }
    if (currentMode === 'EXPLORE') {
      if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'a') moveExplore(-1, 0, 0);
      else if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'd') moveExplore(1, 0, 0);
      else if (event.key === 'ArrowUp' || event.key.toLowerCase() === 'w') moveExplore(0, 0, -1);
      else if (event.key === 'ArrowDown' || event.key.toLowerCase() === 's') moveExplore(0, 0, 1);
      else if (event.key === '+' || event.key === '=') moveExplore(1, 0, 0);
      else if (event.key === '-') moveExplore(-1, 0, 0);
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.preventDefault();
    } else if (event.key === '+' || event.key === '=') setDepth(depth + 5, true);
    else if (event.key === '-') setDepth(depth - 5, true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseAnimation();
    else startAnimation();
  });
  document.addEventListener('fullscreenchange', () => {
    const isFullscreen = Boolean(document.fullscreenElement);
    $('fullscreenButton').textContent = isFullscreen ? '⤡' : '⤢';
    $('fullscreenButton').setAttribute('aria-label', isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
    syncMobileUtilityLabels();
    window.setTimeout(resizeStage, 60);
  });
  window.addEventListener('error', (event) => {
    console.error('Runtime error:', event.error ?? event.message);
    if (event.error) showToast('A rendering error occurred. Try resetting the image or switching to low GPU mode.', 4500);
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled app error:', event.reason);
    showToast('An app operation failed. Your source image remains unchanged.', 4300);
  });
}
function initRenderer(): boolean {
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setClearColor(0x080a0d, 1);
    threeScene = new THREE.Scene();
    threeScene.background = new THREE.Color(0x080a0d);
    camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, window.innerWidth / window.innerHeight, 0.05, 160);
    camera.position.set(0, 0, 12);
    worldGroup = new THREE.Group();
    threeScene.add(worldGroup);
    return true;
  } catch (error) {
    console.error('WebGL renderer initialization failed:', error);
    showToast('WebGL is unavailable in this browser. Try a browser with hardware acceleration enabled.', 7000);
    return false;
  }
}
async function initialize(): Promise<void> {
  const rendered = initRenderer();
  bindEvents();
  try {
    const loaded = await Promise.all(scenes.map(async (scene) => {
      scene.image = await makeImage(scene.sourceUrl);
      scene.width = scene.image.naturalWidth;
      scene.height = scene.image.naturalHeight;
      return scene;
    }));
    scenes = loaded;
    await restoreProject();
    if (rendered) {
      updateCaption();
      resizeStage();
      rebuildWorld();
      updateDepthUI();
      startAnimation();
    } else {
      updateCaption();
    }
    const loading = $('loadingScreen');
    window.setTimeout(() => loading.classList.add('done'), 320);
    if (depth > 0) showToast('Last local project restored. Use Reset to Original Art to return to a flat frame.', 3500);
  } catch (error) {
    console.error('Could not initialize the image sequence:', error);
    showToast('One of the bundled images could not be loaded. Refresh the preview or restore the source files.', 6500);
    $('loadingScreen').classList.add('done');
  }
}

if (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || new URLSearchParams(location.search).has('wbtf-debug')) {
  Object.assign(window, { __WBTF_DEBUG__: () => ({ mode: currentMode, busy, depth, running, hidden: document.hidden, tweenElapsed: cameraTween?.elapsed ?? null, tweenDuration: cameraTween?.duration ?? null, z: camera?.position.z ?? null }) });
}
setReducedMotion(reducedMotion);
syncMobileUtilityLabels();
void initialize();

// ---- Installable app (PWA): offline service worker + optional install button ----
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
let deferredInstall: BeforeInstallPromptEvent | null = null;
const installButton = document.getElementById('installButton') as HTMLButtonElement | null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstall = event as BeforeInstallPromptEvent;
  if (installButton) installButton.hidden = false;
});
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  if (installButton) installButton.hidden = true;
  showToast('Installed. Open The World Between Two Frames from your home screen.', 3500);
});
installButton?.addEventListener('click', async () => {
  if (!deferredInstall) return;
  const prompt = deferredInstall;
  deferredInstall = null;
  installButton.hidden = true;
  await prompt.prompt();
  await prompt.userChoice.catch(() => undefined);
});
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .catch((error) => console.warn('Offline support unavailable:', error));
  });
}
