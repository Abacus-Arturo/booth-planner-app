import React, { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";

// ===================== Units =====================
const UNITS = {
  m: { label: "m", toMeters: 1 },
  ft: { label: "ft", toMeters: 0.3048 },
  in: { label: "in", toMeters: 0.0254 },
  cm: { label: "cm", toMeters: 0.01 },
};
const metersTo = (m, u) => m / UNITS[u].toMeters;
const toMeters = (v, u) => v * UNITS[u].toMeters;
const fmt = (n) => (Math.round(n * 100) / 100).toString();

// ===================== Default manifest (used if no GitHub URL given) =====================
// In production this comes from /models/manifest.json in your repo:
// [{ id, name, file, w, d, h, color, sockets:[{name, accessoryId}] }, ...]
const DEFAULT_MANIFEST = [
  { id: "backdrop_straight", name: "Straight Backdrop", file: null, w: 3, d: 0.2, h: 2.4, color: "#3a6ea5", sockets: ["socket_lamp", "socket_shelf"] },
  { id: "backdrop_curve", name: "Curved Backdrop", file: null, w: 2.4, d: 0.6, h: 2.4, color: "#3a6ea5", sockets: ["socket_lamp"] },
  { id: "booth_moduluxe_a", name: "Booth Moduluxe A", file: null, w: 2, d: 2, h: 2.6, color: "#c4622d", sockets: ["socket_shelf"] },
  { id: "booth_moduluxe_b", name: "Booth Moduluxe B", file: null, w: 3, d: 1.5, h: 2.6, color: "#c4622d", sockets: [] },
  { id: "counter", name: "Counter", file: null, w: 1.2, d: 0.6, h: 1.05, color: "#777777", sockets: [] },
];

const PRIMITIVES = [
  { id: "prim_box", name: "Cube", kind: "box", w: 1, d: 1, h: 1 },
  { id: "prim_cyl", name: "Cylinder", kind: "cylinder", w: 1, d: 1, h: 1.5 },
  { id: "prim_sphere", name: "Sphere", kind: "sphere", w: 1, d: 1, h: 1 },
  { id: "prim_plane", name: "Plane", kind: "plane", w: 1, d: 1, h: 0.02 },
];

// Props: objetos pequeños con posición/altura libres, que se pueden "pegar" (attach) a otro objeto arrastrándolos encima.
const PROPS = [
  { id: "prop_plant", name: "Plant", kind: "cylinder", w: 0.4, d: 0.4, h: 0.7, color: "#3f7d44" },
  { id: "prop_screen", name: "Screen", kind: "box", w: 0.9, d: 0.06, h: 0.55, color: "#1a1a1a" },
  { id: "prop_sign", name: "Sign", kind: "box", w: 0.5, d: 0.05, h: 0.3, color: "#d9c46a" },
  { id: "prop_chair", name: "Chair", kind: "box", w: 0.45, d: 0.45, h: 0.45, color: "#8a5a3b" },
];

function isRepeatableSocket(socketName) {
  return socketName.includes("shelf");
}
// sockets en el manifest pueden ser string ("socket_shelf") u objeto ({name, accessoryFile})
function getSocketName(s) { return typeof s === "string" ? s : s.name; }
function getSocketAccessoryFile(s) { return typeof s === "string" ? null : (s.accessoryFile || null); }

function buildWallMesh(wall) {
  const dx = wall.x2 - wall.x1, dz = wall.z2 - wall.z1;
  const len = Math.sqrt(dx * dx + dz * dz) || 0.01;
  const angle = Math.atan2(dx, dz) - Math.PI / 2;
  const h = wall.height, gr = Math.min(Math.max(wall.glassRatio, 0), 1);
  const solidH = h * (1 - gr), glassH = h * gr;
  const t = wall.thickness;
  const group = new THREE.Group();
  group.position.set((wall.x1 + wall.x2) / 2, 0, (wall.z1 + wall.z2) / 2);
  group.rotation.y = angle;
  // solid part
  if (solidH > 0.001) {
    const solidMat = new THREE.MeshStandardMaterial({ color: wall.color || "#cccccc", roughness: 0.8, metalness: 0.05 });
    const solid = new THREE.Mesh(new THREE.BoxGeometry(len, solidH, t), solidMat);
    solid.position.y = solidH / 2;
    solid.castShadow = true; solid.receiveShadow = true;
    group.add(solid);
  }
  // glass part
  if (glassH > 0.001) {
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0xddeeff, transparent: true, opacity: 0.25,
      roughness: 0, metalness: 0.05,
      transmission: 0.88, thickness: t, ior: 1.5,
      side: THREE.DoubleSide,
    });
    const glass = new THREE.Mesh(new THREE.BoxGeometry(len, glassH, t * 0.4), glassMat);
    glass.position.y = solidH + glassH / 2;
    group.add(glass);
  }
  group.userData.isWall = true;
  return group;
}

function buildOutlineBox(w, h, d) {
  const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(w * 1.12 + 0.03, h * 1.12 + 0.03, d * 1.12 + 0.03));
  const mat = new THREE.LineBasicMaterial({ color: 0xff6a00, linewidth: 2, depthTest: false });
  const line = new THREE.LineSegments(geo, mat);
  line.renderOrder = 999;
  line.userData.isOutline = true;
  line.raycast = () => {}; // nunca debe ser clickeable/seleccionable — solo es un indicador visual
  return line;
}

function buildPlaceholderGeometry(kind, w, d, h) {
  switch (kind) {
    case "cylinder": return new THREE.CylinderGeometry(w / 2, w / 2, h, 24);
    case "sphere": return new THREE.SphereGeometry(w / 2, 24, 16);
    case "plane": return new THREE.BoxGeometry(w, 0.02, d);
    default: return new THREE.BoxGeometry(w, h, d);
  }
}

// (entorno reflejante removido por ahora — causaba pantalla negra; usamos luces directas)

// ===================== Mini GLB loader propio (sin dependencias externas) =====================
// Soporta: .glb binario embebido (geometría POSITION/NORMAL/TEXCOORD_0/indices,
// jerarquía de nodos con nombres, material baseColorFactor + baseColorTexture).
// No soporta: skinning/animaciones, .gltf+bin separados, texturas no embebidas.

const COMPONENT_TYPES = {
  5120: { array: Int8Array, size: 1 },
  5121: { array: Uint8Array, size: 1 },
  5122: { array: Int16Array, size: 2 },
  5123: { array: Uint16Array, size: 2 },
  5125: { array: Uint32Array, size: 4 },
  5126: { array: Float32Array, size: 4 },
};
const TYPE_SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function parseGLB(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const magic = dv.getUint32(0, true);
  if (magic !== 0x46546c67) throw new Error("Not a valid .glb (incorrect magic number)");
  const length = dv.getUint32(8, true);
  let offset = 12;
  let json = null, bin = null;
  while (offset < length) {
    const chunkLength = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    if (chunkType === 0x4e4f534a) { // 'JSON'
      const text = new TextDecoder("utf-8").decode(new Uint8Array(arrayBuffer, chunkStart, chunkLength));
      json = JSON.parse(text);
    } else if (chunkType === 0x004e4942) { // 'BIN\0'
      bin = arrayBuffer.slice(chunkStart, chunkStart + chunkLength);
    }
    offset = chunkStart + chunkLength;
  }
  return { json, bin };
}

function readAccessor(json, bin, accessorIndex) {
  const accessor = json.accessors[accessorIndex];
  const bufferView = json.bufferViews[accessor.bufferView];
  const { array: ArrType, size: compSize } = COMPONENT_TYPES[accessor.componentType];
  const numComponents = TYPE_SIZES[accessor.type];
  const byteOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
  const count = accessor.count;
  const out = new Float32Array(count * numComponents);
  const stride = bufferView.byteStride || numComponents * compSize;
  const dv = new DataView(bin, byteOffset);
  for (let i = 0; i < count; i++) {
    const base = i * stride;
    for (let c = 0; c < numComponents; c++) {
      const byteIdx = base + c * compSize;
      let val;
      if (ArrType === Float32Array) val = dv.getFloat32(byteIdx, true);
      else if (ArrType === Uint16Array) val = dv.getUint16(byteIdx, true);
      else if (ArrType === Uint32Array) val = dv.getUint32(byteIdx, true);
      else if (ArrType === Int16Array) val = dv.getInt16(byteIdx, true);
      else if (ArrType === Uint8Array) val = dv.getUint8(byteIdx, true);
      else val = dv.getInt8(byteIdx, true);
      out[i * numComponents + c] = val;
    }
  }
  return { array: out, itemSize: numComponents };
}

async function buildTextureFromImage(json, bin, textureIndex) {
  try {
    const tex = json.textures[textureIndex];
    const image = json.images[tex.source];
    if (image.bufferView == null) return null; // solo soportamos imágenes embebidas
    const bv = json.bufferViews[image.bufferView];
    const start = bv.byteOffset || 0;
    const blob = new Blob([new Uint8Array(bin, start, bv.byteLength)], { type: image.mimeType || "image/png" });
    const bitmap = await createImageBitmap(blob);
    const texture = new THREE.Texture(bitmap);
    texture.needsUpdate = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  } catch (err) {
    console.error("Could not decode an embedded texture:", err);
    return null;
  }
}

async function buildMaterial(json, bin, materialIndex) {
  if (materialIndex == null || !json.materials) return new THREE.MeshStandardMaterial({ color: 0x999999, roughness: 0.5, metalness: 0.1 });
  const m = json.materials[materialIndex] || {};
  const pbr = m.pbrMetallicRoughness || {};
  const baseColor = pbr.baseColorFactor || [1, 1, 1, 1];
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(baseColor[0], baseColor[1], baseColor[2]),
    roughness: pbr.roughnessFactor != null ? pbr.roughnessFactor : 0.6,
    metalness: pbr.metallicFactor != null ? pbr.metallicFactor : 0.1,
    transparent: baseColor[3] < 1,
    opacity: baseColor[3] != null ? baseColor[3] : 1,
  });
  // preservar el nombre del material (necesario para paint_color y otros lookups por nombre)
  if (m.name) mat.name = m.name;
  if (pbr.baseColorTexture) {
    const tex = await buildTextureFromImage(json, bin, pbr.baseColorTexture.index);
    if (tex) mat.map = tex;
  }
  return mat;
}

async function buildMeshObject(json, bin, meshIndex, materialCache) {
  const meshDef = json.meshes[meshIndex];
  const group = new THREE.Group();
  for (const prim of meshDef.primitives) {
    const geo = new THREE.BufferGeometry();
    const posAcc = readAccessor(json, bin, prim.attributes.POSITION);
    geo.setAttribute("position", new THREE.BufferAttribute(posAcc.array, posAcc.itemSize));
    if (prim.attributes.NORMAL != null) {
      const n = readAccessor(json, bin, prim.attributes.NORMAL);
      geo.setAttribute("normal", new THREE.BufferAttribute(n.array, n.itemSize));
    } else {
      geo.computeVertexNormals();
    }
    if (prim.attributes.TEXCOORD_0 != null) {
      const uv = readAccessor(json, bin, prim.attributes.TEXCOORD_0);
      geo.setAttribute("uv", new THREE.BufferAttribute(uv.array, uv.itemSize));
    }
    if (prim.indices != null) {
      const idx = readAccessor(json, bin, prim.indices);
      geo.setIndex(Array.from(idx.array));
    }
    let mat = materialCache.get(prim.material);
    if (!mat) {
      mat = await buildMaterial(json, bin, prim.material);
      materialCache.set(prim.material, mat);
    }
    const mesh = new THREE.Mesh(geo, mat);
    group.add(mesh);
  }
  return group;
}

async function buildNode(json, bin, nodeIndex, materialCache) {
  const nodeDef = json.nodes[nodeIndex];
  const obj = new THREE.Object3D();
  if (nodeDef.name) obj.name = nodeDef.name;
  if (nodeDef.matrix) {
    obj.matrix.fromArray(nodeDef.matrix);
    obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
  } else {
    if (nodeDef.translation) obj.position.set(...nodeDef.translation);
    if (nodeDef.rotation) obj.quaternion.set(...nodeDef.rotation);
    if (nodeDef.scale) obj.scale.set(...nodeDef.scale);
  }
  if (nodeDef.mesh != null) {
    const meshObj = await buildMeshObject(json, bin, nodeDef.mesh, materialCache);
    obj.add(meshObj);
  }
  if (nodeDef.children) {
    for (const childIdx of nodeDef.children) {
      obj.add(await buildNode(json, bin, childIdx, materialCache));
    }
  }
  return obj;
}

async function buildSceneFromGLTF(json, bin) {
  const materialCache = new Map();
  const sceneDef = json.scenes[json.scene || 0];
  const root = new THREE.Group();
  for (const nodeIdx of sceneDef.nodes) {
    root.add(await buildNode(json, bin, nodeIdx, materialCache));
  }
  return root;
}

const modelCache = new Map(); // url -> Promise<THREE.Group> (escena raíz original, sin clonar)

function loadModelOnce(url) {
  if (modelCache.has(url)) return modelCache.get(url);
  const promise = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} cargando ${url}`);
      return res.arrayBuffer();
    })
    .then((buf) => {
      const { json, bin } = parseGLB(buf);
      return buildSceneFromGLTF(json, bin);
    });
  modelCache.set(url, promise);
  return promise;
}

function getModelClone(url) {
  return loadModelOnce(url).then((scene) => {
    const clone = scene.clone(true);
    // clone(true) clona la geometría pero los materiales se comparten por referencia
    // en Three.js r128+. Necesitamos que cada clon tenga su propio material
    // para poder tintar paint_color de forma independiente por instancia.
    clone.traverse((child) => {
      if (!child.isMesh) return;
      if (Array.isArray(child.material)) {
        child.material = child.material.map((m) => {
          const c = m.clone();
          c.name = m.name; // preservar nombre (se pierde en .clone() en algunas versiones)
          return c;
        });
      } else if (child.material) {
        const c = child.material.clone();
        c.name = child.material.name;
        child.material = c;
      }
    });
    return clone;
  });
}

function measureModelDims(url) {
  // Carga el modelo (cacheado) y mide su bounding box local, sin agregarlo a ninguna escena visible.
  return loadModelOnce(url).then((scene) => {
    const tempParent = new THREE.Group();
    const clone = scene.clone(true);
    tempParent.add(clone);
    const box = new THREE.Box3().setFromObject(clone);
    const size = box.getSize(new THREE.Vector3());
    tempParent.remove(clone);
    return { w: size.x, h: size.y, d: size.z };
  });
}

// ---- Line tool color variation ----
// HUE_SHIFT_DEG: grados de rotación de tono para las piezas alternas.
// Prueba valores entre 10 y 60. Ejemplos: 15 = sutil, 30 = notable, 45 = muy diferenciado
const HUE_SHIFT_DEG = 30;

function varyColor(hexColor, index) {
  if (index % 2 === 0) return hexColor; // piezas pares = color original
  const c = new THREE.Color(hexColor);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  const newHue = (hsl.h + HUE_SHIFT_DEG / 360) % 1;
  // si la saturación es muy baja el hue shift no se ve — mínimo 0.5 para que sea visible
  const minSat = 0.5;
  const newSat = Math.max(hsl.s, minSat);
  c.setHSL(newHue, newSat, hsl.l);
  return `#${c.getHexString()}`;
}

function generateThumbnail(scene3DObject, color) {
  return new Promise((resolve) => {
    try {
      const SIZE = 128;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setSize(SIZE, SIZE);
      renderer.setPixelRatio(2);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.2;
      renderer.shadowMap.enabled = true;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x13162a);

      // Lights
      scene.add(new THREE.AmbientLight(0xffffff, 0.6));
      const key = new THREE.DirectionalLight(0xffffff, 2.0);
      key.position.set(3, 5, 3);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0xbbd4ff, 0.5);
      fill.position.set(-3, 2, -2);
      scene.add(fill);

      // Clone and add object
      const obj = scene3DObject.clone(true);
      scene.add(obj);

      // Fit camera to object
      const box = new THREE.Box3().setFromObject(obj);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;

      const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
      const dist = maxDim * 2.2;
      camera.position.set(center.x + dist * 0.7, center.y + dist * 0.6, center.z + dist * 0.7);
      camera.lookAt(center);

      renderer.render(scene, camera);
      const dataURL = renderer.domElement.toDataURL("image/png");
      renderer.dispose();
      resolve(dataURL);
    } catch (e) {
      resolve(null);
    }
  });
}

export default function BoothPlannerV2() {
  const mountRef = useRef(null);
  const threeRef = useRef({});
  const [unit, setUnit] = useState("m");
  const [floorW, setFloorW] = useState(10);
  const [floorD, setFloorD] = useState(8);
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const [editingName, setEditingName] = useState(false);
  const [showCameraPanel, setShowCameraPanel] = useState(false);
  const [projectName, setProjectName] = useState("Untitled Layout");
  const [showSaveModal, setShowSaveModal] = useState(false); // "saved" | null
  const historyRef = useRef([]);
  const historyIndexRef = useRef(-1);
  const skipHistoryRef = useRef(false);
  const MAX_HISTORY = 50;

  const pushHistory = useCallback((newItems, newWalls) => {
    if (skipHistoryRef.current) return;
    historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1);
    historyRef.current.push({ items: newItems, walls: newWalls });
    if (historyRef.current.length > MAX_HISTORY) historyRef.current.shift();
    historyIndexRef.current = historyRef.current.length - 1;
  }, []);

  const AUTOSAVE_KEY = "boothplanner_autosave";
  const floorWRef = useRef(10);
  const floorDRef = useRef(8);
  useEffect(() => { floorWRef.current = floorW; }, [floorW]);
  useEffect(() => { floorDRef.current = floorD; }, [floorD]);

  // Floor appearance
  const [floorColor, setFloorColor] = useState("#e9e9e9");

  // Floor plan image
  const [floorPlan, setFloorPlan] = useState(null); // { dataUrl, realW, realH, opacity, x, z, visible }
  const [floorPlanModal, setFloorPlanModal] = useState(null); // { step: 'calibrate'|'outline', dataUrl, ... }
  const floorPlanFileRef = useRef(null);
  const [manifestUrl, setManifestUrl] = useState("https://raw.githubusercontent.com/Abacus-Arturo/booth-planner-library/main/models/manifest.json");
  const [catalog, setCatalog] = useState(DEFAULT_MANIFEST);
  const findDef = useCallback((kindCategory, catalogId) => {
    if (kindCategory === "model") return catalog.find((c) => c.id === catalogId);
    if (kindCategory === "primitive") return PRIMITIVES.find((p) => p.id === catalogId);
    if (kindCategory === "prop") {
      return PROPS.find((p) => p.id === catalogId) ||
             catalog.find((c) => c.id === catalogId && c.category === "Props");
    }
    return null;
  }, [catalog]);
  const findDefRef = useRef(findDef);
  useEffect(() => { findDefRef.current = findDef; }, [findDef]);
  const [items, setItems] = useState([]); // {uid, catalogId, kind, x,z,rotY,color,sockets,groupId}
  const [walls, setWalls] = useState([]); // {uid, x1,z1,x2,z2, height, glassRatio, thickness, color}
  const wallsRef = useRef(walls);
  useEffect(() => { wallsRef.current = walls; }, [walls]);
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);

  // Guardar snapshot en historial cuando cambian items o walls (con debounce)
  useEffect(() => {
    const t = setTimeout(() => pushHistory(items, walls), 300);
    return () => clearTimeout(t);
  }, [items, walls, pushHistory]);
  const [selectedUids, setSelectedUids] = useState([]); // array de uids
  const [selectedWallUid, setSelectedWallUid] = useState(null);
  const draggingWallHandleRef = useRef(null); // { type, wallUid/groupId/sourceUid, endpoint/role }
  const arrayHandleActiveRef = useRef(false); // true cuando estamos en modo array desde handle
  const arrayHandleSourceRef = useRef(null); // { uid, x, z, catalogId, kind, color, rotY } del objeto original
  const selectedUid = selectedUids.length ? selectedUids[selectedUids.length - 1] : null;
  const [dragCatalog, setDragCatalog] = useState(null);
  const [cameras, setCameras] = useState([]);
  const [arrayCount, setArrayCount] = useState(3);
  const [arraySpacing, setArraySpacing] = useState(1.5);
  const [activeView, setActiveView] = useState("free");
  const setViewUIRef = useRef(null);
  useEffect(() => { setViewUIRef.current = setActiveView; }, []);
  const [showReplaceMenu, setShowReplaceMenu] = useState(false);
  const [pendingLineDef, setPendingLineDef] = useState(null); // {def, kind}
  const [wallToolActive, setWallToolActive] = useState(false);
  const [wallConfig, setWallConfig] = useState({ height: 2.4, glassRatio: 0, thickness: 0.1, color: "#cccccc" });
  const wallStateRef = useRef({ active: false, start: null, end: null });
  const wallConfigRef = useRef(wallConfig);
  useEffect(() => { wallConfigRef.current = wallConfig; }, [wallConfig]);
  const wallToolActiveRef = useRef(false);
  useEffect(() => { wallToolActiveRef.current = wallToolActive; }, [wallToolActive]);
  const [lineCount, setLineCount] = useState(5);
  const [catalogColors, setCatalogColors] = useState({}); // { [catalogId]: color }
  const catalogColorsRef = useRef({});
  useEffect(() => { catalogColorsRef.current = catalogColors; }, [catalogColors]);
  const getCatalogColor = (def) => catalogColors[def.id] || def.color || "#888888";
  const setCatalogColor = (id, color) => setCatalogColors((prev) => ({ ...prev, [id]: color }));
  const pendingLineDefRef = useRef(null);
  const lineCountRef = useRef(5);
  const lineStateRef = useRef({ active: false, start: null });
  useEffect(() => { pendingLineDefRef.current = pendingLineDef; }, [pendingLineDef]);
  useEffect(() => { lineCountRef.current = lineCount; }, [lineCount]);

  // ---------------- Load manifest from GitHub (or any URL) ----------------
  const [manifestStatus, setManifestStatus] = useState(null); // {type:'ok'|'error'|'loading', message}
  const [libraryReady, setLibraryReady] = useState(false);
  const [thumbnails, setThumbnails] = useState({}); // { catalogId: dataURL }
  const loadManifest = useCallback(async () => {
    setLibraryReady(false);
    if (!manifestUrl) { setCatalog(DEFAULT_MANIFEST); setManifestStatus(null); setLibraryReady(true); return; }
    setManifestStatus({ type: "loading", message: "Loading manifest…" });
    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error("The manifest is not a valid JSON array");
      setCatalog(data);

      // Prefetch every model's real GLB so the catalog has accurate sizes (w/h/d)
      // BEFORE the user can drag/line-tool anything — avoids placeholder-sized
      // boxes from a not-yet-loaded model being used in the line tool.
      const modelsWithFile = data.filter((d) => d.file);
      let loaded = 0;
      setManifestStatus({ type: "loading", message: `Loading models… (0/${modelsWithFile.length})` });
      await Promise.all(modelsWithFile.map((def) =>
        measureModelDims(def.file)
          .then((dims) => {
            loaded++;
            setCatalog((prev) => prev.map((c) => (c.id === def.id ? { ...c, ...dims, _measured: true } : c)));
            setManifestStatus({ type: "loading", message: `Loading models… (${loaded}/${modelsWithFile.length})` });
          })
          .catch((err) => {
            loaded++;
            console.error(`Could not preload model "${def.name}" (${def.file}):`, err);
          })
      ));

      setManifestStatus({ type: "ok", message: `✓ ${data.length} models loaded` });

      // Generar thumbnails en background — uno por uno para no saturar la GPU
      const modelsForThumb = data.filter((d) => d.file && d.category !== "Props");
      (async () => {
        for (const def of modelsForThumb) {
          try {
            const scene = await loadModelOnce(def.file);
            const dataURL = await generateThumbnail(scene, def.color);
            if (dataURL) {
              setThumbnails((prev) => ({ ...prev, [def.id]: dataURL }));
            }
          } catch (e) { /* silently skip */ }
        }
      })();
    } catch (err) {
      console.error("Could not load the manifest, using local catalog:", err);
      setManifestStatus({ type: "error", message: `✗ ${err.message || "Unknown error while loading"}` });
      setCatalog(DEFAULT_MANIFEST);
    } finally {
      setLibraryReady(true);
    }
  }, [manifestUrl]);

  // Auto-load the library on first mount
  useEffect(() => {
    loadManifest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===================== Three.js setup =====================
  useEffect(() => {
    const mount = mountRef.current;
    const width = mount.clientWidth, height = mount.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x14161a);

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.3;
    mount.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 200);
    const orthoCam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
    let useOrtho = false;
    let activeCam = camera;
    const updateOrthoFrustum = (r) => {
      const aspect = width / height;
      const halfH = r * 0.6;
      orthoCam.left = -halfH * aspect; orthoCam.right = halfH * aspect;
      orthoCam.top = halfH; orthoCam.bottom = -halfH;
      orthoCam.updateProjectionMatrix();
    };

    // ---- Lighting (direct, reliable — no env/PMREM) ----
    const hemi = new THREE.HemisphereLight(0xf4f6fa, 0x2a2a2e, 0.7);
    scene.add(hemi);
    const ambient = new THREE.AmbientLight(0xffffff, 0.25);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(6, 9, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0005;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.5);
    fill.position.set(-8, 5, -4);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.7);
    rim.position.set(-4, 6, -9);
    scene.add(rim);

    // ---- Floor ----
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: 0xe9e9e9, roughness: 0.85, metalness: 0.05 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    // (grid de referencia removido a petición — el piso queda limpio)

    // ---- Orbit (manual) ----
    const target = new THREE.Vector3(0, 0, 0);
    let radius = 14, theta = Math.PI / 4, phi = Math.PI / 3.2;
    const updateCamera = () => {
      const pos = new THREE.Vector3(
        target.x + radius * Math.sin(phi) * Math.sin(theta),
        target.y + radius * Math.cos(phi),
        target.z + radius * Math.sin(phi) * Math.cos(theta)
      );
      camera.position.copy(pos);
      camera.lookAt(target);
      orthoCam.position.copy(pos);
      orthoCam.lookAt(target);
      updateOrthoFrustum(radius);
    };
    updateCamera();

    const VIEW_ANGLES = {
      top: { theta: 0, phi: 0.001 },
      front: { theta: 0, phi: Math.PI / 2 },
      side: { theta: Math.PI / 2, phi: Math.PI / 2 },
      iso: { theta: Math.PI / 4, phi: Math.PI / 3.2 },
    };
    const setView = (name) => {
      if (name === "free") {
        useOrtho = false; activeCam = camera;
        camera.aspect = width / height; camera.updateProjectionMatrix();
      } else {
        const a = VIEW_ANGLES[name];
        theta = a.theta; phi = a.phi;
        useOrtho = true; activeCam = orthoCam;
        updateCamera();
      }
    };

    let isOrbiting = false, lastX = 0, lastY = 0;
    let isPanning = false, panLastX = 0, panLastY = 0;
    const dom = renderer.domElement;
    const onDown = (e) => {
      if (e.button === 2) { isOrbiting = true; lastX = e.clientX; lastY = e.clientY; }
      else if (e.button === 1) { isPanning = true; panLastX = e.clientX; panLastY = e.clientY; e.preventDefault(); }
    };
    const onMoveOrbit = (e) => {
      if (isPanning) {
        const dx = e.clientX - panLastX, dy = e.clientY - panLastY;
        panLastX = e.clientX; panLastY = e.clientY;
        const forward = new THREE.Vector3().subVectors(target, activeCam.position).normalize();
        const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
        const upV = new THREE.Vector3().crossVectors(right, forward).normalize();
        const panSpeed = radius * 0.0015;
        target.addScaledVector(right, -dx * panSpeed);
        target.addScaledVector(upV, dy * panSpeed);
        updateCamera();
        return;
      }
      if (!isOrbiting) return;
      theta -= (e.clientX - lastX) * 0.005;
      phi = Math.min(Math.max(phi - (e.clientY - lastY) * 0.005, 0.15), Math.PI / 2.05);
      lastX = e.clientX; lastY = e.clientY;
      updateCamera();
    };
    const onUp = () => { isOrbiting = false; isPanning = false; };
    const onWheel = (e) => {
      if (lineStateRef.current.active) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -1 : 1;
        const next = Math.max(1, lineCountRef.current + delta);
        lineCountRef.current = next;
        threeRef.current.setLineCountUI(next);
        buildLineGhostsWithOffset(lineStateRef.current.start, lineStateRef.current.end, next, pendingLineDefRef.current);
        return;
      }
      if (arrayHandleActiveRef.current) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -1 : 1;
        const next = Math.max(1, lineCountRef.current + delta);
        lineCountRef.current = next;
        threeRef.current.setLineCountUI(next);
        const state = threeRef.current._arrayDragState;
        if (state) threeRef.current.buildArrayGhosts(state.origin, state.endPt, next, state.src, 0);
        return;
      }
      radius = Math.min(Math.max(radius + e.deltaY * 0.01, 3), 40); updateCamera();
    };
    const onCtx = (e) => e.preventDefault();
    dom.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMoveOrbit);
    window.addEventListener("pointerup", onUp);
    dom.addEventListener("wheel", onWheel, { passive: false });
    dom.addEventListener("contextmenu", onCtx);

    // ---- Item group + drag/select ----
    const itemGroup = new THREE.Group();
    scene.add(itemGroup);
    const wallGroup = new THREE.Group();
    scene.add(wallGroup);
    const handleGroup = new THREE.Group();
    scene.add(handleGroup);
    const ghostGroup = new THREE.Group();
    scene.add(ghostGroup);

    const clearGhosts = () => {
      while (ghostGroup.children.length) {
        const c = ghostGroup.children.pop();
        c.traverse((child) => {
          if (child.isMesh) { child.geometry.dispose(); child.material.dispose(); }
        });
      }
    };
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const planeY0 = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    const groundPoint = (cx, cy) => {
      const rect = dom.getBoundingClientRect();
      pointer.x = ((cx - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((cy - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, activeCam);
      const pt = new THREE.Vector3();
      raycaster.ray.intersectPlane(planeY0, pt);
      return pt;
    };

    const lineAngleOffsetRef = { current: 0 };
    threeRef.current.lineAngleOffsetRef = lineAngleOffsetRef;
    const buildLineGhostsWithOffset = (start, end, count, defInfo) => {
      clearGhosts();
      if (!defInfo) return;
      const { def, kind } = defInfo;
      const n = Math.max(1, count);
      const dir = new THREE.Vector3().subVectors(end, start);
      const baseAngle = Math.atan2(dir.x, dir.z) + lineAngleOffsetRef.current;
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : i / (n - 1);
        const pos = new THREE.Vector3().copy(start).lerp(end, t);
        const geo = kind !== "model" ? buildPlaceholderGeometry(def.kind, def.w, def.d, def.h) : new THREE.BoxGeometry(def.w, def.h, def.d);
        const mat = new THREE.MeshStandardMaterial({ color: catalogColorsRef.current[def.id] || def.color || "#888888", roughness: 0.45, metalness: 0.15, transparent: true, opacity: 0.45 });
        const ghost = new THREE.Mesh(geo, mat);
        ghost.position.set(pos.x, def.h / 2, pos.z);
        ghost.rotation.y = baseAngle;

        // Flecha que indica hacia dónde queda viendo el frente del objeto (eje local +Z)
        const arrow = new THREE.Mesh(
          new THREE.ConeGeometry(0.08, 0.22, 8),
          new THREE.MeshBasicMaterial({ color: 0x00e5ff })
        );
        arrow.rotation.x = Math.PI / 2; // el cono por default apunta a +Y; lo orientamos a +Z
        arrow.position.set(0, 0, (def.d || 0.3) / 2 + 0.2);
        ghost.add(arrow);

        ghostGroup.add(ghost);
      }
    };
    // (la rotación de los ghosts de línea con flechas se maneja en un único listener a nivel React, más abajo)
    let draggingUid = null;
    const dragOffsetsRef = { current: {} };
    let draggingWallUid = null;
    let wallDragStartPt = null;
    let wallDragOrigX1 = 0, wallDragOrigZ1 = 0, wallDragOrigX2 = 0, wallDragOrigZ2 = 0;
    let dragArmed = false; // solo cuenta como "arrastre" real una vez que pasas el umbral de píxeles
    let dragStartScreenX = 0, dragStartScreenY = 0;
    const DRAG_THRESHOLD_PX = 5;
    const onDownSelect = (e) => {
      if (e.button !== 0) return;
      // ---- Wall tool flow ----
      if (wallToolActiveRef.current) {
        const ws = wallStateRef.current;
        const raw = groundPoint(e.clientX, e.clientY);
        if (!ws.active) {
          const { pt } = snapWallPoint(raw, e.shiftKey, wallsRef.current, floorWRef.current, floorDRef.current);
          ws.active = true;
          ws.start = pt.clone();
          ws.end = pt.clone();
          wallStartMarker.visible = false;
        } else {
          const dx = ws.end.x - ws.start.x, dz = ws.end.z - ws.start.z;
          const len = Math.sqrt(dx * dx + dz * dz);
          if (len > 0.05) {
            const cfg = wallConfigRef.current;
            const uid = `wall_${Date.now()}`;
            threeRef.current.commitWall({ uid, x1: ws.start.x, z1: ws.start.z, x2: ws.end.x, z2: ws.end.z, ...cfg });
            ws.start = ws.end.clone();
            ws.end = ws.start.clone();
            snapIndicator.visible = false;
            threeRef.current.clearWallGhost();
          }
        }
        return;
      }
      // ---- Line tool flow ----
      if (pendingLineDefRef.current) {
        const ls = lineStateRef.current;
        if (!ls.active) {
          ls.active = true;
          ls.start = groundPoint(e.clientX, e.clientY);
          ls.end = ls.start.clone();
          lineAngleOffsetRef.current = 0;
          buildLineGhostsWithOffset(ls.start, ls.end, lineCountRef.current, pendingLineDefRef.current);
        } else {
          // commit
          const n = Math.max(1, lineCountRef.current);
          const { def, kind } = pendingLineDefRef.current;
          const dir = new THREE.Vector3().subVectors(ls.end, ls.start);
          const angle = Math.atan2(dir.x, dir.z) + lineAngleOffsetRef.current;
          const groupId = `line_${Date.now()}`;
          const baseColor = catalogColorsRef.current[def.id] || def.color || "#888888";
          const newItems = [];
          for (let i = 0; i < n; i++) {
            const t = n === 1 ? 0 : i / (n - 1);
            const pos = new THREE.Vector3().copy(ls.start).lerp(ls.end, t);
            newItems.push({
              uid: `${def.id}_${Date.now()}_ln${i}`,
              catalogId: def.id, kind, x: pos.x, z: pos.z, rotY: angle,
              color: varyColor(baseColor, i), sockets: {}, groupId,
              pivotX: ls.start.x, pivotZ: ls.start.z,
            });
          }
          threeRef.current.commitLineItems(newItems);
          clearGhosts();
          ls.active = false; ls.start = null; ls.end = null;
          threeRef.current.clearPendingLine();
        }
        return;
      }
      const rect = dom.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, activeCam);
      // ---- Wall handle + Line handle drag ----
      const { handleGroup } = threeRef.current;
      if (handleGroup && handleGroup.children.length) {
        const handleHits = raycaster.intersectObjects(handleGroup.children, true);
        if (handleHits.length) {
          let h = handleHits[0].object;
          while (h && !h.userData.isWallHandle && !h.userData.isLineHandle && !h.userData.isArrayHandle && h.parent !== null) {
            h = h.parent;
          }
          if (h && (h.userData.isWallHandle || h.userData.isLineHandle || h.userData.isArrayHandle)) {
            if (h.userData.isWallHandle) {
              draggingWallHandleRef.current = { type: 'wall', wallUid: h.userData.wallUid, endpoint: h.userData.endpoint };
            } else if (h.userData.isLineHandle) {
              const groupId = h.userData.groupId;
              const groupItems = itemsRef.current.filter((it) => it.groupId === groupId);
              if (groupItems.length) {
                const pivot = { x: h.userData.pivotX, z: h.userData.pivotZ };
                const src = [...groupItems].sort((a, b) =>
                  Math.hypot(a.x - pivot.x, a.z - pivot.z) - Math.hypot(b.x - pivot.x, b.z - pivot.z)
                )[0];
                arrayHandleActiveRef.current = true;
                arrayHandleSourceRef.current = { ...src };
                lineCountRef.current = groupItems.length - 1;
                threeRef.current.setLineCountUI(groupItems.length - 1);
                draggingWallHandleRef.current = { type: 'array', groupId };
                // ocultar sprite y items reales
                h.visible = false;
                groupItems.forEach((it) => {
                  const c = itemGroup.children.find((c) => c.userData.uid === it.uid);
                  if (c) c.visible = false;
                });
              }
            } else if (h.userData.isArrayHandle) {
              const srcItem = itemsRef.current.find((it) => it.uid === h.userData.sourceUid);
              if (srcItem) {
                arrayHandleActiveRef.current = true;
                arrayHandleSourceRef.current = { ...srcItem };
                lineCountRef.current = 2;
                threeRef.current.setLineCountUI(2);
                draggingWallHandleRef.current = { type: 'array' };
                // ocultar sprite y item original
                h.visible = false;
                const c = itemGroup.children.find((c) => c.userData.uid === srcItem.uid);
                if (c) c.visible = false;
              }
            }
            dragArmed = false;
            dragStartScreenX = e.clientX; dragStartScreenY = e.clientY;
            return;
          }
        }
      }
      // check walls first
      const wallHits = raycaster.intersectObjects(wallGroup.children, true);
      if (wallHits.length) {
        let obj = wallHits[0].object;
        while (obj.parent && obj.parent !== wallGroup) obj = obj.parent;
        const wuid = obj.userData.wallUid;
        threeRef.current.setSelectedWall(wuid);
        threeRef.current.setSelected(null);
        // preparar drag de la pared
        const wallData = wallsRef.current.find((w) => w.uid === wuid);
        if (wallData) {
          draggingWallUid = wuid;
          dragArmed = false;
          dragStartScreenX = e.clientX; dragStartScreenY = e.clientY;
          wallDragStartPt = groundPoint(e.clientX, e.clientY);
          wallDragOrigX1 = wallData.x1; wallDragOrigZ1 = wallData.z1;
          wallDragOrigX2 = wallData.x2; wallDragOrigZ2 = wallData.z2;
        }
        return;
      }
      const hits = raycaster.intersectObjects(itemGroup.children, true);
      if (hits.length) {
        let obj = hits[0].object;
        while (obj.parent && obj.parent !== itemGroup) obj = obj.parent;
        threeRef.current.setSelectedWall(null); // deselect wall when clicking object
        draggingUid = obj.userData.uid;
        dragArmed = false;
        dragStartScreenX = e.clientX; dragStartScreenY = e.clientY;
        const clickedItem = itemsRef.current.find((it) => it.uid === draggingUid);
        const groupId = clickedItem && clickedItem.groupId;
        if (groupId && !e.shiftKey) {
          // click normal sobre un objeto agrupado: selecciona todo el grupo
          const groupUids = itemsRef.current.filter((it) => it.groupId === groupId).map((it) => it.uid);
          threeRef.current.setSelectedGroup(groupUids);
        } else {
          threeRef.current.setSelected(draggingUid, e.shiftKey);
        }
        // preparar offsets para mover el grupo entero junto (si el seleccionado termina siendo un grupo)
        const startPt = groundPoint(e.clientX, e.clientY);
        const groupUidsForDrag = groupId ? itemsRef.current.filter((it) => it.groupId === groupId).map((it) => it.uid) : [draggingUid];
        dragOffsetsRef.current = {};
        groupUidsForDrag.forEach((uid) => {
          const it = itemsRef.current.find((i) => i.uid === uid);
          if (it) dragOffsetsRef.current[uid] = { dx: it.x - startPt.x, dz: it.z - startPt.z };
        });
      } else {
        threeRef.current.setSelected(null);
        threeRef.current.setSelectedWall(null);
      }
    };
    const SNAP_STEP = Math.PI / 4; // 45°
    const WALL_SNAP_RADIUS = 0.4; // metros — distancia para pegar a endpoints

    // Preview marker (cuadradito que sigue al mouse antes del primer click)
    const wallStartMarker = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.02, 0.18),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff, depthTest: false })
    );
    wallStartMarker.visible = false;
    wallStartMarker.renderOrder = 999;
    wallStartMarker.raycast = () => {};
    scene.add(wallStartMarker);

    // Snap indicator (circulito verde cuando hay snap activo)
    const snapIndicator = new THREE.Mesh(
      new THREE.CircleGeometry(0.12, 16),
      new THREE.MeshBasicMaterial({ color: 0x00ff88, side: THREE.DoubleSide, depthTest: false })
    );
    snapIndicator.rotation.x = -Math.PI / 2;
    snapIndicator.position.y = 0.01;
    snapIndicator.visible = false;
    snapIndicator.renderOrder = 998;
    snapIndicator.raycast = () => {};
    scene.add(snapIndicator);

    // función de snap a endpoints de paredes existentes + bordes del piso
    const snapWallPoint = (rawPt, freePos, walls, floorW, floorD) => {
      if (freePos) return { pt: rawPt, snapped: false };
      const t = (wallConfigRef.current.thickness || 0.1) / 2; // offset para que la pared quede dentro del piso
      const candidates = [];
      // endpoints de paredes existentes
      walls.forEach((w) => {
        candidates.push(new THREE.Vector3(w.x1, 0, w.z1));
        candidates.push(new THREE.Vector3(w.x2, 0, w.z2));
      });
      // bordes del piso desplazados hacia adentro por thickness/2
      const hw = floorW / 2 - t, hd = floorD / 2 - t;
      const hwO = floorW / 2, hdO = floorD / 2; // esquinas exactas (sin offset, para snap corner-to-corner)
      [
        // centros de cada borde (desplazados adentro)
        [-hw, 0], [hw, 0], [0, -hd], [0, hd],
        // esquinas (desplazadas adentro en ambos ejes)
        [-hw, -hd], [-hw, hd], [hw, -hd], [hw, hd],
      ].forEach(([x, z]) => candidates.push(new THREE.Vector3(x, 0, z)));
      let best = null, bestDist = WALL_SNAP_RADIUS;
      candidates.forEach((c) => {
        const d = rawPt.distanceTo(c);
        if (d < bestDist) { bestDist = d; best = c; }
      });
      return best ? { pt: best, snapped: true } : { pt: rawPt, snapped: false };
    };

    const snapLineEnd = (start, rawEnd, free) => {
      if (free) return rawEnd;
      const dir = new THREE.Vector3().subVectors(rawEnd, start);
      const len = dir.length();
      if (len < 0.001) return rawEnd;
      const angle = Math.atan2(dir.x, dir.z);
      const snapped = Math.round(angle / SNAP_STEP) * SNAP_STEP;
      return new THREE.Vector3(start.x + Math.sin(snapped) * len, 0, start.z + Math.cos(snapped) * len);
    };
    const onMoveDrag = (e) => {
      // ---- Wall/Line handle drag ----
      if (draggingWallHandleRef.current) {
        if (!dragArmed) {
          const dx = e.clientX - dragStartScreenX, dy = e.clientY - dragStartScreenY;
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          dragArmed = true;
        }
        const raw = groundPoint(e.clientX, e.clientY);
        const handle = draggingWallHandleRef.current;

        if (handle.type === 'wall') {
          const { pt, snapped } = snapWallPoint(raw, e.shiftKey, wallsRef.current, floorWRef.current, floorDRef.current);
          const w = wallsRef.current.find((w) => w.uid === handle.wallUid);
          const fixedPt = w ? (handle.endpoint === 'start' ? new THREE.Vector3(w.x2, 0, w.z2) : new THREE.Vector3(w.x1, 0, w.z1)) : pt;
          const finalPt = e.altKey ? pt : snapLineEnd(fixedPt, pt, false);
          snapIndicator.position.set(finalPt.x, 0.01, finalPt.z);
          snapIndicator.visible = snapped;
          threeRef.current.moveWallEndpoint(handle.wallUid, handle.endpoint, finalPt.x, finalPt.z);

        } else if (handle.type === 'array') {
          const src = arrayHandleSourceRef.current;
          if (!src) return;
          const def = findDefRef.current(src.kind, src.catalogId);
          const origin = new THREE.Vector3(src.x, 0, src.z);
          const toMouse = new THREE.Vector3().subVectors(raw, origin);
          let dist = toMouse.length();
          let angle = Math.atan2(toMouse.x, toMouse.z);
          if (!e.shiftKey) {
            angle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
          }
          if (e.altKey && def) {
            const snapUnit = def.w || 1;
            dist = Math.round(dist / snapUnit) * snapUnit;
          }
          dist = Math.max(0.1, dist);
          const endPt = new THREE.Vector3(
            origin.x + Math.sin(angle) * dist,
            0,
            origin.z + Math.cos(angle) * dist
          );
          const n = Math.max(1, lineCountRef.current);
          threeRef.current.buildArrayGhosts(origin, endPt, n, src, 0);
        }
        return;
      }
      if (wallToolActiveRef.current) {
        const raw = groundPoint(e.clientX, e.clientY);
        const ws = wallStateRef.current;
        if (!ws.active) {
          // antes del primer click: mostrar preview de inicio con snap de posición
          const { pt, snapped } = snapWallPoint(raw, e.shiftKey, wallsRef.current, floorWRef.current, floorDRef.current);
          wallStartMarker.position.set(pt.x, 0.01, pt.z);
          wallStartMarker.visible = true;
          wallStartMarker.material.color.set(snapped ? 0x00ff88 : 0x00e5ff);
          snapIndicator.visible = false;
        } else {
          // después del primer click: mover el endpoint con snap de posición + ángulo
          const { pt: posSnapped, snapped: didSnap } = snapWallPoint(raw, e.shiftKey, wallsRef.current, floorWRef.current, floorDRef.current);
          ws.end = e.altKey ? posSnapped : snapLineEnd(ws.start, posSnapped, false);
          snapIndicator.position.set(posSnapped.x, 0.01, posSnapped.z);
          snapIndicator.visible = didSnap;
          threeRef.current.updateWallGhost(ws.start, ws.end, wallConfigRef.current);
        }
        return;
      }
      // drag de pared seleccionada
      if (draggingWallUid) {
        if (!dragArmed) {
          const dx = e.clientX - dragStartScreenX, dy = e.clientY - dragStartScreenY;
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          dragArmed = true;
        }
        const pt = groundPoint(e.clientX, e.clientY);
        const dx = pt.x - wallDragStartPt.x, dz = pt.z - wallDragStartPt.z;
        threeRef.current.moveWall(draggingWallUid, wallDragOrigX1 + dx, wallDragOrigZ1 + dz, wallDragOrigX2 + dx, wallDragOrigZ2 + dz);
        return;
      }
      if (lineStateRef.current.active) {
        const raw = groundPoint(e.clientX, e.clientY);
        lineStateRef.current.end = snapLineEnd(lineStateRef.current.start, raw, e.altKey);
        buildLineGhostsWithOffset(lineStateRef.current.start, lineStateRef.current.end, lineCountRef.current, pendingLineDefRef.current);
        return;
      }
      if (!draggingUid) return;
      if (!dragArmed) {
        const dx = e.clientX - dragStartScreenX, dy = e.clientY - dragStartScreenY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return; // todavía es un click, no un arrastre real
        dragArmed = true;
      }
      const draggedItem = itemsRef.current.find((it) => it.uid === draggingUid);
      if (draggedItem && draggedItem.kind === "prop") {
        const rect = dom.getBoundingClientRect();
        pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, activeCam);
        const draggedContainer = itemGroup.children.find((c) => c.userData.uid === draggingUid);
        const otherContainers = itemGroup.children.filter((c) => c !== draggedContainer);
        const hits = raycaster.intersectObjects(otherContainers, true);
        if (hits.length) {
          let hitObj = hits[0].object;
          while (hitObj.parent && hitObj.parent !== itemGroup) hitObj = hitObj.parent;
          const parentUid = hitObj.userData.uid;
          const parentItem = itemsRef.current.find((it) => it.uid === parentUid);
          if (parentItem) {
            const worldPt = hits[0].point;
            const rel = new THREE.Vector3(worldPt.x - parentItem.x, 0, worldPt.z - parentItem.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), -parentItem.rotY);
            threeRef.current.attachProp(draggingUid, parentUid, { x: rel.x, y: worldPt.y, z: rel.z });
            return;
          }
        }
        const pt = groundPoint(e.clientX, e.clientY);
        threeRef.current.detachPropToFloor(draggingUid, pt.x, pt.z);
        return;
      }
      const pt = groundPoint(e.clientX, e.clientY);
      threeRef.current.moveGroup(dragOffsetsRef.current, pt.x, pt.z);
    };
    const onUpDrag = () => {
      draggingUid = null;
      draggingWallUid = null;
      if (draggingWallHandleRef.current?.type === 'array') {
        const state = threeRef.current._arrayDragState;
        const existingGroupId = draggingWallHandleRef.current.groupId;
        itemGroup.children.forEach((c) => { c.visible = true; });
        if (state && state.n > 0) {
          const { origin, endPt, n, src } = state;
          const dir = new THREE.Vector3().subVectors(endPt, origin);
          const angle = Math.atan2(dir.x, dir.z) - Math.PI / 2;
          const baseColor = src.color || "#888888";
          if (existingGroupId) {
            setItems((prev) => {
              const groupItems = prev.filter((it) => it.groupId === existingGroupId);
              const nonGroup = prev.filter((it) => it.groupId !== existingGroupId);
              const total = n + 1;
              const newGroup = [];
              for (let i = 0; i < total; i++) {
                const t = n === 0 ? 0 : i / n;
                const pos = new THREE.Vector3().copy(origin).lerp(endPt, t);
                const existing = groupItems[i];
                newGroup.push(existing
                  ? { ...existing, x: pos.x, z: pos.z, rotY: angle, pivotX: origin.x, pivotZ: origin.z }
                  : {
                    uid: `${src.catalogId}_${Date.now()}_arr${i}`,
                    catalogId: src.catalogId, kind: src.kind,
                    x: pos.x, z: pos.z, rotY: angle,
                    color: varyColor(baseColor, i), sockets: {}, groupId: existingGroupId,
                    pivotX: origin.x, pivotZ: origin.z,
                  });
              }
              return [...nonGroup, ...newGroup];
            });
          } else {
            const groupId = `line_${Date.now()}`;
            const newItems = [];
            for (let i = 1; i <= n; i++) {
              const t = i / n;
              const pos = new THREE.Vector3().copy(origin).lerp(endPt, t);
              newItems.push({
                uid: `${src.catalogId}_${Date.now()}_arr${i}`,
                catalogId: src.catalogId, kind: src.kind,
                x: pos.x, z: pos.z, rotY: angle,
                color: varyColor(baseColor, i), sockets: {}, groupId,
                pivotX: origin.x, pivotZ: origin.z,
              });
            }
            threeRef.current.addToGroup(src.uid, groupId, origin.x, origin.z, angle);
            threeRef.current.commitLineItems(newItems);
          }
          threeRef.current._arrayDragState = null;
          clearGhosts();
        } else {
          clearGhosts();
        }
        arrayHandleActiveRef.current = false;
        arrayHandleSourceRef.current = null;
      }
      if (draggingWallHandleRef.current) {
        draggingWallHandleRef.current = null;
        snapIndicator.visible = false;
      }
    };
    dom.addEventListener("pointerdown", onDownSelect);
    const onDblClick = (e) => {
      if (pendingLineDefRef.current) return; // no aplica en modo línea
      const rect = dom.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, activeCam);
      const hits = raycaster.intersectObjects(itemGroup.children, true);
      if (hits.length) {
        let obj = hits[0].object;
        while (obj.parent && obj.parent !== itemGroup) obj = obj.parent;
        // doble click: selecciona SOLO esa pieza, aunque sea parte de un grupo
        threeRef.current.setSelectedGroup([obj.userData.uid]);
      }
    };
    dom.addEventListener("dblclick", onDblClick);
    window.addEventListener("pointermove", onMoveDrag);
    window.addEventListener("pointerup", onUpDrag);

    const onResize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      camera.aspect = w / h; camera.updateProjectionMatrix();
      orthoCam.left = -10 * (w / h); orthoCam.right = 10 * (w / h);
      orthoCam.updateProjectionMatrix();
      updateOrthoFrustum(radius);
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    let raf;
    const animate = () => { raf = requestAnimationFrame(animate); renderer.render(scene, activeCam); };
    animate();

    threeRef.current = {
      scene, camera, renderer, itemGroup, wallGroup, handleGroup, floor, dom,
      target, getRadiusThetaPhi: () => ({ radius, theta, phi }),
      setRadiusThetaPhi: (r, t, p) => { radius = r; theta = t; phi = p; updateCamera(); },
      getActiveCamera: () => activeCam,
      syncSize: onResize,
      setView: (name) => { setView(name); threeRef.current.viewName = name; setViewUIRef.current && setViewUIRef.current(name); },
      resetCamera: () => {
        target.set(0, 0, 0);
        radius = 14; theta = Math.PI / 4; phi = Math.PI / 3.2;
        useOrtho = false; activeCam = camera;
        camera.aspect = mount.clientWidth / mount.clientHeight; camera.updateProjectionMatrix();
        updateCamera();
        setViewUIRef.current && setViewUIRef.current("free");
      },
      setSelected: (uid, shiftKey) => {
        if (!uid) { setSelectedUids([]); return; }
        if (shiftKey) {
          setSelectedUids((prev) => prev.includes(uid) ? prev.filter((u) => u !== uid) : [...prev, uid]);
        } else {
          setSelectedUids([uid]);
        }
      },
      setSelectedWall: (uid) => setSelectedWallUid(uid),
      moveItem: (uid, x, z) => setItems((prev) => prev.map((it) => (it.uid === uid ? { ...it, x, z } : it))),
      setSelectedGroup: (uids) => setSelectedUids(uids),
      moveGroup: (offsets, px, pz) => setItems((prev) => prev.map((it) => (
        offsets[it.uid] ? { ...it, x: px + offsets[it.uid].dx, z: pz + offsets[it.uid].dz } : it
      ))),
      attachProp: (uid, parentUid, localOffset) => setItems((prev) => prev.map((it) => (
        it.uid === uid ? { ...it, parentUid, localOffset } : it
      ))),
      detachPropToFloor: (uid, x, z) => setItems((prev) => prev.map((it) => (
        it.uid === uid ? { ...it, parentUid: null, localOffset: null, x, z, yOffset: 0 } : it
      ))),
      commitLineItems: (newItems) => setItems((prev) => [...prev, ...newItems]),
      clearPendingLine: () => setPendingLineDef(null),
      setLineCountUI: (n) => setLineCount(n),
      commitWall: (wall) => setWalls((prev) => {
        const EPS = 0.08;
        const t = (wall.thickness || 0.1) / 2;

        const extendExistingAtPoint = (walls, nx, nz) => {
          const matchIdx = walls.findIndex((w) =>
            Math.hypot(w.x1 - nx, w.z1 - nz) < EPS ||
            Math.hypot(w.x2 - nx, w.z2 - nz) < EPS
          );
          if (matchIdx === -1) return walls;
          const ex = walls[matchIdx];
          const atStart = Math.hypot(ex.x1 - nx, ex.z1 - nz) < EPS;
          // dirección de la pared existente hacia fuera (desde el interior hacia el endpoint)
          const dx = atStart ? ex.x1 - ex.x2 : ex.x2 - ex.x1;
          const dz = atStart ? ex.z1 - ex.z2 : ex.z2 - ex.z1;
          const len = Math.hypot(dx, dz) || 1;
          const ext = { ...ex };
          if (atStart) { ext.x1 += (dx / len) * t; ext.z1 += (dz / len) * t; }
          else { ext.x2 += (dx / len) * t; ext.z2 += (dz / len) * t; }
          const updated = [...walls];
          updated[matchIdx] = ext;
          return updated;
        };

        // extender pared existente en el punto de inicio y fin de la nueva pared
        let updated = extendExistingAtPoint(prev, wall.x1, wall.z1);
        updated = extendExistingAtPoint(updated, wall.x2, wall.z2);
        return [...updated, wall];
      }),
      moveWall: (uid, x1, z1, x2, z2) => setWalls((prev) => prev.map((w) => w.uid === uid ? { ...w, x1, z1, x2, z2 } : w)),
      moveWallEndpoint: (uid, endpoint, x, z) => setWalls((prev) => prev.map((w) => {
        if (w.uid !== uid) return w;
        return endpoint === 'start' ? { ...w, x1: x, z1: z } : { ...w, x2: x, z2: z };
      })),
      setOriginalRotation: (uid, rotY) => setItems((prev) => prev.map((it) => it.uid === uid ? { ...it, rotY } : it)),
      addToGroup: (uid, groupId, pivotX, pivotZ, rotY) => setItems((prev) => prev.map((it) => it.uid === uid ? { ...it, groupId, pivotX, pivotZ, rotY } : it)),
      redistributeLineGroup: (groupId, pivotX, pivotZ, endX, endZ) => {
        setItems((prev) => {
          const groupItems = prev.filter((it) => it.groupId === groupId);
          if (groupItems.length < 2) return prev;
          const n = groupItems.length;
          const angle = Math.atan2(endX - pivotX, endZ - pivotZ);
          const origin = new THREE.Vector3(pivotX, 0, pivotZ);
          const end = new THREE.Vector3(endX, 0, endZ);
          return prev.map((it) => {
            if (it.groupId !== groupId) return it;
            const idx = groupItems.indexOf(it);
            if (idx === 0) return { ...it, rotY: angle }; // original stays at pivot, just rotates
            const t = idx / (n - 1);
            const pos = new THREE.Vector3().copy(origin).lerp(end, t);
            return { ...it, x: pos.x, z: pos.z, rotY: angle, pivotX, pivotZ };
          });
        });
      },
      buildArrayGhosts: (origin, endPt, n, src, angleOffset = 0) => {
        clearGhosts();
        const def = findDefRef.current(src.kind, src.catalogId);
        if (!def) return;
        const dir = new THREE.Vector3().subVectors(endPt, origin);
        const baseAngle = Math.atan2(dir.x, dir.z) - Math.PI / 2;
        const origContainer = itemGroup.children.find((c) => c.userData.uid === src.uid);
        if (origContainer) origContainer.rotation.y = baseAngle;
        const makeGhost = (pos, colorIdx) => {
          const geo = new THREE.BoxGeometry(def.w || 1, def.h || 1, def.d || 1);
          const mat = new THREE.MeshStandardMaterial({ color: varyColor(src.color || def.color || "#888888", colorIdx), roughness: 0.45, metalness: 0.15, transparent: true, opacity: 0.45 });
          const ghost = new THREE.Mesh(geo, mat);
          ghost.position.set(pos.x, (def.h || 1) / 2, pos.z);
          ghost.rotation.y = baseAngle;
          ghostGroup.add(ghost);
        };
        makeGhost(origin, 0);
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const pos = new THREE.Vector3().copy(origin).lerp(endPt, t);
          makeGhost(pos, i);
        }
        threeRef.current._arrayDragState = { origin, endPt, n, src, angleOffset: 0 };
      },
      clearWallGhost: () => {
        const wg = threeRef.current.wallGhost;
        if (wg) { threeRef.current.scene.remove(wg); threeRef.current.wallGhost = null; }
        wallStartMarker.visible = false;
        snapIndicator.visible = false;
      },
      updateWallGhost: (start, end, cfg) => {
        const wg = threeRef.current.wallGhost;
        if (wg) threeRef.current.scene.remove(wg);
        const ghost = buildWallMesh({ x1: start.x, z1: start.z, x2: end.x, z2: end.z, ...cfg });
        ghost.traverse((c) => { if (c.isMesh) { c.material = c.material.clone(); c.material.transparent = true; c.material.opacity = 0.45; } });
        threeRef.current.scene.add(ghost);
        threeRef.current.wallGhost = ghost;
      },
      adjustLineAngle: (delta) => {
        if (!lineStateRef.current.active) return false;
        lineAngleOffsetRef.current += delta;
        buildLineGhostsWithOffset(lineStateRef.current.start, lineStateRef.current.end, lineCountRef.current, pendingLineDefRef.current);
        return true;
      },
    };

    return () => {
      cancelAnimationFrame(raf);
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointerdown", onDownSelect);
      dom.removeEventListener("dblclick", onDblClick);
      window.removeEventListener("pointermove", onMoveOrbit);
      window.removeEventListener("pointermove", onMoveDrag);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointerup", onUpDrag);
      dom.removeEventListener("wheel", onWheel, { passive: false });
      dom.removeEventListener("contextmenu", onCtx);
      window.removeEventListener("resize", onResize);
      mount.removeChild(dom);
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Floor size + color sync
  useEffect(() => {
    const { floor } = threeRef.current;
    if (!floor) return;
    floor.scale.set(floorW, floorD, 1);
    if (floor.material) floor.material.color.set(floorColor);
  }, [floorW, floorD, floorColor]);

  // ===================== Floor plan image sync =====================
  useEffect(() => {
    const { scene } = threeRef.current;
    if (!scene) return;
    // remove existing floor plan mesh
    const existing = scene.getObjectByName("__floorPlanMesh");
    if (existing) scene.remove(existing);
    if (!floorPlan) return;
    const tex = new THREE.TextureLoader().load(floorPlan.dataUrl);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: floorPlan.opacity ?? 0.5, depthWrite: false });
    const geo = new THREE.PlaneGeometry(floorPlan.realW, floorPlan.realH);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "__floorPlanMesh";
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(floorPlan.x ?? 0, 0.005, floorPlan.z ?? 0);
    mesh.visible = floorPlan.visible !== false;
    mesh.renderOrder = -1;
    scene.add(mesh);
    return () => { scene.remove(mesh); mat.dispose(); geo.dispose(); };
  }, [floorPlan]);

  // ===================== Sync wall handles + array handles =====================
  useEffect(() => {
    const { handleGroup } = threeRef.current;
    if (!handleGroup) return;
    while (handleGroup.children.length) handleGroup.children.pop();

    // Helper: sprite con "+" que siempre mira a la cámara
    const makeHandleSprite = (hexColor) => {
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 128;
      const ctx = canvas.getContext('2d');
      ctx.shadowColor = 'rgba(0,0,0,0.4)';
      ctx.shadowBlur = 12;
      ctx.fillStyle = `#${hexColor.toString(16).padStart(6, '0')}`;
      ctx.beginPath();
      ctx.arc(64, 64, 52, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(28, 56, 72, 16);
      ctx.fillRect(56, 28, 16, 72);
      const tex = new THREE.CanvasTexture(canvas);
      const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(0.5, 0.5, 1);
      sprite.renderOrder = 999;
      return sprite;
    };

    // Wall handles (orange)
    if (selectedWallUid) {
      const wall = walls.find((w) => w.uid === selectedWallUid);
      if (wall) {
        const makeWallHandle = (x, z, endpoint) => {
          const geo = new THREE.SphereGeometry(0.12, 16, 16);
          const mat = new THREE.MeshBasicMaterial({ color: 0xff6a00, depthTest: false });
          const sphere = new THREE.Mesh(geo, mat);
          sphere.position.set(x, 0.15, z);
          sphere.renderOrder = 999;
          sphere.userData.isWallHandle = true;
          sphere.userData.wallUid = selectedWallUid;
          sphere.userData.endpoint = endpoint;
          return sphere;
        };
        handleGroup.add(makeWallHandle(wall.x1, wall.z1, 'start'));
        handleGroup.add(makeWallHandle(wall.x2, wall.z2, 'end'));
      }
    }

    // Single object — "+" array expand handle (green sprite)
    if (selectedUids.length === 1 && !selectedWallUid) {
      const it = items.find((i) => i.uid === selectedUids[0]);
      const def = it && findDef(it.kind, it.catalogId);
      if (it && def && it.kind === 'model') {
        const offset = (def.w || 1) / 2 + 0.3;
        const sx = it.x + Math.sin(it.rotY + Math.PI / 2) * offset;
        const sz = it.z + Math.cos(it.rotY + Math.PI / 2) * offset;
        const sprite = makeHandleSprite(0x4ade80);
        sprite.position.set(sx, 0.5, sz);
        sprite.userData.isArrayHandle = true;
        sprite.userData.sourceUid = it.uid;
        handleGroup.add(sprite);
      }
    }

    // Group handles — solo sprite del extremo final (el del inicio no existe)
    if (selectedUids.length > 1) {
      const selItems = items.filter((it) => selectedUids.includes(it.uid));
      const allSameGroup = selItems.every((it) => it.groupId && it.groupId === selItems[0].groupId);
      if (allSameGroup && selItems[0].pivotX != null) {
        const sorted = [...selItems].sort((a, b) => {
          const da = Math.hypot(a.x - selItems[0].pivotX, a.z - (selItems[0].pivotZ ?? 0));
          const db = Math.hypot(b.x - selItems[0].pivotX, b.z - (selItems[0].pivotZ ?? 0));
          return da - db;
        });
        const last = sorted[sorted.length - 1];
        const sprite = makeHandleSprite(0x00e5ff);
        sprite.position.set(last.x, 0.5, last.z);
        sprite.userData.isLineHandle = true;
        sprite.userData.groupId = selItems[0].groupId;
        sprite.userData.role = 'end';
        sprite.userData.pivotX = selItems[0].pivotX;
        sprite.userData.pivotZ = selItems[0].pivotZ ?? 0;
        handleGroup.add(sprite);
      }
    }
  }, [selectedWallUid, selectedUids, walls, items, findDef]);

  // ===================== Sync walls -> meshes =====================
  useEffect(() => {
    const { wallGroup } = threeRef.current;
    if (!wallGroup) return;
    const currentUids = new Set(walls.map((w) => w.uid));
    wallGroup.children.filter((c) => !currentUids.has(c.userData.wallUid)).forEach((c) => wallGroup.remove(c));
    walls.forEach((wall) => {
      let mesh = wallGroup.children.find((c) => c.userData.wallUid === wall.uid);
      if (mesh) wallGroup.remove(mesh);
      mesh = buildWallMesh(wall);
      mesh.userData.wallUid = wall.uid;
      // highlight selected wall
      if (wall.uid === selectedWallUid) {
        mesh.traverse((c) => {
          if (c.isMesh) { c.material = c.material.clone(); c.material.emissive = new THREE.Color(0xff6a00); c.material.emissiveIntensity = 0.3; }
        });
        const dx = wall.x2 - wall.x1, dz = wall.z2 - wall.z1;
        const len = Math.sqrt(dx * dx + dz * dz) || 0.01;
        const outlineGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(len * 1.05, wall.height * 1.05, wall.thickness * 1.5));
        const outlineLine = new THREE.LineSegments(outlineGeo, new THREE.LineBasicMaterial({ color: 0xff6a00, depthTest: false }));
        outlineLine.position.y = wall.height / 2;
        outlineLine.renderOrder = 999;
        outlineLine.raycast = () => {};
        mesh.add(outlineLine);
      }
      wallGroup.add(mesh);
    });
  }, [walls, selectedWallUid]);

  // ===================== Sync items -> meshes (GLB real con caché + placeholder mientras carga) =====================
  const loadedUidsRef = useRef(new Set()); // evita relanzar la carga si ya se está cargando ese uid

  const PAINT_MATERIAL_NAME = "paint_color";
  const applyColorToContainer = (container, color) => {
    // primero recolectar TODOS los nombres de materiales del modelo completo
    const allMatNames = new Set();
    container.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => { if (m.name) allMatNames.add(m.name); });
    });
    const modelHasPaintMat = allMatNames.has(PAINT_MATERIAL_NAME);

    container.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((mat) => {
        // si el modelo tiene paint_color, solo tiñe ese material específico
        if (modelHasPaintMat && mat.name !== PAINT_MATERIAL_NAME) return;
        if (!mat.userData.origColor) mat.userData.origColor = mat.color ? mat.color.clone() : new THREE.Color(0xffffff);
        if (mat.color) mat.color.set(color);
      });
    });
  };

  const applySocketVisibility = (container, sockets) => {
    Object.entries(sockets || {}).forEach(([sName, val]) => {
      const socketObj = container.getObjectByName(sName);
      if (!socketObj) return;
      socketObj.visible = isRepeatableSocket(sName) ? !!(val && val.enabled) : !!val;
    });
  };

  useEffect(() => {
    const { itemGroup } = threeRef.current;
    if (!itemGroup) return;
    const currentUids = new Set(items.map((i) => i.uid));
    itemGroup.children.filter((c) => !currentUids.has(c.userData.uid)).forEach((c) => itemGroup.remove(c));

    const buildContainerContents = (container, it, def) => {
      // limpia cualquier contenido previo (placeholder o modelo real) antes de reconstruir
      while (container.children.length) {
        const c = container.children.pop();
        c.traverse((child) => {
          if (child.isMesh) { child.geometry && child.geometry.dispose(); child.material && child.material.dispose && child.material.dispose(); }
        });
      }
      container.userData.catalogId = it.catalogId;
      container.userData.kind = it.kind;
      loadedUidsRef.current.delete(it.uid); // permite recargar si el nuevo modelo trae GLB

      const pw = it.w ?? def.w, pdz = it.d ?? def.d, ph = it.h ?? def.h;
      const placeholderGeo = it.kind !== "model" ? buildPlaceholderGeometry(def.kind, pw, pdz, ph) : new THREE.BoxGeometry(def.w, def.h, def.d);
      const placeholderMat = new THREE.MeshStandardMaterial({ color: it.color || def.color || "#888888", roughness: 0.45, metalness: 0.15 });
      const placeholder = new THREE.Mesh(placeholderGeo, placeholderMat);
      placeholder.castShadow = true;
      placeholder.receiveShadow = true;
      placeholder.position.y = (it.kind !== "model" ? ph : def.h) / 2;
      placeholder.userData.isPlaceholder = true;
      placeholder.userData.curW = pw; placeholder.userData.curD = pdz; placeholder.userData.curH = ph;
      container.add(placeholder);

      if (container.userData.outline) { container.remove(container.userData.outline); container.userData.outline.geometry.dispose(); container.userData.outline.material.dispose(); }
      const phForOutline = it.kind !== "model" ? ph : def.h;
      const outline = buildOutlineBox(pw, phForOutline, pdz);
      outline.position.y = phForOutline / 2;
      outline.visible = false;
      container.userData.outline = outline;
      container.add(outline);

      if (it.kind === "model" && def.file && !loadedUidsRef.current.has(it.uid)) {
        loadedUidsRef.current.add(it.uid);
        getModelClone(def.file)
          .then((root) => {
            if (!itemGroup.children.includes(container) || container.userData.catalogId !== it.catalogId) return; // el item cambió mientras cargaba
            root.traverse((child) => {
              if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
            });
            container.remove(placeholder);
            placeholder.geometry.dispose(); placeholder.material.dispose();
            container.add(root);
            applyColorToContainer(root, it.color || def.color || "#888888");
            applySocketVisibility(root, it.sockets);
            // calcular el bounding box en espacio LOCAL del root (antes de la rotación del container)
            // para que el outline siempre tenga el tamaño correcto sin importar la rotación
            const tempParent = new THREE.Group();
            tempParent.add(root.clone());
            const box = new THREE.Box3().setFromObject(tempParent.children[0]);
            tempParent.remove(tempParent.children[0]);
            const size = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());
            container.remove(container.userData.outline);
            container.userData.outline.geometry.dispose(); container.userData.outline.material.dispose();
            const newOutline = buildOutlineBox(size.x, size.y, size.z);
            newOutline.position.copy(center);
            newOutline.visible = container.userData.wasSelected || false;
            container.userData.outline = newOutline;
            container.add(newOutline);
            // guarda la medida real en el catálogo (una sola vez) para que la tarjeta del sidebar y futuros usos ya no dependan de adivinar bien en el manifest
            if (it.kind === "model") {
              setCatalog((prev) => prev.map((c) => (
                c.id === it.catalogId && !c._measured
                  ? { ...c, w: size.x, h: size.y, d: size.z, _measured: true }
                  : c
              )));
            }
          })
          .catch((err) => console.error(`Could not load model "${def.name}" (${def.file}):`, err));
      }
    };

    items.forEach((it) => {
      let container = itemGroup.children.find((c) => c.userData.uid === it.uid);
      const def = findDef(it.kind, it.catalogId);
      if (!def) return;

      if (!container) {
        container = new THREE.Group();
        container.userData.uid = it.uid;
        container.position.y = 0;
        itemGroup.add(container);
        buildContainerContents(container, it, def);
      } else if (container.userData.catalogId !== it.catalogId || container.userData.kind !== it.kind) {
        // el objeto fue reemplazado por otro modelo/primitiva: reconstruir contenido
        buildContainerContents(container, it, def);
      }

      if (it.kind === "prop" && it.parentUid) {
        const parentItem = items.find((p) => p.uid === it.parentUid);
        if (parentItem) {
          const localVec = new THREE.Vector3(it.localOffset.x, 0, it.localOffset.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), parentItem.rotY);
          container.position.x = parentItem.x + localVec.x;
          container.position.z = parentItem.z + localVec.z;
          container.position.y = it.localOffset.y;
        } else {
          // el padre ya no existe (se borró): cae al piso en su última posición
          container.position.x = it.x;
          container.position.z = it.z;
          container.position.y = 0;
        }
      } else {
        container.position.x = it.x;
        container.position.z = it.z;
        if (it.kind === "prop") container.position.y = it.yOffset || 0;
      }
      container.rotation.y = it.rotY;

      const realModel = container.children.find((c) => !c.userData.isPlaceholder && !c.userData.isOutline);
      const isSelected = selectedUids.includes(it.uid);
      if (container.userData.outline) container.userData.outline.visible = isSelected;

      if (realModel) {
        applyColorToContainer(realModel, it.color || def.color || "#888888");
        // apply sockets: visibility for simple ones, shelf array for repeatable ones
        (def.sockets || []).forEach((socketDef) => {
          const sName = getSocketName(socketDef);
          const accessoryFile = getSocketAccessoryFile(socketDef);
          const socketObj = realModel.getObjectByName(sName);
          if (!socketObj) return;
          if (isRepeatableSocket(sName)) {
            const cfg = (it.sockets && it.sockets[sName]) || null;
            const wantCount = cfg && cfg.enabled ? Math.max(1, cfg.count || 1) : 0;
            const existing = socketObj.children.filter((c) => c.userData.isShelfClone);
            // remove excess
            existing.slice(wantCount).forEach((c) => socketObj.remove(c));
            const currentCount = Math.min(existing.length, wantCount);
            const needed = wantCount - currentCount;
            if (needed > 0) {
              if (accessoryFile) {
                getModelClone(accessoryFile).then((clone) => {
                  for (let i = 0; i < needed; i++) {
                    const c = clone.clone(true);
                    c.userData.isShelfClone = true;
                    socketObj.add(c);
                  }
                  const spacing = (cfg && cfg.spacing) || 0.3;
                  const baseHeight = (cfg && cfg.baseHeight) || 0.3;
                  socketObj.children.filter((c) => c.userData.isShelfClone).forEach((c, i) => { c.position.y = baseHeight + i * spacing; });
                }).catch(() => {});
              } else {
                for (let i = 0; i < needed; i++) {
                  const plank = new THREE.Mesh(
                    new THREE.BoxGeometry(def.w * 0.85, 0.03, def.d * 0.7 + 0.15),
                    new THREE.MeshStandardMaterial({ color: 0xd8c9a3, roughness: 0.6 })
                  );
                  plank.userData.isShelfClone = true;
                  socketObj.add(plank);
                }
              }
            }
            const spacing = (cfg && cfg.spacing) || 0.3;
            const baseHeight = (cfg && cfg.baseHeight) || 0.3;
            socketObj.children.filter((c) => c.userData.isShelfClone).forEach((c, i) => { c.position.y = baseHeight + i * spacing; });
          } else {
            const on = !!(it.sockets && it.sockets[sName]);
            const accessoryFile = getSocketAccessoryFile(socketDef);
            const existing = socketObj.children.find((c) => c.userData.isAccessory);
            if (on && !existing) {
              if (accessoryFile) {
                getModelClone(accessoryFile).then((clone) => {
                  if (!socketObj.parent) return;
                  clone.userData.isAccessory = true;
                  socketObj.add(clone);
                }).catch(() => {
                  const acc = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12), new THREE.MeshStandardMaterial({ color: 0xffe08a }));
                  acc.userData.isAccessory = true;
                  socketObj.add(acc);
                });
              } else {
                const acc = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12), new THREE.MeshStandardMaterial({ color: 0xffe08a, emissive: 0x664400 }));
                acc.userData.isAccessory = true;
                socketObj.add(acc);
              }
            } else if (!on && existing) {
              socketObj.remove(existing);
            }
          }
        });
      } else {
        const placeholder = container.children.find((c) => c.userData.isPlaceholder);
        if (placeholder) {
          placeholder.material.color.set(it.color || def.color || "#888888");

          if (it.kind === "primitive" || it.kind === "prop") {
            const w = it.w ?? def.w, d = it.d ?? def.d, h = it.h ?? def.h;
            if (placeholder.userData.curW !== w || placeholder.userData.curD !== d || placeholder.userData.curH !== h) {
              placeholder.geometry.dispose();
              placeholder.geometry = buildPlaceholderGeometry(def.kind, w, d, h);
              placeholder.position.y = h / 2;
              placeholder.userData.curW = w; placeholder.userData.curD = d; placeholder.userData.curH = h;
              if (container.userData.outline) {
                container.remove(container.userData.outline);
                container.userData.outline.geometry.dispose(); container.userData.outline.material.dispose();
                const newOutline = buildOutlineBox(w, h, d);
                newOutline.position.y = h / 2;
                newOutline.visible = isSelected;
                container.userData.outline = newOutline;
                container.add(newOutline);
              }
            }
          }

          // sockets fake (markers) solo en modo placeholder, para poder previsualizar antes de tener el GLB
          if (it.kind === "model" && def.sockets && def.sockets.length && !placeholder.userData.socketsBuilt) {
            placeholder.userData.socketsBuilt = true;
            def.sockets.forEach((socketDef, idx) => {
              const sName = getSocketName(socketDef);
              const marker = new THREE.Group();
              marker.name = sName;
              const baseY = isRepeatableSocket(sName) ? -def.h / 2 : 0;
              marker.position.set((idx - (def.sockets.length - 1) / 2) * 0.4, baseY, def.d / 2 + 0.01);
              placeholder.add(marker);
            });
          }
          (def.sockets || []).forEach((socketDef) => {
            const sName = getSocketName(socketDef);
            const accessoryFile = getSocketAccessoryFile(socketDef);
            const socketObj = placeholder.getObjectByName(sName);
            if (!socketObj) return;
            if (isRepeatableSocket(sName)) {
              const cfg = (it.sockets && it.sockets[sName]) || null;
              const wantCount = cfg && cfg.enabled ? Math.max(1, cfg.count || 1) : 0;
              const currentCount = socketObj.children.filter((c) => c.userData.isShelfClone).length;
              // remove excess
              const toRemove = socketObj.children.filter((c) => c.userData.isShelfClone).slice(wantCount);
              toRemove.forEach((c) => socketObj.remove(c));
              // add missing — usar el modelo real si hay accessoryFile, o un plank genérico como fallback
              const needed = wantCount - Math.min(currentCount, wantCount);
              if (needed > 0) {
                if (accessoryFile) {
                  getModelClone(accessoryFile).then((clone) => {
                    for (let i = 0; i < needed; i++) {
                      const c = clone.clone(true);
                      c.userData.isShelfClone = true;
                      socketObj.add(c);
                    }
                    const spacing = (cfg && cfg.spacing) || 0.3;
                    const baseHeight = (cfg && cfg.baseHeight) || 0.3;
                    socketObj.children.filter((c) => c.userData.isShelfClone).forEach((c, i) => { c.position.y = baseHeight + i * spacing; });
                  }).catch(() => {});
                } else {
                  for (let i = 0; i < needed; i++) {
                    const plank = new THREE.Mesh(
                      new THREE.BoxGeometry(def.w * 0.85, 0.03, def.d * 0.7 + 0.15),
                      new THREE.MeshStandardMaterial({ color: 0xd8c9a3, roughness: 0.6 })
                    );
                    plank.userData.isShelfClone = true;
                    socketObj.add(plank);
                  }
                }
              }
              const spacing = (cfg && cfg.spacing) || 0.3;
              const baseHeight = (cfg && cfg.baseHeight) || 0.3;
              socketObj.children.filter((c) => c.userData.isShelfClone).forEach((c, i) => { c.position.y = baseHeight + i * spacing; });
            } else {
              const on = it.sockets && it.sockets[sName];
              const accessoryFile = getSocketAccessoryFile(socketDef);
              const existing = socketObj.children.find((c) => c.userData.isAccessory);
              if (on && !existing) {
                if (accessoryFile) {
                  getModelClone(accessoryFile).then((clone) => {
                    if (!socketObj.parent) return;
                    // NO reseteamos posición/rotación — el clone hereda la del Empty de Blender
                    // NO aplicamos color — la lámpara mantiene sus materiales originales
                    clone.userData.isAccessory = true;
                    socketObj.add(clone);
                  }).catch(() => {
                    // fallback: esfera placeholder si no carga
                    const acc = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12), new THREE.MeshStandardMaterial({ color: 0xffe08a }));
                    acc.userData.isAccessory = true;
                    socketObj.add(acc);
                  });
                } else {
                  const acc = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12), new THREE.MeshStandardMaterial({ color: 0xffe08a, emissive: 0x664400 }));
                  acc.userData.isAccessory = true;
                  socketObj.add(acc);
                }
              } else if (!on && existing) {
                socketObj.remove(existing);
              }
            }
          });
        }
      }
    });
  }, [items, selectedUids, catalog]);

  // ===================== Drop new item =====================
  const placeAt = useCallback((clientX, clientY, def, kind) => {
    const rect = mountRef.current.getBoundingClientRect();
    const { getActiveCamera } = threeRef.current;
    const camera = getActiveCamera();
    const raycaster = new THREE.Raycaster();
    const p = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(p, camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const pt = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, pt);
    setItems((prev) => [...prev, {
      uid: `${def.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      catalogId: def.id, kind, x: pt.x, z: pt.z, rotY: 0,
      color: (kind === "model" || kind === "prop") ? (catalogColorsRef.current[def.id] || def.color || "#888888") : (def.color || "#888888"), sockets: {},
      yOffset: 0, parentUid: null, localOffset: null,
    }]);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    if (!dragCatalog) return;
    placeAt(e.clientX, e.clientY, dragCatalog.def, dragCatalog.kind);
    setDragCatalog(null);
  }, [dragCatalog, placeAt]);

  // ---------------- Rotación con flechas + borrar con Delete/Backspace (multi-selección) ----------------
  useEffect(() => {
    const onKeyDown = (e) => {
      // Delete/Backspace always works for walls/objects even if an input has focus,
      // UNLESS the user is actively typing in an input (has text selected or cursor inside)
      const inInput = e.target && e.target.tagName === "INPUT" && e.target.type !== "color" && e.target.type !== "range";

      if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (historyIndexRef.current > 0) {
          historyIndexRef.current--;
          const snapshot = historyRef.current[historyIndexRef.current];
          skipHistoryRef.current = true;
          setItems(snapshot.items);
          setWalls(snapshot.walls);
          setSelectedUids([]);
          setSelectedWallUid(null);
          setTimeout(() => { skipHistoryRef.current = false; }, 50);
        }
        return;
      }

      if ((e.key === "s" || e.key === "S") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveProject();
        return;
      }

      if ((e.key === "y" || e.key === "Y") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (historyIndexRef.current < historyRef.current.length - 1) {
          historyIndexRef.current++;
          const snapshot = historyRef.current[historyIndexRef.current];
          skipHistoryRef.current = true;
          setItems(snapshot.items);
          setWalls(snapshot.walls);
          setSelectedUids([]);
          setSelectedWallUid(null);
          setTimeout(() => { skipHistoryRef.current = false; }, 50);
        }
        return;
      }

      if (e.key === "Escape") {
        if (wallToolActive) {
          wallStateRef.current = { active: false, start: null, end: null };
          threeRef.current.clearWallGhost && threeRef.current.clearWallGhost();
          setWallToolActive(false);
        }
        return;
      }

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (inInput) return; // no interferir mientras escribe
        const deg = e.shiftKey ? 1 : 15;
        const delta = (e.key === "ArrowLeft" ? -1 : 1) * (deg * Math.PI / 180);
        // si hay una línea activa (modo línea, punto inicial ya puesto), las flechas ajustan su orientación
        const handledByLine = threeRef.current.adjustLineAngle && threeRef.current.adjustLineAngle(delta);
        if (handledByLine) { e.preventDefault(); return; }
        if (!selectedUids.length) return;
        e.preventDefault();
        setItems((prev) => {
          const selItems = prev.filter((it) => selectedUids.includes(it.uid));
          const allSameGroup = selItems.length > 1 && selItems.every((it) => it.groupId && it.groupId === selItems[0].groupId);
          if (allSameGroup) {
            const pivotX = selItems[0].pivotX ?? selItems[0].x;
            const pivotZ = selItems[0].pivotZ ?? selItems[0].z;
            const axis = new THREE.Vector3(0, 1, 0);
            return prev.map((it) => {
              if (!selectedUids.includes(it.uid)) return it;
              const rel = new THREE.Vector3(it.x - pivotX, 0, it.z - pivotZ).applyAxisAngle(axis, delta);
              return { ...it, x: pivotX + rel.x, z: pivotZ + rel.z, rotY: it.rotY + delta };
            });
          }
          return prev.map((it) => (selectedUids.includes(it.uid) ? { ...it, rotY: it.rotY + delta } : it));
        });
        return;
      }

      if (!selectedUids.length) return;
      if ((e.key === "d" || e.key === "D") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        duplicateSelectedRef.current();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (inInput) return; // no borrar mientras escribe en un campo de texto
        e.preventDefault();
        if (selectedWallUid) {
          setWalls((prev) => prev.filter((w) => w.uid !== selectedWallUid));
          setSelectedWallUid(null);
          return;
        }
        setItems((prev) => prev.filter((it) => !selectedUids.includes(it.uid)));
        setSelectedUids([]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedUids, wallToolActive, selectedWallUid]);

  const itemCounts = React.useMemo(() => {
    const m = {};
    items.forEach((it) => { m[it.catalogId] = (m[it.catalogId] || 0) + 1; });
    return m;
  }, [items]);

  // ===================== Selected item ops =====================
  const selectedItem = items.find((i) => i.uid === selectedUid);
  const selectedDef = selectedItem && findDef(selectedItem.kind, selectedItem.catalogId);
  const rightPanelOpen = !!(selectedItem && selectedDef);
  const isWholeGroupSelected = selectedUids.length > 1 && selectedItem?.groupId &&
    items.filter((it) => selectedUids.includes(it.uid)).every((it) => it.groupId === selectedItem.groupId);

  const updateSelected = (patch) => setItems((prev) => prev.map((it) => (it.uid === selectedUid ? { ...it, ...patch } : it)));
  const updateGroup = (patch) => setItems((prev) => prev.map((it) => (selectedUids.includes(it.uid) ? { ...it, ...patch } : it)));
  const updateColor = (color) => {
    if (isWholeGroupSelected) {
      // cada pieza del grupo mantiene su varyColor relativo al nuevo color base
      setItems((prev) => {
        const groupItems = prev.filter((it) => selectedUids.includes(it.uid));
        return prev.map((it) => {
          if (!selectedUids.includes(it.uid)) return it;
          const idx = groupItems.indexOf(it);
          return { ...it, color: varyColor(color, idx) };
        });
      });
    } else {
      updateSelected({ color });
    }
  };
  const rotateSelected = () => selectedItem && updateSelected({ rotY: selectedItem.rotY + Math.PI / 2 });
  // rotar cada objeto del grupo sobre su propio origen
  const rotateGroupEach = (deltaDeg) => {
    const delta = deltaDeg * Math.PI / 180;
    setItems((prev) => prev.map((it) => selectedUids.includes(it.uid) ? { ...it, rotY: it.rotY + delta } : it));
  };
  // rotar todo el grupo alrededor del pivote
  const rotateGroupAroundPivot = (deltaDeg) => {
    if (!selectedItem?.groupId) return;
    const delta = deltaDeg * Math.PI / 180;
    const pivotX = selectedItem.pivotX ?? selectedItem.x;
    const pivotZ = selectedItem.pivotZ ?? selectedItem.z;
    setItems((prev) => prev.map((it) => {
      if (!selectedUids.includes(it.uid)) return it;
      const dx = it.x - pivotX, dz = it.z - pivotZ;
      const cos = Math.cos(delta), sin = Math.sin(delta);
      return { ...it, x: pivotX + dx * cos - dz * sin, z: pivotZ + dx * sin + dz * cos, rotY: it.rotY + delta };
    }));
  };
  const deleteSelected = () => { setItems((prev) => prev.filter((it) => !selectedUids.includes(it.uid))); setSelectedUids([]); };
  const duplicateSelected = () => {
    if (!selectedUids.length) return;
    const offset = 0.4;
    const groupRemap = {}; // groupId viejo -> groupId nuevo (para que la copia de un grupo sea su propio grupo independiente)
    const selItems = items.filter((it) => selectedUids.includes(it.uid));
    const newItems = selItems.map((it, idx) => {
      let newGroupId = it.groupId;
      if (it.groupId) {
        if (!groupRemap[it.groupId]) groupRemap[it.groupId] = `${it.groupId}_copy_${Date.now()}`;
        newGroupId = groupRemap[it.groupId];
      }
      return {
        ...it,
        uid: `${it.catalogId}_${Date.now()}_dup${idx}_${Math.random().toString(36).slice(2, 5)}`,
        x: it.x + offset,
        z: it.z + offset,
        groupId: newGroupId,
        pivotX: it.pivotX != null ? it.pivotX + offset : it.pivotX,
        pivotZ: it.pivotZ != null ? it.pivotZ + offset : it.pivotZ,
      };
    });
    setItems((prev) => [...prev, ...newItems]);
    setSelectedUids(newItems.map((i) => i.uid));
  };
  const duplicateSelectedRef = useRef(() => {});
  useEffect(() => { duplicateSelectedRef.current = duplicateSelected; });
  const toggleSocket = (sName) => {
    if (!selectedItem) return;
    const buildNewSockets = (current) => {
      const sockets = { ...(current || {}) };
      if (isRepeatableSocket(sName)) {
        const cur = sockets[sName];
        sockets[sName] = cur && cur.enabled
          ? { ...cur, enabled: false }
          : { enabled: true, count: (cur && cur.count) || 1, spacing: (cur && cur.spacing) || 0.3, baseHeight: (cur && cur.baseHeight) || 0.3 };
      } else {
        sockets[sName] = !sockets[sName];
      }
      return sockets;
    };
    // si hay grupo completo seleccionado (2+ piezas del mismo grupo), propagar a todos
    const isWholeGroup = selectedUids.length > 1 && selectedItem.groupId &&
      items.filter((it) => selectedUids.includes(it.uid)).every((it) => it.groupId === selectedItem.groupId);
    if (isWholeGroup) {
      setItems((prev) => prev.map((it) =>
        selectedUids.includes(it.uid) ? { ...it, sockets: buildNewSockets(it.sockets) } : it
      ));
    } else {
      updateSelected({ sockets: buildNewSockets(selectedItem.sockets) });
    }
  };

  const updateSocketConfig = (sName, patch) => {
    if (!selectedItem) return;
    const buildNewSockets = (current) => {
      const sockets = { ...(current || {}) };
      sockets[sName] = { ...sockets[sName], ...patch };
      return sockets;
    };
    // propagar al grupo completo si está todo el grupo seleccionado
    const isWholeGroup = selectedUids.length > 1 && selectedItem.groupId &&
      items.filter((it) => selectedUids.includes(it.uid)).every((it) => it.groupId === selectedItem.groupId);
    if (isWholeGroup) {
      setItems((prev) => prev.map((it) =>
        selectedUids.includes(it.uid) ? { ...it, sockets: buildNewSockets(it.sockets) } : it
      ));
    } else {
      updateSelected({ sockets: buildNewSockets(selectedItem.sockets) });
    }
  };
  const replaceSelected = (newDef, newKind) => {
    if (!selectedItem) return;
    updateSelected({ catalogId: newDef.id, kind: newKind, color: newDef.color || "#888888", sockets: {} });
    setShowReplaceMenu(false);
  };
  const makeArray = () => {
    if (!selectedItem || !selectedDef) return;
    const dir = new THREE.Vector3(Math.sin(selectedItem.rotY), 0, Math.cos(selectedItem.rotY));
    const copies = [];
    for (let i = 1; i < arrayCount; i++) {
      copies.push({
        ...selectedItem,
        uid: `${selectedItem.catalogId}_${Date.now()}_arr${i}`,
        x: selectedItem.x + dir.x * arraySpacing * i,
        z: selectedItem.z + dir.z * arraySpacing * i,
      });
    }
    setItems((prev) => [...prev, ...copies]);
  };

  // ===================== Cameras =====================
  const saveCamera = () => {
    const { getRadiusThetaPhi } = threeRef.current;
    const { radius, theta, phi } = getRadiusThetaPhi();
    setCameras((prev) => [...prev, { id: Date.now(), name: `Vista ${prev.length + 1}`, radius, theta, phi }]);
  };
  const goToCamera = (cam) => {
    // simple smooth fly-to via lerp loop
    const { getRadiusThetaPhi, setRadiusThetaPhi } = threeRef.current;
    const start = getRadiusThetaPhi();
    const dur = 600; const t0 = performance.now();
    const step = () => {
      const t = Math.min((performance.now() - t0) / dur, 1);
      const e = 1 - Math.pow(1 - t, 3);
      setRadiusThetaPhi(
        start.radius + (cam.radius - start.radius) * e,
        start.theta + (cam.theta - start.theta) * e,
        start.phi + (cam.phi - start.phi) * e
      );
      if (t < 1) requestAnimationFrame(step);
    };
    step();
  };
  const deleteCamera = (id) => setCameras((prev) => prev.filter((c) => c.id !== id));

  // ===================== Render capture =====================
  const handleLoadFloorPlan = () => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/png,image/jpeg,image/jpg";
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        setFloorPlanModal({ step: "calibrate", dataUrl: ev.target.result });
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  const handleCalibrateConfirm = ({ scale, imgW, imgH }) => {
    // scale = meters per pixel
    const realW = imgW * scale;
    const realH = imgH * scale;
    // store scale info and move to outline step
    setFloorPlanModal((m) => ({ ...m, step: "outline", scale, imgW, imgH, realW, realH }));
  };

  const handleOutlineConfirm = (outlinePoints) => {
    const m = floorPlanModal;
    const realW = m.realW, realH = m.realH;
    const scale = m.scale;

    if (outlinePoints && outlinePoints.length >= 3) {
      // convertir puntos a metros (relativos al centro de la imagen)
      const pts = outlinePoints.map((p) => ({
        x: (p.x - m.imgW / 2) * scale,
        z: (p.y - m.imgH / 2) * scale,
      }));
      const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minZ = Math.min(...zs), maxZ = Math.max(...zs);
      const w = maxX - minX;
      const d = maxZ - minZ;
      // centroide del contorno = offset del piso respecto al centro de la imagen
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      setFloorW(w); setFloorD(d);
      // el plano de la imagen se centra en (0,0,0) pero el piso (floor mesh) se posiciona en el centroide
      // Para alinearlos: movemos el plano de imagen al negativo del centroide,
      // así el área del contorno queda centrada en (0,0,0) donde está el piso
      setFloorPlan({ dataUrl: m.dataUrl, realW, realH, opacity: 0.5, x: -cx, z: -cz, visible: true });
    } else {
      setFloorW(realW); setFloorD(realH);
      setFloorPlan({ dataUrl: m.dataUrl, realW, realH, opacity: 0.5, x: 0, z: 0, visible: true });
    }
    setFloorPlanModal(null);
  };

  // ===================== File menu =====================
  const buildProjectData = () => ({
    version: 1,
    name: projectName,
    savedAt: new Date().toISOString(),
    manifestUrl,
    unit,
    floorW, floorD, floorColor,
    floorPlan: floorPlan || null,
    items, walls, cameras,
    catalogColors,
  });

  const restoreProjectData = (data) => {
    if (data.name) setProjectName(data.name);
    if (data.manifestUrl) setManifestUrl(data.manifestUrl);
    if (data.unit) setUnit(data.unit);
    if (data.floorW) setFloorW(data.floorW);
    if (data.floorD) setFloorD(data.floorD);
    if (data.floorColor) setFloorColor(data.floorColor);
    setFloorPlan(data.floorPlan || null);
    setItems(data.items || []);
    setWalls(data.walls || []);
    setCameras(data.cameras || []);
    if (data.catalogColors) setCatalogColors(data.catalogColors);
    setSelectedUids([]);
    setSelectedWallUid(null);
  };

  const doSave = (name) => {
    const data = { ...buildProjectData(), name };
    setProjectName(name);
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/[^a-z0-9_-]/gi, "_")}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setSaveStatus("saved");
    setTimeout(() => setSaveStatus(null), 2000);
    setShowSaveModal(false);
    setShowFileMenu(false);
  };

  const saveProject = () => {
    // Save: usa el nombre actual sin preguntar
    doSave(projectName);
  };

  const saveProjectAs = () => {
    // Save As: abre el modal para cambiar el nombre
    setShowSaveModal(true);
    setShowFileMenu(false);
  };

  const loadProject = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          restoreProjectData(data);
        } catch (err) {
          alert("Could not read the project file. Make sure it's a valid Booth Planner JSON.");
        }
      };
      reader.readAsText(file);
    };
    input.click();
    setShowFileMenu(false);
  };

  const newProject = () => {
    if (items.length > 0 || walls.length > 0) {
      if (!window.confirm("Start a new project? All unsaved changes will be lost.")) return;
    }
    setItems([]); setWalls([]); setCameras([]);
    setFloorW(10); setFloorD(8); setFloorColor("#e9e9e9");
    setFloorPlan(null);
    setSelectedUids([]); setSelectedWallUid(null);
    setShowFileMenu(false);
  };

  // Autoguardado en localStorage cada vez que cambia el estado principal
  useEffect(() => {
    const timeout = setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(buildProjectData()));
      } catch (e) { /* localStorage lleno o bloqueado */ }
    }, 1500); // espera 1.5s de inactividad antes de guardar
    return () => clearTimeout(timeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, walls, cameras, floorW, floorD, floorColor, floorPlan, unit]);

  // Recuperar autoguardado al montar (solo si no hay items ya)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(AUTOSAVE_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        if ((data.items?.length > 0 || data.walls?.length > 0) &&
            window.confirm("A previous session was found. Restore it?")) {
          restoreProjectData(data);
        }
      }
    } catch (e) { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const captureRender = () => {
    const { scene, renderer, getActiveCamera } = threeRef.current;
    const cam = getActiveCamera();
    setSelectedUids([]);
    requestAnimationFrame(() => {
      const prevSize = renderer.getSize(new THREE.Vector2());
      const scale = 2;
      renderer.setSize(prevSize.x * scale, prevSize.y * scale, false);
      if (cam.isPerspectiveCamera) { cam.aspect = prevSize.x / prevSize.y; cam.updateProjectionMatrix(); }
      renderer.render(scene, cam);
      const url = renderer.domElement.toDataURL("image/png");
      renderer.setSize(prevSize.x, prevSize.y, false);
      if (cam.isPerspectiveCamera) cam.updateProjectionMatrix();
      const a = document.createElement("a");
      a.href = url; a.download = `booth_render_${Date.now()}.png`; a.click();
    });
  };

  return (
    <>
    {showSaveModal && (
      <div style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ background: "#1b1d22", borderRadius: 12, padding: 24, width: 360, border: "1px solid #33363d" }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Save Project As</h3>
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") doSave(projectName); if (e.key === "Escape") setShowSaveModal(false); }}
            autoFocus
            style={{ ...inputStyle, width: "100%", fontSize: 14, marginBottom: 16 }}
            placeholder="Project name"
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setShowSaveModal(false)} style={{ ...btnStyle, flex: 1 }}>Cancel</button>
            <button onClick={() => doSave(projectName)} style={{ ...btnStyle, flex: 1, background: "#2d6a4f" }}>
              💾 Save
            </button>
          </div>
        </div>
      </div>
    )}
    {floorPlanModal && (
      <FloorPlanModal
        modal={floorPlanModal}
        onConfirmCalibrate={handleCalibrateConfirm}
        onConfirmOutline={handleOutlineConfirm}
        onCancel={() => setFloorPlanModal(null)}
        unit={unit} UNITS={UNITS} toMeters={toMeters} fmt={fmt} metersTo={metersTo}
      />
    )}
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", width: "100%", background: "#0d0f18", color: "#e2e8f0", fontFamily: "Inter, system-ui, sans-serif" }}>

      {/* ===== TOP HEADER ===== */}
      <header style={{ height: 52, minHeight: 52, background: "#0d0f18", borderBottom: "1px solid #1e2035", display: "flex", alignItems: "center", padding: "0 16px", gap: 12, zIndex: 50, flexShrink: 0 }}>

        {/* Logo + app name */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginRight: 4, flexShrink: 0 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg, #5b4bff 0%, #7c6dff 100%)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <svg width="17" height="17" viewBox="0 0 16 16" fill="none"><rect x="2" y="6" width="12" height="8" rx="1" fill="white" fillOpacity="0.92"/><path d="M1 6L8 2L15 6" stroke="white" strokeWidth="1.5" strokeLinejoin="round"/><rect x="6" y="9" width="4" height="5" rx="0.5" fill="#5b4bff"/></svg>
          </div>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#fff", letterSpacing: "-0.01em" }}>Booth Planner</span>
        </div>

        {/* Divider */}
        <div style={{ width: 1, height: 20, background: "#1e2035", flexShrink: 0 }} />

        {/* Project name (editable) — centrado */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, justifyContent: "center" }}>
          {editingName ? (
            <input
              autoFocus
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              onBlur={() => setEditingName(false)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") setEditingName(false); }}
              style={{ background: "#13162a", border: "1px solid #5b4bff", borderRadius: 8, color: "#fff", padding: "4px 10px", fontSize: 14, fontWeight: 600, width: 220, textAlign: "center" }}
            />
          ) : (
            <button onClick={() => setEditingName(true)}
              style={{ background: "none", border: "none", color: "#e2e8f0", fontSize: 14, fontWeight: 600, cursor: "text", padding: "4px 8px", borderRadius: 8, display: "flex", alignItems: "center", gap: 6, letterSpacing: "-0.01em" }}>
              {projectName}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ opacity: 0.4 }}><path d="M8.5 1.5L10.5 3.5L4 10H2V8L8.5 1.5Z" stroke="currentColor" strokeWidth="1.2"/></svg>
            </button>
          )}
          {manifestStatus && manifestStatus.type !== "ok" && (
            <span style={{ fontSize: 10, color: manifestStatus.type === "error" ? "#ff8a65" : "#94a3b8" }}>
              {manifestStatus.message}
            </span>
          )}
        </div>

        {/* Right controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {/* Undo / Redo */}
          <div style={{ display: "flex", gap: 2, background: "#13162a", border: "1px solid #1e2035", borderRadius: 8, padding: 3 }}>
            <button title="Undo (Ctrl+Z)" onClick={() => {
              if (historyIndexRef.current > 0) {
                historyIndexRef.current--;
                const snap = historyRef.current[historyIndexRef.current];
                skipHistoryRef.current = true;
                setItems(snap.items); setWalls(snap.walls);
                setSelectedUids([]); setSelectedWallUid(null);
                setTimeout(() => { skipHistoryRef.current = false; }, 50);
              }
            }} style={{ ...iconBtnStyle, background: "none", border: "none", width: 28, height: 28, opacity: historyIndexRef.current > 0 ? 1 : 0.3 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 10h10a6 6 0 0 1 0 12H7"/><path d="M3 10L7 6M3 10l4 4"/></svg>
            </button>
            <button title="Redo (Ctrl+Y)" onClick={() => {
              if (historyIndexRef.current < historyRef.current.length - 1) {
                historyIndexRef.current++;
                const snap = historyRef.current[historyIndexRef.current];
                skipHistoryRef.current = true;
                setItems(snap.items); setWalls(snap.walls);
                setSelectedUids([]); setSelectedWallUid(null);
                setTimeout(() => { skipHistoryRef.current = false; }, 50);
              }
            }} style={{ ...iconBtnStyle, background: "none", border: "none", width: 28, height: 28, opacity: historyIndexRef.current < historyRef.current.length - 1 ? 1 : 0.3 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10H11a6 6 0 0 0 0 12h6"/><path d="M21 10l-4-4m4 4l-4 4"/></svg>
            </button>
          </div>

          {/* Divider */}
          <div style={{ width: 1, height: 20, background: "#1e2035" }} />

          {/* Save */}
          <button onClick={saveProject} title="Save (Ctrl+S)"
            style={{ display: "flex", alignItems: "center", gap: 6, background: "#13162a", border: "1px solid #1e2035", borderRadius: 8, color: "#e2e8f0", padding: "6px 14px", fontSize: 12, cursor: "pointer", fontWeight: 500, letterSpacing: "0.01em", position: "relative" }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17,21 17,13 7,13 7,21"/><polyline points="7,3 7,8 15,8"/></svg>
            Save
            {saveStatus === "saved" && (
              <span style={{ position: "absolute", top: 6, right: 6, width: 5, height: 5, borderRadius: "50%", background: "#4ade80" }} />
            )}
          </button>

          {/* File menu */}
          <div style={{ position: "relative" }}>
            <button onClick={() => setShowFileMenu((v) => !v)}
              style={{ display: "flex", alignItems: "center", gap: 5, background: showFileMenu ? "#1e2035" : "#13162a", border: "1px solid #1e2035", borderRadius: 8, color: "#e2e8f0", padding: "6px 12px", fontSize: 12, cursor: "pointer" }}>
              File
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ opacity: 0.6 }}><polyline points="6,9 12,15 18,9"/></svg>
            </button>
            {showFileMenu && (
              <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, background: "#13162a", border: "1px solid #1e2035", borderRadius: 10, overflow: "hidden", zIndex: 200, minWidth: 200, boxShadow: "0 12px 32px rgba(0,0,0,0.5)" }}
                onMouseLeave={() => setShowFileMenu(false)}>
                {[
                  { label: "New Project", icon: "🆕", action: newProject },
                  null,
                  { label: "Save", icon: "💾", hint: "Ctrl+S", action: saveProject },
                  { label: "Save As…", icon: "💾", action: saveProjectAs },
                  { label: "Load Project", icon: "📂", action: loadProject },
                  null,
                  { label: "Reload Library", icon: "🔄", action: () => { loadManifest(); setShowFileMenu(false); } },
                ].map((item, i) => item === null
                  ? <div key={i} style={{ height: 1, background: "#1e2035", margin: "2px 0" }} />
                  : <button key={i} onClick={item.action}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "9px 14px", fontSize: 12, background: "none", border: "none", color: "#e2e8f0", cursor: "pointer", textAlign: "left", gap: 8 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 13 }}>{item.icon}</span>
                        {item.label}
                      </span>
                      {item.hint && <span style={{ color: "#4a5068", fontSize: 10 }}>{item.hint}</span>}
                    </button>
                )}
              </div>
            )}
          </div>

          {/* Export */}
          <button onClick={captureRender}
            style={{ display: "flex", alignItems: "center", gap: 6, background: "linear-gradient(135deg, #5b4bff 0%, #7c6dff 100%)", border: "none", borderRadius: 8, color: "#fff", padding: "6px 16px", fontSize: 12, cursor: "pointer", fontWeight: 600, letterSpacing: "0.01em" }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="8,17 12,21 16,17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg>
            Export
          </button>
        </div>
      </header>

      {/* ===== MAIN CONTENT ===== */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      {/* Sidebar */}
      <div style={{ width: 300, minWidth: 300, maxWidth: 300, flexShrink: 0, background: "#0d1117", overflowY: "auto", borderRight: "1px solid #1e2035" }}>

      {/* ===== SIDEBAR CONTENT ===== */}

        {/* Project Setup */}
        <Section title="Project Setup">

          {/* Units */}
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Units</label>
            <div style={{ display: "flex", gap: 6 }}>
              {Object.keys(UNITS).map((u) => (
                <button key={u} onClick={() => setUnit(u)} style={{
                  flex: 1, padding: "7px 0", fontSize: 12, fontWeight: 600, borderRadius: 8,
                  border: "1px solid " + (unit === u ? "#5b4bff" : "#1e2035"),
                  background: unit === u ? "#5b4bff" : "#13162a",
                  color: unit === u ? "#fff" : "#94a3b8", cursor: "pointer",
                }}>{UNITS[u].label}</button>
              ))}
            </div>
          </div>

          {/* Floor & Dimensions */}
          <div style={{ background: "#13162a", border: "1px solid #1e2035", borderRadius: 10, padding: "12px", marginBottom: 12 }}>
            <label style={{ ...labelStyle, marginBottom: 10 }}>Floor & Dimensions</label>
            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4 }}>Width ({UNITS[unit].label})</label>
                <input type="number" min="0.5" step="0.1" value={fmt(metersTo(floorW, unit))}
                  onChange={(e) => setFloorW(toMeters(parseFloat(e.target.value) || 0, unit))}
                  style={{ ...inputStyle, background: "#0d1117" }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4 }}>Depth ({UNITS[unit].label})</label>
                <input type="number" min="0.5" step="0.1" value={fmt(metersTo(floorD, unit))}
                  onChange={(e) => setFloorD(toMeters(parseFloat(e.target.value) || 0, unit))}
                  style={{ ...inputStyle, background: "#0d1117" }} />
              </div>
            </div>
            <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 6 }}>Floor Color</label>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="color" value={floorColor} onChange={(e) => setFloorColor(e.target.value)}
                style={{ width: 36, height: 36, border: "1px solid #1e2035", borderRadius: 8, padding: 2, cursor: "pointer", background: "none", flexShrink: 0 }} />
              <div style={{ flex: 1, background: floorColor, height: 36, borderRadius: 8, border: "1px solid #1e2035" }} />
            </div>
          </div>

          {/* Floor Plan */}
          <button onClick={handleLoadFloorPlan} style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            background: "#13162a", border: "1px dashed #2a3050", borderRadius: 10, color: "#94a3b8",
            padding: "11px", fontSize: 12, cursor: "pointer", fontWeight: 500, marginBottom: floorPlan ? 10 : 0
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17,8 12,3 7,8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            {floorPlan ? "Replace floor plan" : "Upload Floor Plan"}
          </button>

          {floorPlan && (
            <div style={{ background: "#13162a", border: "1px solid #1e2035", borderRadius: 10, padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, color: "#e2e8f0", cursor: "pointer" }}>
                  <input type="checkbox" checked={floorPlan.visible !== false}
                    onChange={(e) => setFloorPlan((f) => ({ ...f, visible: e.target.checked }))} />
                  Show floor plan
                </label>
                <button onClick={() => setFloorPlan(null)} style={{ background: "#2d1a1a", border: "1px solid #4a2020", borderRadius: 6, color: "#f87171", padding: "3px 8px", fontSize: 11, cursor: "pointer" }}>Remove</button>
              </div>
              <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4 }}>Opacity</label>
              <input type="range" min="0.05" max="1" step="0.05" value={floorPlan.opacity ?? 0.5}
                onChange={(e) => setFloorPlan((f) => ({ ...f, opacity: parseFloat(e.target.value) }))}
                style={{ width: "100%", accentColor: "#5b4bff", marginBottom: 10 }} />
              <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 6 }}>Position ({UNITS[unit].label})</label>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 9, color: "#475569", display: "block", marginBottom: 3 }}>X</label>
                  <input type="number" step="0.1" value={fmt(metersTo(floorPlan.x ?? 0, unit))}
                    onChange={(e) => setFloorPlan((f) => ({ ...f, x: toMeters(parseFloat(e.target.value) || 0, unit) }))}
                    style={{ ...inputStyle, background: "#0d1117" }} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 9, color: "#475569", display: "block", marginBottom: 3 }}>Z</label>
                  <input type="number" step="0.1" value={fmt(metersTo(floorPlan.z ?? 0, unit))}
                    onChange={(e) => setFloorPlan((f) => ({ ...f, z: toMeters(parseFloat(e.target.value) || 0, unit) }))}
                    style={{ ...inputStyle, background: "#0d1117" }} />
                </div>
              </div>
            </div>
          )}
        </Section>

        {/* Dynamic categories from manifest — exclude Props */}
        {Array.from(new Set(catalog.filter((c) => c.category !== "Props").map((c) => c.category || "Models"))).map((cat) => {
          const catItems = catalog.filter((c) => (c.category || "Models") === cat && c.category !== "Props");
          const catCount = items.filter((it) => it.kind === "model" && catItems.some((c) => c.id === it.catalogId)).length;
          return (
            <Section key={cat} title={cat} badge={catCount > 0 ? catCount : null}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {catItems.map((c) => {
                  const thumb = thumbnails[c.id];
                  const count = itemCounts[c.id] || 0;
                  return (
                    <div key={c.id} style={{ background: "#13162a", border: "1px solid #1e2035", borderRadius: 10, overflow: "hidden", opacity: libraryReady ? 1 : 0.5, pointerEvents: libraryReady ? "auto" : "none" }}>
                      <div style={{ display: "flex", alignItems: "stretch", gap: 0 }}>

                        {/* Thumbnail — área draggable con hover "Drag" */}
                        <ModelDragArea
                          def={c} kind="model" libraryReady={libraryReady}
                          thumb={thumb} color={getCatalogColor(c)}
                          onDragStart={() => setDragCatalog({ def: c, kind: "model" })}
                        />

                        {/* Info + controls */}
                        <div style={{ flex: 1, padding: "8px 10px", display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                            {count > 0 && <span style={{ background: "#5b4bff", color: "#fff", fontSize: 9, fontWeight: 700, borderRadius: 8, padding: "1px 6px", flexShrink: 0 }}>{count}</span>}
                          </div>
                          <div style={{ fontSize: 10, color: "#475569", marginBottom: 8 }}>
                            {fmt(metersTo(c.w, unit))}×{fmt(metersTo(c.d, unit))} · h {fmt(metersTo(c.h, unit))} {UNITS[unit].label}
                          </div>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <input type="color" value={getCatalogColor(c)}
                              onChange={(e) => { e.stopPropagation(); setCatalogColor(c.id, e.target.value); }}
                              onClick={(e) => e.stopPropagation()}
                              title="Color"
                              style={{ width: 24, height: 24, borderRadius: 6, border: "1px solid #2a3050", padding: 1, cursor: "pointer", flexShrink: 0, background: "none" }}
                            />
                            <span style={{ fontSize: 10, color: "#334155", fontStyle: "italic" }}>Drag to place · select + drag ✚ to array</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>
          );
        })}

        {/* Primitives */}
        <Section title="Primitives" badge={items.filter((it) => it.kind === "primitive").length || null}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {PRIMITIVES.map((p) => {
              const PRIM_ICONS = {
                box: <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>,
                cylinder: <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/></svg>,
                sphere: <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15.3 15.3 0 0 1 4 9 15.3 15.3 0 0 1-4 9 15.3 15.3 0 0 1-4-9 15.3 15.3 0 0 1 4-9z"/></svg>,
                plane: <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5"><rect x="3" y="9" width="18" height="6" rx="1"/></svg>,
              };
              const count = itemCounts[p.id] || 0;
              return (
                <div key={p.id} draggable onDragStart={() => setDragCatalog({ def: { ...p, color: "#9aa0a6" }, kind: "primitive" })}
                  style={{ background: "#13162a", border: "1px solid #1e2035", borderRadius: 10, padding: "10px 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, cursor: "grab", position: "relative" }}>
                  {count > 0 && <span style={{ position: "absolute", top: 6, right: 6, background: "#5b4bff", color: "#fff", fontSize: 9, fontWeight: 700, borderRadius: 8, padding: "1px 5px" }}>{count}</span>}
                  {PRIM_ICONS[p.kind] || PRIM_ICONS.box}
                  <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 500 }}>{p.name}</span>
                  <button onClick={(e) => { e.stopPropagation(); setPendingLineDef({ def: { ...p, color: "#9aa0a6" }, kind: "primitive" }); }}
                    style={{ width: "100%", background: "#1e2035", border: "none", borderRadius: 6, color: "#94a3b8", padding: "3px 0", fontSize: 10, cursor: "pointer" }}>
                    Array
                  </button>
                </div>
              );
            })}
          </div>
        </Section>

        {/* Props & Accessories */}
        <Section title="Props & Accessories" badge={items.filter((it) => it.kind === "prop").length || null}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[...PROPS, ...catalog.filter((c) => c.category === "Props")].map((p) => {
              const count = itemCounts[p.id] || 0;
              const thumb = thumbnails[p.id];
              return (
                <div key={p.id} draggable onDragStart={() => setDragCatalog({ def: p, kind: "prop" })}
                  style={{ background: "#13162a", border: "1px solid #1e2035", borderRadius: 10, overflow: "hidden", cursor: "grab", position: "relative" }}>
                  {count > 0 && <span style={{ position: "absolute", top: 4, right: 4, background: "#5b4bff", color: "#fff", fontSize: 9, fontWeight: 700, borderRadius: 8, padding: "1px 5px", zIndex: 1 }}>{count}</span>}
                  <div style={{ height: 56, background: thumb ? "transparent" : (p.color || "#1e2035"), display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {thumb
                      ? <img src={thumb} alt={p.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      : <span style={{ fontSize: 18 }}>📦</span>
                    }
                  </div>
                  <div style={{ padding: "5px 6px", fontSize: 9, color: "#64748b", fontWeight: 500, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                </div>
              );
            })}
          </div>
          <p style={{ fontSize: 10, color: "#334155", marginTop: 8 }}>Drag onto an object to attach · onto floor to detach</p>
        </Section>

        {/* Array mode banner */}
        {pendingLineDef && (
          <div style={{ margin: "0 0 2px 0", background: "linear-gradient(135deg, #1e3a2f, #1a3228)", borderTop: "1px solid #2d6a4f", borderBottom: "1px solid #2d6a4f", padding: "10px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#4ade80" }}>Array: {pendingLineDef.def.name}</div>
              <button onClick={() => setPendingLineDef(null)} style={{ background: "none", border: "1px solid #2d6a4f", borderRadius: 6, color: "#4ade80", padding: "2px 8px", fontSize: 11, cursor: "pointer" }}>Cancel</button>
            </div>
            <div style={{ fontSize: 10, color: "#86efac", lineHeight: 1.5 }}>
              Click floor = start · Move mouse · <b>Scroll</b> = count ({lineCount}) · <b>← →</b> = rotate · Click again = place
            </div>
          </div>
        )}

        {/* Walls & Structure */}
        <Section title="Walls & Structure" badge={walls.length || null}>
          <button onClick={() => {
            setWallToolActive((v) => {
              if (v) { wallStateRef.current = { active: false, start: null, end: null }; threeRef.current.clearWallGhost && threeRef.current.clearWallGhost(); }
              return !v;
            });
          }} style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            background: wallToolActive ? "linear-gradient(135deg, #5b4bff, #7c6dff)" : "#13162a",
            border: wallToolActive ? "none" : "1px solid #1e2035",
            borderRadius: 10, color: wallToolActive ? "#fff" : "#94a3b8",
            padding: "11px", fontSize: 13, cursor: "pointer", fontWeight: 600, marginBottom: 12,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
            {wallToolActive ? "Stop Drawing" : "Draw Wall"}
          </button>
          {wallToolActive && (
            <div style={{ background: "#0f2a1e", border: "1px solid #1a4a30", borderRadius: 8, padding: "8px 10px", marginBottom: 10, fontSize: 10, color: "#86efac", lineHeight: 1.6 }}>
              Click = set start · Move · Click = place · <b>Shift</b> = free pos · <b>Alt</b> = free angle · <b>Esc</b> = finish
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
            <div>
              <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4 }}>Height ({UNITS[unit].label})</label>
              <input type="number" min="0.1" step="0.1" value={fmt(metersTo(wallConfig.height, unit))}
                onChange={(e) => setWallConfig((c) => ({ ...c, height: toMeters(parseFloat(e.target.value) || 0, unit) }))} style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4 }}>Thickness ({UNITS[unit].label})</label>
              <input type="number" min="0.02" step="0.02" value={fmt(metersTo(wallConfig.thickness, unit))}
                onChange={(e) => setWallConfig((c) => ({ ...c, thickness: toMeters(parseFloat(e.target.value) || 0, unit) }))} style={inputStyle} />
            </div>
          </div>
          <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4 }}>Glass ratio — {Math.round(wallConfig.glassRatio * 100)}%</label>
          <input type="range" min="0" max="1" step="0.05" value={wallConfig.glassRatio}
            onChange={(e) => setWallConfig((c) => ({ ...c, glassRatio: parseFloat(e.target.value) }))}
            style={{ width: "100%", accentColor: "#5b4bff", marginBottom: 10 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4 }}>Wall Color</label>
              <input type="color" value={wallConfig.color}
                onChange={(e) => setWallConfig((c) => ({ ...c, color: e.target.value }))}
                style={{ width: "100%", height: 32, border: "1px solid #1e2035", borderRadius: 8, padding: 2, cursor: "pointer", background: "none" }} />
            </div>
            {walls.length > 0 && (
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <button onClick={() => setWalls([])} style={{ background: "#2d1a1a", border: "1px solid #4a2020", borderRadius: 8, color: "#f87171", padding: "7px 12px", fontSize: 11, cursor: "pointer" }}>Clear all</button>
              </div>
            )}
          </div>
        </Section>

      </div>

      {/* ===== CANVAS ===== */}
      <div ref={mountRef} onDragOver={(e) => e.preventDefault()} onDrop={handleDrop} style={{ flex: 1, minWidth: 0, position: "relative" }}>
        {/* Loading overlay */}
        {!libraryReady && (
          <div style={{ position: "absolute", inset: 0, zIndex: 50, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, background: "rgba(13,15,24,0.9)", backdropFilter: "blur(4px)" }}>
            <div style={{ width: 36, height: 36, border: "3px solid #1e2035", borderTopColor: "#5b4bff", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            <style>{"@keyframes spin { to { transform: rotate(360deg); } }"}</style>
            <div style={{ fontSize: 13, color: "#94a3b8" }}>{manifestStatus ? manifestStatus.message : "Loading library…"}</div>
          </div>
        )}

        {/* View gizmo — top right */}
        <div style={{ position: "absolute", top: 12, right: 12, display: "flex", gap: 3, background: "rgba(13,17,23,0.85)", borderRadius: 10, padding: 5, backdropFilter: "blur(8px)", border: "1px solid #1e2035" }}>
          {[["free","Free","Perspective"],["top","Top","Ortho"],["front","Front","Ortho"],["side","Side","Ortho"],["iso","Iso","Ortho"]].map(([key, label, proj]) => (
            <button key={key} onClick={() => threeRef.current.setView(key)} style={{
              display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
              padding: "5px 8px", borderRadius: 7, border: "none", cursor: "pointer",
              background: activeView === key ? "#5b4bff" : "transparent",
              color: activeView === key ? "#fff" : "#64748b",
            }}>
              <span style={{ fontSize: 11, fontWeight: 600 }}>{label}</span>
              <span style={{ fontSize: 8, opacity: 0.7 }}>{proj}</span>
            </button>
          ))}
          <div style={{ width: 1, background: "#1e2035", margin: "4px 2px" }} />
          <button onClick={() => threeRef.current.resetCamera()} title="Reset camera"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 38, background: "none", border: "none", color: "#64748b", cursor: "pointer", borderRadius: 7 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
          </button>
        </div>

        {/* Camera panel button — below gizmo */}
        <div style={{ position: "absolute", top: 70, right: 12 }}>
          <button onClick={() => setShowCameraPanel((v) => !v)}
            title="Cameras"
            style={{ width: 36, height: 36, background: showCameraPanel ? "#5b4bff" : "rgba(13,17,23,0.85)", border: "1px solid #1e2035", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", backdropFilter: "blur(8px)" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={showCameraPanel ? "#fff" : "#64748b"} strokeWidth="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          </button>
          {showCameraPanel && (
            <div style={{ position: "absolute", top: 44, right: 0, background: "rgba(13,17,23,0.95)", border: "1px solid #1e2035", borderRadius: 12, padding: 12, width: 200, backdropFilter: "blur(12px)", boxShadow: "0 8px 32px rgba(0,0,0,0.5)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>Saved Views</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 10 }}>
                {cameras.length === 0 && <div style={{ fontSize: 11, color: "#334155", textAlign: "center", padding: "8px 0" }}>No saved views yet</div>}
                {cameras.map((cam) => (
                  <div key={cam.id} style={{ display: "flex", gap: 5, alignItems: "center" }}>
                    <button onClick={() => goToCamera(cam)}
                      style={{ flex: 1, background: "#13162a", border: "1px solid #1e2035", borderRadius: 7, color: "#e2e8f0", padding: "6px 8px", fontSize: 11, cursor: "pointer", textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      📷 {cam.name}
                    </button>
                    <button onClick={() => deleteCamera(cam.id)}
                      style={{ width: 26, height: 26, background: "#2d1a1a", border: "1px solid #4a2020", borderRadius: 7, color: "#f87171", cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
                  </div>
                ))}
              </div>
              <button onClick={saveCamera}
                style={{ width: "100%", background: "#13162a", border: "1px dashed #2a3050", borderRadius: 8, color: "#64748b", padding: "7px", fontSize: 11, cursor: "pointer", marginBottom: 8 }}>
                + Save current view
              </button>
              <button onClick={captureRender}
                style={{ width: "100%", background: "linear-gradient(135deg, #5b4bff, #7c6dff)", border: "none", borderRadius: 8, color: "#fff", padding: "8px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
                📸 Capture Render
              </button>
            </div>
          )}
        </div>

        {/* Contextual instructions, bottom-right */}
        <div style={{ position: "absolute", bottom: 12, right: 12, background: "rgba(27,29,34,0.85)", borderRadius: 8, padding: "10px 12px", fontSize: 11, color: "#bbb", lineHeight: 1.6, maxWidth: 280, textAlign: "right" }}>
          {pendingLineDef ? (
            <>
              <div style={{ color: "#9ad6b4", fontWeight: 600, marginBottom: 2 }}>Line mode</div>
              <div>Click: start / confirm</div>
              <div>Scroll: count ({lineCount})</div>
              <div>← →: orientation (Shift = fine)</div>
              <div>Alt: free angle (no 45° snap)</div>
            </>
          ) : selectedUids.length ? (
            <>
              <div style={{ color: "#9ad6b4", fontWeight: 600, marginBottom: 2 }}>
                {selectedUids.length > 1 ? `${selectedUids.length} selected` : "Selected"}
              </div>
              <div>← →: rotate 15° (Shift = 1°)</div>
              <div>Delete / Backspace: delete</div>
              <div>Ctrl/Cmd + D: duplicate</div>
              <div>Ctrl/Cmd + Z: undo · Ctrl/Cmd + Y: redo</div>
              <div>Shift+click: add/remove from selection</div>
              <div>Right-click + drag: orbit camera</div>
            </>
          ) : (
            <>
              <div>Click: select/move</div>
              <div>Shift+click: multi-select</div>
              <div>Right-click + drag: orbit camera</div>
              <div>Middle-click + drag: pan</div>
              <div>Scroll: zoom</div>
            </>
          )}
        </div>
      </div>

      {/* Right panel: selected item properties */}
      {/* Right panel — always visible, empty state when nothing is selected */}
      <div style={{ width: 280, minWidth: 280, maxWidth: 280, flexShrink: 0, background: "#0d1117", padding: 16, overflowY: "auto", borderLeft: "1px solid #1e2035" }}>
        {selectedWallUid && !selectedItem ? (() => {
          const selWall = walls.find((w) => w.uid === selectedWallUid);
          if (!selWall) return null;
          return (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                <div style={{ width: 3, height: 20, background: "#5b4bff", borderRadius: 2 }} />
                <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0, color: "#e2e8f0" }}>Wall Properties</h3>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                <div>
                  <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Height ({UNITS[unit].label})</label>
                  <input type="number" min="0.1" step="0.1" value={fmt(metersTo(selWall.height, unit))}
                    onChange={(e) => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, height: toMeters(parseFloat(e.target.value) || 0, unit) } : w))}
                    style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Thickness ({UNITS[unit].label})</label>
                  <input type="number" min="0.02" step="0.02" value={fmt(metersTo(selWall.thickness || 0.1, unit))}
                    onChange={(e) => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, thickness: toMeters(parseFloat(e.target.value) || 0.1, unit) } : w))}
                    style={inputStyle} />
                </div>
              </div>
              <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Glass — {Math.round(selWall.glassRatio * 100)}%</label>
              <input type="range" min="0" max="1" step="0.05" value={selWall.glassRatio}
                onChange={(e) => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, glassRatio: parseFloat(e.target.value) } : w))}
                style={{ width: "100%", accentColor: "#5b4bff", marginBottom: 12 }} />
              <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Color</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
                <input type="color" value={selWall.color}
                  onChange={(e) => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, color: e.target.value } : w))}
                  style={{ width: 36, height: 36, border: "1px solid #1e2035", borderRadius: 8, padding: 2, cursor: "pointer", background: "none", flexShrink: 0 }} />
                <div style={{ flex: 1, height: 36, background: selWall.color, borderRadius: 8, border: "1px solid #1e2035" }} />
              </div>
              <button
                onClick={() => { setWalls((prev) => prev.filter((w) => w.uid !== selectedWallUid)); setSelectedWallUid(null); }}
                style={{ width: "100%", background: "#2d1a1a", border: "1px solid #4a2020", borderRadius: 8, color: "#f87171", padding: "8px", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>
                Delete Wall
              </button>
            </>
          );
        })() : selectedItem && selectedDef ? (
          <>
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>{selectedDef.name}</h3>
          {selectedUids.length > 1 && (
            <div style={{ fontSize: 11, color: "#c4622d", marginBottom: 8 }}>
              {selectedUids.length} objects selected · ← → rotate all
            </div>
          )}
          {selectedItem.groupId && (
            <div style={{ background: "#22242a", border: "1px solid #33363d", borderRadius: 6, padding: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: "#9ad6b4", marginBottom: 6 }}>
                {selectedUids.length > 1 ? "Whole group selected" : "Individual piece (double-click) — still part of its group"}
              </div>
              <div style={{ fontSize: 10, color: "#888", marginBottom: 6 }}>
                Normal click on any piece = selects the whole group · Double-click = just that piece
              </div>
              <button
                onClick={() => {
                  setItems((prev) => prev.map((it) => (selectedUids.includes(it.uid) ? { ...it, groupId: null } : it)));
                }}
                style={{ ...btnStyle, width: "100%" }}
              >
                Ungroup {selectedUids.length > 1 ? "selection" : "this piece"}
              </button>
            </div>
          )}
          {selectedUids.length === 1 ? (
            <>
              <label style={labelStyle}>Position ({UNITS[unit].label})</label>
              <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                <input type="number" step="0.1" value={fmt(metersTo(selectedItem.x, unit))}
                  onChange={(e) => updateSelected({ x: toMeters(parseFloat(e.target.value) || 0, unit) })} style={inputStyle} placeholder="x" />
                <input type="number" step="0.1" value={fmt(metersTo(selectedItem.z, unit))}
                  onChange={(e) => updateSelected({ z: toMeters(parseFloat(e.target.value) || 0, unit) })} style={inputStyle} placeholder="z" />
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11, color: "#888", marginBottom: 8 }}>
              x: {fmt(metersTo(selectedItem.x, unit))}{UNITS[unit].label} · z: {fmt(metersTo(selectedItem.z, unit))}{UNITS[unit].label}
            </div>
          )}

          {selectedItem.kind === "primitive" && selectedUids.length === 1 && (
            <>
              <label style={labelStyle}>Size ({UNITS[unit].label})</label>
              <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                <input type="number" min="0.05" step="0.05" value={fmt(metersTo(selectedItem.w ?? selectedDef.w, unit))}
                  onChange={(e) => updateSelected({ w: Math.max(0.05, toMeters(parseFloat(e.target.value) || 0, unit)) })} style={inputStyle} placeholder="width" />
                <input type="number" min="0.05" step="0.05" value={fmt(metersTo(selectedItem.d ?? selectedDef.d, unit))}
                  onChange={(e) => updateSelected({ d: Math.max(0.05, toMeters(parseFloat(e.target.value) || 0, unit)) })} style={inputStyle} placeholder="depth" />
                <input type="number" min="0.05" step="0.05" value={fmt(metersTo(selectedItem.h ?? selectedDef.h, unit))}
                  onChange={(e) => updateSelected({ h: Math.max(0.05, toMeters(parseFloat(e.target.value) || 0, unit)) })} style={inputStyle} placeholder="height" />
              </div>
            </>
          )}

          {selectedItem.kind === "prop" && selectedUids.length === 1 && (
            <>
              {selectedItem.parentUid ? (
                <div style={{ background: "#22242a", border: "1px solid #33363d", borderRadius: 6, padding: 8, marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: "#9ad6b4", marginBottom: 6 }}>
                    Attached to: {(() => { const pIt = items.find((i) => i.uid === selectedItem.parentUid); const pDef = pIt && findDef(pIt.kind, pIt.catalogId); return pDef ? pDef.name : "object"; })()}
                  </div>
                  <label style={labelStyle}>Height ({UNITS[unit].label})</label>
                  <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                    <input type="number" step="0.05" value={fmt(metersTo(selectedItem.localOffset.y, unit))}
                      onChange={(e) => updateSelected({ localOffset: { ...selectedItem.localOffset, y: toMeters(parseFloat(e.target.value) || 0, unit) } })}
                      style={inputStyle} />
                  </div>
                  <button
                    onClick={() => updateSelected({ parentUid: null, localOffset: null, yOffset: selectedItem.localOffset.y })}
                    style={{ ...btnStyle, width: "100%" }}
                  >
                    Detach
                  </button>
                </div>
              ) : (
                <>
                  <label style={labelStyle}>Free height ({UNITS[unit].label})</label>
                  <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                    <input type="number" step="0.05" value={fmt(metersTo(selectedItem.yOffset || 0, unit))}
                      onChange={(e) => updateSelected({ yOffset: toMeters(parseFloat(e.target.value) || 0, unit) })} style={inputStyle} />
                  </div>
                  <div style={{ fontSize: 10, color: "#666", marginBottom: 12 }}>Drag it onto another object to attach it</div>
                </>
              )}
            </>
          )}

          <label style={labelStyle}>Rotation</label>
          <div style={{ fontSize: 11, color: "#777", marginBottom: 4 }}>← → = 15° · Shift + ← → = 1°</div>
          {selectedUids.length === 1 && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12 }}>
              <input
                type="number" step="1"
                value={Math.round(((selectedItem.rotY * 180 / Math.PI) % 360 + 360) % 360)}
                onChange={(e) => updateSelected({ rotY: (parseFloat(e.target.value) || 0) * Math.PI / 180 })}
                style={inputStyle}
              />
              <span style={{ fontSize: 12, color: "#888" }}>°</span>
            </div>
          )}
          {isWholeGroupSelected && (
            <>
              <div style={{ fontSize: 11, color: "#777", marginBottom: 6 }}>Group rotation</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                <button onClick={() => rotateGroupEach(-15)} style={{ ...btnStyle, flex: 1 }}>↺ Each</button>
                <button onClick={() => rotateGroupEach(15)} style={{ ...btnStyle, flex: 1 }}>↻ Each</button>
              </div>
              <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                <button onClick={() => rotateGroupAroundPivot(-15)} style={{ ...btnStyle, flex: 1 }}>↺ Pivot</button>
                <button onClick={() => rotateGroupAroundPivot(15)} style={{ ...btnStyle, flex: 1 }}>↻ Pivot</button>
              </div>
            </>
          )}
          <label style={labelStyle}>Color</label>
          <input type="color" value={selectedItem.color} onChange={(e) => updateColor(e.target.value)} style={{ width: "100%", height: 28, marginBottom: 12, border: "none", borderRadius: 6 }} />

          {selectedItem.kind === "model" && selectedDef.sockets && selectedDef.sockets.length > 0 && (
            <>
              <label style={labelStyle}>Accessories</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                {selectedDef.sockets.map((s) => {
                  const sName = getSocketName(s);
                  const repeatable = isRepeatableSocket(sName);
                  const cfg = selectedItem.sockets && selectedItem.sockets[sName];
                  return (
                    <div key={sName}>
                      <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                        <input type="checkbox" checked={repeatable ? !!(cfg && cfg.enabled) : !!cfg} onChange={() => toggleSocket(sName)} />
                        {sName.replace("socket_", "")}
                      </label>
                      {repeatable && cfg && cfg.enabled && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4, marginLeft: 20 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 10, color: "#888", width: 60 }}>Count</span>
                            <button onClick={() => updateSocketConfig(sName, { count: Math.max(1, cfg.count - 1) })} style={{ ...btnStyle, flex: "0 0 auto", padding: "2px 8px" }}>-</button>
                            <span style={{ fontSize: 12, width: 20, textAlign: "center" }}>{cfg.count}</span>
                            <button onClick={() => updateSocketConfig(sName, { count: cfg.count + 1 })} style={{ ...btnStyle, flex: "0 0 auto", padding: "2px 8px" }}>+</button>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 10, color: "#888", width: 60 }}>Spacing</span>
                            <input type="number" min="0.05" step="0.05" value={fmt(metersTo(cfg.spacing, unit))}
                              onChange={(e) => updateSocketConfig(sName, { spacing: Math.max(0.05, toMeters(parseFloat(e.target.value) || 0, unit)) })}
                              style={{ ...inputStyle, padding: "2px 6px" }} />
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 10, color: "#888", width: 60 }}>Base height</span>
                            <input type="number" min="0" step="0.05" value={fmt(metersTo(cfg.baseHeight, unit))}
                              onChange={(e) => updateSocketConfig(sName, { baseHeight: Math.max(0, toMeters(parseFloat(e.target.value) || 0, unit)) })}
                              style={{ ...inputStyle, padding: "2px 6px" }} />
                          </div>
                          {/* Apply to all — copia esta config a todos los del mismo modelo */}
                          <button
                            onClick={() => {
                              const socketConfig = selectedItem.sockets[sName];
                              if (!socketConfig) return;
                              setItems((prev) => prev.map((it) =>
                                it.uid !== selectedItem.uid && it.catalogId === selectedItem.catalogId
                                  ? { ...it, sockets: { ...it.sockets, [sName]: { ...socketConfig } } }
                                  : it
                              ));
                            }}
                            style={{ ...btnStyle, marginTop: 4, fontSize: 10, padding: "3px 0" }}
                          >
                            Apply to all {selectedDef.name}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <label style={labelStyle}>Array</label>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input type="number" min="1" value={arrayCount} onChange={(e) => setArrayCount(parseInt(e.target.value) || 1)} style={inputStyle} placeholder="qty." />
            <input type="number" min="0.1" step="0.1" value={fmt(metersTo(arraySpacing, unit))} onChange={(e) => setArraySpacing(toMeters(parseFloat(e.target.value) || 0, unit))} style={inputStyle} placeholder="spacing" />
          </div>
          <button onClick={makeArray} style={{ ...btnStyle, marginBottom: 12, width: "100%" }}>Create array</button>

          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <button onClick={rotateSelected} style={btnStyle}>Rotate 90°</button>
            <button onClick={duplicateSelected} style={btnStyle}>Duplicate</button>
            <button onClick={() => setShowReplaceMenu((s) => !s)} style={btnStyle}>Replace</button>
          </div>
          <div style={{ fontSize: 10, color: "#666", marginBottom: 6 }}>Shortcut: Ctrl/Cmd + D</div>
          {showReplaceMenu && (
            <div style={{ background: "#22242a", border: "1px solid #33363d", borderRadius: 6, padding: 6, marginBottom: 6, maxHeight: 140, overflowY: "auto" }}>
              {[...catalog.map((c) => ({ def: c, kind: "model" })), ...PRIMITIVES.map((p) => ({ def: p, kind: "primitive" }))].map(({ def, kind }) => (
                <div key={def.id} onClick={() => replaceSelected(def, kind)} style={{ fontSize: 12, padding: "4px 6px", cursor: "pointer", borderRadius: 4 }}>
                  {def.name}
                </div>
              ))}
            </div>
          )}
          <button onClick={deleteSelected} style={{ ...btnStyle, background: "#5a2424", width: "100%" }}>Delete object</button>
          </>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 8, opacity: 0.35 }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 3h18v18H3z" strokeDasharray="4 2"/>
              <path d="M9 9h6v6H9z"/>
            </svg>
            <span style={{ fontSize: 11, color: "#999", textAlign: "center" }}>Select an object<br/>to edit properties</span>
          </div>
        )}
      </div>
      </div>{/* end main content */}

      {/* ===== BOTTOM BAR — Scene summary ===== */}
      <div style={{ height: 52, minHeight: 52, background: "#0d1117", borderTop: "1px solid #1e2035", display: "flex", alignItems: "center", padding: "0 16px", gap: 8, flexShrink: 0, overflowX: "auto" }}>
        <span style={{ fontSize: 11, color: "#334155", fontWeight: 600, whiteSpace: "nowrap", marginRight: 4 }}>In scene:</span>

        {/* Model chips — one per catalogId that has items */}
        {Object.entries(itemCounts).filter(([, count]) => count > 0).map(([catalogId, count]) => {
          const def = findDef(
            items.find((it) => it.catalogId === catalogId)?.kind || "model",
            catalogId
          );
          if (!def) return null;
          const thumb = thumbnails[catalogId];
          const color = catalogColors[catalogId] || def.color || "#1e2035";
          return (
            <div key={catalogId} style={{ display: "flex", alignItems: "center", gap: 6, background: "#13162a", border: "1px solid #1e2035", borderRadius: 20, padding: "4px 10px 4px 4px", flexShrink: 0 }}>
              {/* Mini thumbnail */}
              <div style={{ width: 28, height: 28, borderRadius: 14, overflow: "hidden", flexShrink: 0, background: color }}>
                {thumb
                  ? <img src={thumb} alt={def.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <span style={{ fontSize: 9, color: "rgba(255,255,255,0.6)", fontWeight: 700 }}>{def.name.slice(0, 2).toUpperCase()}</span>
                    </div>
                }
              </div>
              <span style={{ fontSize: 11, color: "#e2e8f0", fontWeight: 500, whiteSpace: "nowrap" }}>{def.name}</span>
              <span style={{ background: "#5b4bff", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 10, padding: "1px 7px", minWidth: 18, textAlign: "center" }}>{count}</span>
            </div>
          );
        })}

        {/* Walls chip */}
        {walls.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#13162a", border: "1px solid #1e2035", borderRadius: 20, padding: "4px 10px 4px 8px", flexShrink: 0 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>
            <span style={{ fontSize: 11, color: "#e2e8f0", fontWeight: 500 }}>Walls</span>
            <span style={{ background: "#5b4bff", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 10, padding: "1px 7px" }}>{walls.length}</span>
          </div>
        )}

        {/* Empty state */}
        {Object.values(itemCounts).every((v) => !v) && walls.length === 0 && (
          <span style={{ fontSize: 11, color: "#1e2a3a", fontStyle: "italic" }}>No objects placed yet</span>
        )}
      </div>

    </div>{/* end root */}
    </>
  );
}

function ModelDragArea({ def, kind, libraryReady, thumb, color, onDragStart }) {
  const [hovered, setHovered] = React.useState(false);
  return (
    <div
      draggable={libraryReady}
      onDragStart={onDragStart}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 64, height: 64, flexShrink: 0, position: "relative", cursor: libraryReady ? "grab" : "default",
        background: thumb ? "transparent" : (color || "#1e2035"), borderRadius: "10px 0 0 10px", overflow: "hidden",
      }}
    >
      {thumb
        ? <img src={thumb} alt={def.name} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        : <div style={{ width: "100%", height: "100%", background: color || "#1e2035", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", fontWeight: 600 }}>{def.name.slice(0, 2).toUpperCase()}</span>
          </div>
      }
      {hovered && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(1px)" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/></svg>
            <span style={{ fontSize: 9, color: "#fff", fontWeight: 700, letterSpacing: "0.05em" }}>DRAG</span>
          </div>
        </div>
      )}
    </div>
  );
}

function FloorPlanModal({ modal, onConfirmCalibrate, onConfirmOutline, onCancel, unit, UNITS, toMeters, fmt, metersTo }) {
  const canvasRef = React.useRef(null);
  const [localUnit, setLocalUnit] = React.useState(unit);
  const [zoom, setZoom] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const [points, setPoints] = React.useState([]); // calibration points [{x,y}] in image coords
  const [outlinePoints, setOutlinePoints] = React.useState([]);
  const [distance, setDistance] = React.useState("3");
  const [img, setImg] = React.useState(null);
  const isPanning = React.useRef(false);
  const lastPan = React.useRef({ x: 0, y: 0 });

  React.useEffect(() => {
    if (!modal?.dataUrl) return;
    const image = new Image();
    image.onload = () => {
      setImg(image);
      // calcular zoom y pan para que la imagen quepa centrada en el canvas (800x500)
      const canvasW = 800, canvasH = 500;
      const scaleToFit = Math.min(canvasW / image.naturalWidth, canvasH / image.naturalHeight) * 0.9;
      setZoom(scaleToFit);
      setPan({ x: (canvasW - image.naturalWidth * scaleToFit) / 2, y: (canvasH - image.naturalHeight * scaleToFit) / 2 });
    };
    image.src = modal.dataUrl;
  }, [modal?.dataUrl]);

  React.useEffect(() => {
    const el = canvasRef.current;
    if (!el || !img) return;
    const ctx = el.getContext("2d");
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);
    ctx.drawImage(img, 0, 0);
    const pts = modal.step === 'calibrate' ? points : outlinePoints;
    ctx.strokeStyle = "#00e5ff"; ctx.fillStyle = "#00e5ff"; ctx.lineWidth = 2 / zoom;
    pts.forEach((p, i) => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 6 / zoom, 0, Math.PI * 2); ctx.fill();
      if (i > 0) { ctx.beginPath(); ctx.moveTo(pts[i-1].x, pts[i-1].y); ctx.lineTo(p.x, p.y); ctx.stroke(); }
    });
    if (modal.step === 'calibrate' && points.length === 2) {
      ctx.fillStyle = "#fff"; ctx.font = `${14/zoom}px sans-serif`;
      ctx.fillText(`${distance} ${UNITS[unit].label}`, (points[0].x + points[1].x)/2, (points[0].y + points[1].y)/2 - 8/zoom);
    }
    if (modal.step === 'outline' && outlinePoints.length > 2) {
      ctx.strokeStyle = "#c4622d"; ctx.beginPath();
      ctx.moveTo(outlinePoints[0].x, outlinePoints[0].y);
      outlinePoints.forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.closePath(); ctx.stroke();
      ctx.fillStyle = "rgba(196,98,45,0.15)"; ctx.fill();
    }
    ctx.restore();
  }, [img, zoom, pan, points, outlinePoints, modal.step, distance, unit]);

  const getCanvasPoint = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    // el canvas tiene tamaño interno (width/height) distinto al visual (rect) — hay que escalar
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = ((e.clientX - rect.left) * scaleX - pan.x) / zoom;
    const cy = ((e.clientY - rect.top) * scaleY - pan.y) / zoom;
    return { x: cx, y: cy };
  };

  const handleCanvasClick = (e) => {
    if (e.button !== 0) return;
    const pt = getCanvasPoint(e);
    if (modal.step === 'calibrate') {
      if (points.length < 2) setPoints((prev) => [...prev, pt]);
    } else {
      setOutlinePoints((prev) => [...prev, pt]);
    }
  };

  const handleWheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.85 : 1.18;
    setZoom((z) => Math.min(Math.max(z * factor, 0.2), 8));
  };

  const handleMouseDown = (e) => { if (e.button === 1 || e.button === 2) { isPanning.current = true; lastPan.current = { x: e.clientX, y: e.clientY }; } };
  const handleMouseMove = (e) => {
    if (!isPanning.current) return;
    const dx = e.clientX - lastPan.current.x, dy = e.clientY - lastPan.current.y;
    lastPan.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  };
  const handleMouseUp = () => { isPanning.current = false; };

  const canConfirmCalibrate = points.length === 2 && parseFloat(distance) > 0;
  const canConfirmOutline = outlinePoints.length >= 3;

  const handleConfirmCalibrate = () => {
    if (!canConfirmCalibrate || !img) return;
    const dx = points[1].x - points[0].x, dy = points[1].y - points[0].y;
    const pixelDist = Math.sqrt(dx * dx + dy * dy);
    const realDist = toMeters(parseFloat(distance), localUnit);
    const scale = realDist / pixelDist; // meters per pixel
    onConfirmCalibrate({ scale, imgW: img.naturalWidth, imgH: img.naturalHeight });
  };

  const handleConfirmOutline = () => {
    if (!canConfirmOutline) return;
    onConfirmOutline(outlinePoints);
  };

  if (!modal) return null;
  const W = img ? img.naturalWidth : 800;
  const H = img ? img.naturalHeight : 600;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.85)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#1b1d22", borderRadius: 12, padding: 20, width: "90vw", maxWidth: 900, maxHeight: "90vh", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: "#eee" }}>
            {modal.step === 'calibrate' ? "Step 1 — Calibrate scale" : "Step 2 — Trace floor outline"}
          </h2>
          <button onClick={onCancel} style={{ background: "#5a2424", border: "none", color: "#fff", borderRadius: 6, padding: "6px 12px", cursor: "pointer" }}>Cancel</button>
        </div>
        <p style={{ fontSize: 12, color: "#999", margin: 0 }}>
          {modal.step === 'calibrate'
            ? "Click two points on a wall or dimension you know the real size of. Scroll to zoom, middle-click to pan."
            : "Click to trace the floor outline polygon. Double-click last point or click Confirm when done. Scroll to zoom, middle-click to pan."}
        </p>

        {/* Canvas */}
        <div style={{ flex: 1, overflow: "hidden", border: "1px solid #33363d", borderRadius: 8, cursor: "crosshair", minHeight: 400, position: "relative" }}
          onWheel={handleWheel}
          onMouseDown={(e) => { handleCanvasClick(e); handleMouseDown(e); }}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          <canvas ref={canvasRef} width={800} height={500} style={{ width: "100%", height: "100%", display: "block" }} />
        </div>

        {/* Controls */}
        {modal.step === 'calibrate' && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 12, color: "#999" }}>Points: {points.length}/2</span>
            <span style={{ fontSize: 12, color: "#999" }}>Real distance:</span>
            <input type="number" min="0.01" step="0.1" value={distance}
              onChange={(e) => setDistance(e.target.value)}
              style={{ width: 80, background: "#22242a", border: "1px solid #33363d", borderRadius: 6, color: "#fff", padding: "4px 8px", fontSize: 12 }} />
            <div style={{ display: "flex", gap: 3 }}>
              {Object.keys(UNITS).map((u) => (
                <button key={u} onClick={() => setLocalUnit(u)}
                  style={{ padding: "3px 7px", fontSize: 11, borderRadius: 4, border: "1px solid " + (localUnit === u ? "#c4622d" : "#33363d"), background: localUnit === u ? "#c4622d" : "#22242a", color: "#fff", cursor: "pointer" }}>
                  {UNITS[u].label}
                </button>
              ))}
            </div>
            <button onClick={() => setPoints([])} style={{ background: "#33363d", border: "none", color: "#fff", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>Reset points</button>
            <div style={{ flex: 1 }} />
            <button
              onClick={handleConfirmCalibrate}
              disabled={!canConfirmCalibrate}
              style={{ background: canConfirmCalibrate ? "#2d6a4f" : "#33363d", border: "none", color: "#fff", borderRadius: 6, padding: "8px 20px", cursor: canConfirmCalibrate ? "pointer" : "default", fontSize: 13, fontWeight: 600 }}
            >
              {modal.skipOutline ? "Confirm & Place" : "Next: Trace outline →"}
            </button>
          </div>
        )}
        {modal.step === 'outline' && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 12, color: "#999" }}>Points: {outlinePoints.length} (min 3)</span>
            <button onClick={() => setOutlinePoints((p) => p.slice(0,-1))} style={{ background: "#33363d", border: "none", color: "#fff", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>Undo last</button>
            <button onClick={() => setOutlinePoints([])} style={{ background: "#33363d", border: "none", color: "#fff", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>Reset</button>
            <button onClick={() => onConfirmOutline(null)} style={{ background: "#33363d", border: "none", color: "#fff", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>Skip (use rectangle)</button>
            <div style={{ flex: 1 }} />
            <button
              onClick={handleConfirmOutline}
              disabled={!canConfirmOutline}
              style={{ background: canConfirmOutline ? "#2d6a4f" : "#33363d", border: "none", color: "#fff", borderRadius: 6, padding: "8px 20px", cursor: canConfirmOutline ? "pointer" : "default", fontSize: 13, fontWeight: 600 }}
            >
              Confirm outline ✓
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children, badge, defaultOpen = true }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div style={{ borderBottom: "1px solid #1e2035" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", background: "none", border: "none", color: "#e2e8f0", cursor: "pointer" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em" }}>{title}</span>
          {badge != null && (
            <span style={{ background: "#5b4bff", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 10, padding: "1px 7px", minWidth: 18, textAlign: "center" }}>{badge}</span>
          )}
        </div>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          style={{ transition: "transform 0.2s", transform: open ? "rotate(0deg)" : "rotate(-90deg)", opacity: 0.5 }}>
          <polyline points="6,9 12,15 18,9"/>
        </svg>
      </button>
      {open && (
        <div style={{ padding: "0 16px 16px 16px" }}>{children}</div>
      )}
    </div>
  );
}

const inputStyle = { flex: 1, background: "#13162a", border: "1px solid #1e2035", borderRadius: 8, color: "#e2e8f0", padding: "6px 10px", fontSize: 12, width: "100%" };
const btnStyle = { flex: 1, background: "#1e2035", border: "none", borderRadius: 8, color: "#e2e8f0", padding: "6px 0", fontSize: 12, cursor: "pointer" };
const labelStyle = { fontSize: 11, color: "#64748b", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 };
const iconBtnStyle = { display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, background: "#13162a", border: "1px solid #1e2035", borderRadius: 8, color: "#e2e8f0", cursor: "pointer" };
const catalogCard = { display: "flex", alignItems: "center", gap: 10, background: "#22242a", border: "1px solid #33363d", borderRadius: 8, padding: "8px 10px", cursor: "grab" };
const countBadgeStyle = { flexShrink: 0, background: "#c4622d", color: "#fff", fontSize: 11, fontWeight: 700, borderRadius: 10, padding: "2px 7px", minWidth: 18, textAlign: "center" };
const pillStyle = (active) => ({
  flex: 1, padding: "6px 0", fontSize: 12, borderRadius: 6,
  border: "1px solid " + (active ? "#c4622d" : "#33363d"),
  background: active ? "#c4622d" : "#22242a", color: "#fff", cursor: "pointer",
});
