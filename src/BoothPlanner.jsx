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

function buildWallMesh(wall) {
  const dx = wall.x2 - wall.x1, dz = wall.z2 - wall.z1;
  const len = Math.sqrt(dx * dx + dz * dz) || 0.01;
  const angle = Math.atan2(dx, dz);
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
  // Espera la carga (una sola vez por modelo) y devuelve un clon barato (geometría/material compartidos).
  return loadModelOnce(url).then((scene) => scene.clone(true));
}

function varyColor(hexColor, index) {
  if (index % 2 === 0) return hexColor; // color base tal cual
  const c = new THREE.Color(hexColor);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  const s = Math.min(1, hsl.s + 0.35);
  const l = Math.max(0.12, hsl.l - 0.1);
  c.setHSL(hsl.h, s, l);
  return `#${c.getHexString()}`;
}

export default function BoothPlannerV2() {
  const mountRef = useRef(null);
  const threeRef = useRef({});
  const [unit, setUnit] = useState("m");
  const [floorW, setFloorW] = useState(10);
  const [floorD, setFloorD] = useState(8);
  const [manifestUrl, setManifestUrl] = useState("https://raw.githubusercontent.com/Abacus-Arturo/booth-planner-library/main/models/manifest.json");
  const [catalog, setCatalog] = useState(DEFAULT_MANIFEST);
  const findDef = useCallback((kindCategory, catalogId) => {
    if (kindCategory === "model") return catalog.find((c) => c.id === catalogId);
    if (kindCategory === "primitive") return PRIMITIVES.find((p) => p.id === catalogId);
    if (kindCategory === "prop") return PROPS.find((p) => p.id === catalogId);
    return null;
  }, [catalog]);
  const [items, setItems] = useState([]); // {uid, catalogId, kind, x,z,rotY,color,sockets,groupId}
  const [walls, setWalls] = useState([]); // {uid, x1,z1,x2,z2, height, glassRatio, thickness, color}
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);
  const [selectedUids, setSelectedUids] = useState([]); // array de uids
  const [selectedWallUid, setSelectedWallUid] = useState(null);
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
  const pendingLineDefRef = useRef(null);
  const lineCountRef = useRef(5);
  const lineStateRef = useRef({ active: false, start: null });
  useEffect(() => { pendingLineDefRef.current = pendingLineDef; }, [pendingLineDef]);
  useEffect(() => { lineCountRef.current = lineCount; }, [lineCount]);

  // ---------------- Load manifest from GitHub (or any URL) ----------------
  const [manifestStatus, setManifestStatus] = useState(null); // {type:'ok'|'error', message}
  const loadManifest = useCallback(async () => {
    if (!manifestUrl) { setCatalog(DEFAULT_MANIFEST); setManifestStatus(null); return; }
    setManifestStatus({ type: "loading", message: "Loading…" });
    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error("The manifest is not a valid JSON array");
      setCatalog(data);
      setManifestStatus({ type: "ok", message: `✓ ${data.length} models loaded` });
    } catch (err) {
      console.error("Could not load the manifest, using local catalog:", err);
      setManifestStatus({ type: "error", message: `✗ ${err.message || "Unknown error while loading"}` });
      setCatalog(DEFAULT_MANIFEST);
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
        const mat = new THREE.MeshStandardMaterial({ color: def.color || "#888888", roughness: 0.45, metalness: 0.15, transparent: true, opacity: 0.45 });
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
    let dragArmed = false; // solo cuenta como "arrastre" real una vez que pasas el umbral de píxeles
    let dragStartScreenX = 0, dragStartScreenY = 0;
    const DRAG_THRESHOLD_PX = 5;
    const onDownSelect = (e) => {
      if (e.button !== 0) return;
      // ---- Wall tool flow ----
      if (wallToolActiveRef.current) {
        const ws = wallStateRef.current;
        const pt = groundPoint(e.clientX, e.clientY);
        if (!ws.active) {
          // primer click: solo marca el inicio, espera que el mouse se mueva
          ws.active = true;
          ws.start = pt.clone();
          ws.end = pt.clone();
        } else {
          // segundo click: confirma la pared solo si tiene longitud real
          const dx = ws.end.x - ws.start.x, dz = ws.end.z - ws.start.z;
          const len = Math.sqrt(dx * dx + dz * dz);
          if (len > 0.05) {
            const cfg = wallConfigRef.current;
            const uid = `wall_${Date.now()}`;
            threeRef.current.commitWall({ uid, x1: ws.start.x, z1: ws.start.z, x2: ws.end.x, z2: ws.end.z, ...cfg });
            // encadenar: el final de esta pared es el inicio de la siguiente
            ws.start = ws.end.clone();
            ws.end = ws.start.clone();
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
          const baseColor = def.color || "#888888";
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
      // check walls first
      const wallHits = raycaster.intersectObjects(wallGroup.children, true);
      if (wallHits.length) {
        let obj = wallHits[0].object;
        while (obj.parent && obj.parent !== wallGroup) obj = obj.parent;
        threeRef.current.setSelectedWall(obj.userData.wallUid);
        threeRef.current.setSelected(null);
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
      }
    };
    const SNAP_STEP = Math.PI / 4; // 45°
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
      if (wallToolActiveRef.current && wallStateRef.current.active) {
        const raw = groundPoint(e.clientX, e.clientY);
        wallStateRef.current.end = e.shiftKey ? raw : snapLineEnd(wallStateRef.current.start, raw, e.altKey);
        threeRef.current.updateWallGhost(wallStateRef.current.start, wallStateRef.current.end, wallConfigRef.current);
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
    const onUpDrag = () => { draggingUid = null; };
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
      scene, camera, renderer, itemGroup, wallGroup, floor, dom,
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
      commitWall: (wall) => setWalls((prev) => [...prev, wall]),
      clearWallGhost: () => {
        const wg = threeRef.current.wallGhost;
        if (wg) { threeRef.current.scene.remove(wg); threeRef.current.wallGhost = null; }
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

  // Floor size sync
  useEffect(() => {
    const { floor } = threeRef.current;
    if (!floor) return;
    floor.scale.set(floorW, floorD, 1);
  }, [floorW, floorD]);

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

  const applyColorToContainer = (container, color) => {
    container.traverse((child) => {
      if (child.isMesh && child.material) {
        if (!child.userData.origColor) child.userData.origColor = child.material.color ? child.material.color.clone() : new THREE.Color(0xffffff);
        if (child.material.color) child.material.color.set(color);
      }
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
        applySocketVisibility(realModel, it.sockets);
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
            def.sockets.forEach((sName, idx) => {
              const marker = new THREE.Group();
              marker.name = sName;
              const baseY = isRepeatableSocket(sName) ? -def.h / 2 : 0;
              marker.position.set((idx - (def.sockets.length - 1) / 2) * 0.4, baseY, def.d / 2 + 0.01);
              placeholder.add(marker);
            });
          }
          (def.sockets || []).forEach((sName) => {
            const socketObj = placeholder.getObjectByName(sName);
            if (!socketObj) return;
            if (isRepeatableSocket(sName)) {
              const cfg = (it.sockets && it.sockets[sName]) || null;
              const wantCount = cfg && cfg.enabled ? Math.max(1, cfg.count || 1) : 0;
              while (socketObj.children.length > wantCount) {
                const c = socketObj.children.pop();
                c.geometry.dispose(); c.material.dispose();
              }
              while (socketObj.children.length < wantCount) {
                const plank = new THREE.Mesh(
                  new THREE.BoxGeometry(def.w * 0.85, 0.03, def.d * 0.7 + 0.15),
                  new THREE.MeshStandardMaterial({ color: 0xd8c9a3, roughness: 0.6 })
                );
                socketObj.add(plank);
              }
              const spacing = (cfg && cfg.spacing) || 0.3;
              const baseHeight = (cfg && cfg.baseHeight) || 0.3;
              socketObj.children.forEach((plank, i) => { plank.position.y = baseHeight + i * spacing; });
            } else {
              const on = it.sockets && it.sockets[sName];
              let acc = socketObj.children[0];
              if (on && !acc) {
                acc = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12), new THREE.MeshStandardMaterial({ color: 0xffe08a, emissive: 0x664400 }));
                socketObj.add(acc);
              } else if (!on && acc) {
                socketObj.remove(acc);
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
      color: def.color || "#888888", sockets: {},
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
      if (e.target && (e.target.tagName === "INPUT")) return;

      if (e.key === "Escape") {
        // cancel wall tool
        if (wallToolActive) {
          wallStateRef.current = { active: false, start: null, end: null };
          threeRef.current.clearWallGhost && threeRef.current.clearWallGhost();
          setWallToolActive(false);
        }
        return;
      }

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
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

  const updateSelected = (patch) => setItems((prev) => prev.map((it) => (it.uid === selectedUid ? { ...it, ...patch } : it)));
  const rotateSelected = () => selectedItem && updateSelected({ rotY: selectedItem.rotY + Math.PI / 2 });
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
    const sockets = { ...(selectedItem.sockets || {}) };
    if (isRepeatableSocket(sName)) {
      const cur = sockets[sName];
      sockets[sName] = cur && cur.enabled
        ? { ...cur, enabled: false }
        : { enabled: true, count: (cur && cur.count) || 1, spacing: (cur && cur.spacing) || 0.3, baseHeight: (cur && cur.baseHeight) || 0.3 };
    } else {
      sockets[sName] = !sockets[sName];
    }
    updateSelected({ sockets });
  };
  const updateSocketConfig = (sName, patch) => {
    if (!selectedItem) return;
    const sockets = { ...(selectedItem.sockets || {}) };
    sockets[sName] = { ...sockets[sName], ...patch };
    updateSelected({ sockets });
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
    <div style={{ display: "flex", height: "100vh", width: "100%", background: "#13151a", color: "#eee", fontFamily: "Inter, system-ui, sans-serif" }}>
      {/* Sidebar */}
      <div style={{ width: 280, minWidth: 280, maxWidth: 280, flexShrink: 0, background: "#1b1d22", padding: 16, overflowY: "auto", borderRight: "1px solid #2a2d34" }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 2 }}>Booth Planner</h2>
        <p style={{ fontSize: 12, color: "#888", marginBottom: 14 }}>v2 · procedural + cameras + render</p>

        <Section title="Library (GitHub)">
          <input
            placeholder="manifest.json URL"
            value={manifestUrl}
            onChange={(e) => setManifestUrl(e.target.value)}
            style={inputStyle}
          />
          <button onClick={loadManifest} style={{ ...btnStyle, marginTop: 6 }}>Load library</button>
          {manifestStatus && (
            <div style={{
              fontSize: 11, marginTop: 6,
              color: manifestStatus.type === "error" ? "#ff8a65" : manifestStatus.type === "ok" ? "#9ad6b4" : "#999",
            }}>
              {manifestStatus.message}
            </div>
          )}
        </Section>

        <Section title="Units">
          <div style={{ display: "flex", gap: 4 }}>
            {Object.keys(UNITS).map((u) => (
              <button key={u} onClick={() => setUnit(u)} style={pillStyle(unit === u)}>{UNITS[u].label}</button>
            ))}
          </div>
        </Section>

        <Section title={`Floor (${UNITS[unit].label})`}>
          <div style={{ display: "flex", gap: 6 }}>
            <input type="number" min="0.5" step="0.1" value={fmt(metersTo(floorW, unit))}
              onChange={(e) => setFloorW(toMeters(parseFloat(e.target.value) || 0, unit))} style={inputStyle} />
            <span style={{ alignSelf: "center", color: "#666" }}>×</span>
            <input type="number" min="0.5" step="0.1" value={fmt(metersTo(floorD, unit))}
              onChange={(e) => setFloorD(toMeters(parseFloat(e.target.value) || 0, unit))} style={inputStyle} />
          </div>
        </Section>

        <Section title={`Models in scene: ${items.filter((it) => it.kind === "model").length}`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {catalog.map((cat) => (
              <div key={cat.id} style={catalogCard}>
                <div draggable onDragStart={() => setDragCatalog({ def: cat, kind: "model" })} style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, cursor: "grab" }}>
                  <div style={{ width: 14, height: 14, borderRadius: 3, background: cat.color, flexShrink: 0 }} />
                  <div style={{ fontSize: 12 }}>
                    <div>{cat.name}</div>
                    <div style={{ color: "#777", fontSize: 11 }}>
                      {fmt(metersTo(cat.w, unit))}×{fmt(metersTo(cat.d, unit))} {UNITS[unit].label} · h {fmt(metersTo(cat.h, unit))}{UNITS[unit].label}
                    </div>
                  </div>
                </div>
                {!!itemCounts[cat.id] && (
                  <span style={countBadgeStyle}>{itemCounts[cat.id]}</span>
                )}
                <button onClick={() => setPendingLineDef({ def: cat, kind: "model" })} style={{ ...btnStyle, flex: "0 0 auto", padding: "4px 8px", fontSize: 11, whiteSpace: "nowrap" }}>Line</button>
              </div>
            ))}
          </div>
        </Section>

        <Section title={`Primitives in scene: ${items.filter((it) => it.kind === "primitive").length}`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {PRIMITIVES.map((p) => (
              <div key={p.id} style={catalogCard}>
                <div draggable onDragStart={() => setDragCatalog({ def: { ...p, color: "#9aa0a6" }, kind: "primitive" })} style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, cursor: "grab" }}>
                  <div style={{ width: 14, height: 14, borderRadius: 3, background: "#9aa0a6", flexShrink: 0 }} />
                  <div style={{ fontSize: 12 }}>{p.name}</div>
                </div>
                {!!itemCounts[p.id] && (
                  <span style={countBadgeStyle}>{itemCounts[p.id]}</span>
                )}
                <button onClick={() => setPendingLineDef({ def: { ...p, color: "#9aa0a6" }, kind: "primitive" })} style={{ ...btnStyle, flex: "0 0 auto", padding: "4px 8px", fontSize: 11, whiteSpace: "nowrap" }}>Line</button>
              </div>
            ))}
          </div>
        </Section>

        <Section title={`Props in scene: ${items.filter((it) => it.kind === "prop").length}`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {PROPS.map((p) => (
              <div key={p.id} style={catalogCard}>
                <div draggable onDragStart={() => setDragCatalog({ def: p, kind: "prop" })} style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, cursor: "grab" }}>
                  <div style={{ width: 14, height: 14, borderRadius: 3, background: p.color, flexShrink: 0 }} />
                  <div style={{ fontSize: 12 }}>{p.name}</div>
                </div>
                {!!itemCounts[p.id] && (
                  <span style={countBadgeStyle}>{itemCounts[p.id]}</span>
                )}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10, color: "#666", marginTop: 6 }}>
            Drag them onto another object to attach (they move with it) · onto empty floor to detach
          </div>
        </Section>

        {pendingLineDef && (
          <div style={{ background: "#2d6a4f", borderRadius: 8, padding: 10, marginBottom: 16, fontSize: 12 }}>
            <div style={{ marginBottom: 6 }}>Line mode: <b>{pendingLineDef.def.name}</b></div>
            <div style={{ color: "#cde8d9", fontSize: 11, marginBottom: 8 }}>
              Click on the floor = start · move the mouse · scroll = change count ({lineCount}) · ← → = orientation · click again = confirm
            </div>
            <button onClick={() => setPendingLineDef(null)} style={{ ...btnStyle, background: "#1b1d22" }}>Cancel</button>
          </div>
        )}

        <Section title="Wall Tool">
          <button
            onClick={() => {
              setWallToolActive((v) => {
                if (v) { // canceling
                  wallStateRef.current = { active: false, start: null, end: null };
                  threeRef.current.clearWallGhost && threeRef.current.clearWallGhost();
                }
                return !v;
              });
            }}
            style={{ ...btnStyle, width: "100%", marginBottom: 8, background: wallToolActive ? "#c4622d" : "#33363d" }}
          >
            {wallToolActive ? "⬛ Stop drawing" : "🧱 Draw Wall"}
          </button>
          {wallToolActive && (
            <div style={{ fontSize: 11, color: "#9ad6b4", marginBottom: 8 }}>
              Click: set start · move · click: place · chain continues · Esc: finish
            </div>
          )}
          <label style={labelStyle}>Height ({UNITS[unit].label})</label>
          <input type="number" min="0.1" step="0.1" value={fmt(metersTo(wallConfig.height, unit))}
            onChange={(e) => setWallConfig((c) => ({ ...c, height: toMeters(parseFloat(e.target.value) || 0, unit) }))} style={{ ...inputStyle, marginBottom: 8 }} />
          <label style={labelStyle}>Glass ratio (0 = solid · 1 = all glass)</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <input type="range" min="0" max="1" step="0.05" value={wallConfig.glassRatio}
              onChange={(e) => setWallConfig((c) => ({ ...c, glassRatio: parseFloat(e.target.value) }))}
              style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: "#999", width: 32 }}>{Math.round(wallConfig.glassRatio * 100)}%</span>
          </div>
          <label style={labelStyle}>Thickness ({UNITS[unit].label})</label>
          <input type="number" min="0.02" step="0.02" value={fmt(metersTo(wallConfig.thickness, unit))}
            onChange={(e) => setWallConfig((c) => ({ ...c, thickness: toMeters(parseFloat(e.target.value) || 0, unit) }))} style={{ ...inputStyle, marginBottom: 8 }} />
          <label style={labelStyle}>Color</label>
          <input type="color" value={wallConfig.color}
            onChange={(e) => setWallConfig((c) => ({ ...c, color: e.target.value }))}
            style={{ width: "100%", height: 28, border: "none", borderRadius: 6, marginBottom: 4 }} />
          {walls.length > 0 && (
            <button onClick={() => setWalls([])} style={{ ...btnStyle, background: "#5a2424", width: "100%", marginTop: 4 }}>Clear all walls</button>
          )}
        </Section>

        <Section title="Cameras">
          <button onClick={saveCamera} style={btnStyle}>+ Save current view</button>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
            {cameras.map((cam) => (
              <div key={cam.id} style={{ display: "flex", gap: 6 }}>
                <button onClick={() => goToCamera(cam)} style={{ ...btnStyle, flex: 1, textAlign: "left" }}>{cam.name}</button>
                <button onClick={() => deleteCamera(cam.id)} style={{ ...btnStyle, background: "#5a2424", width: 28 }}>×</button>
              </div>
            ))}
          </div>
          <button onClick={captureRender} style={{ ...btnStyle, marginTop: 8, background: "#2d6a4f" }}>📸 Capture PNG render</button>
        </Section>

      </div>

      <div ref={mountRef} onDragOver={(e) => e.preventDefault()} onDrop={handleDrop} style={{ flex: 1, minWidth: 0, position: "relative" }}>
        {/* View gizmo */}
        <div style={{ position: "absolute", top: 12, right: 12, display: "flex", gap: 4, background: "rgba(27,29,34,0.85)", borderRadius: 8, padding: 6 }}>
          {[["free", "Free", "Perspective"], ["top", "Top", "Orthographic"], ["front", "Front", "Orthographic"], ["side", "Side", "Orthographic"], ["iso", "Iso", "Orthographic"]].map(([key, label, projection]) => (
            <button
              key={key}
              onClick={() => threeRef.current.setView(key)}
              style={{
                ...btnStyle, padding: "5px 10px", display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                background: activeView === key ? "#c4622d" : "#33363d",
              }}
            >
              <span>{label}</span>
              <span style={{ fontSize: 9, opacity: 0.7 }}>{projection}</span>
            </button>
          ))}
          <button onClick={() => threeRef.current.resetCamera()} style={{ ...btnStyle, padding: "5px 10px", background: "#33363d" }}>⟲ Reset</button>
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
      <div style={{ width: 280, minWidth: 280, maxWidth: 280, flexShrink: 0, background: "#1b1d22", padding: 16, overflowY: "auto", borderLeft: "1px solid #2a2d34" }}>
        {selectedWallUid && !selectedItem ? (() => {
          const selWall = walls.find((w) => w.uid === selectedWallUid);
          if (!selWall) return null;
          return (
            <>
              <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Wall</h3>
              <label style={labelStyle}>Height ({UNITS[unit].label})</label>
              <input type="number" min="0.1" step="0.1" value={fmt(metersTo(selWall.height, unit))}
                onChange={(e) => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, height: toMeters(parseFloat(e.target.value) || 0, unit) } : w))}
                style={{ ...inputStyle, marginBottom: 8 }} />
              <label style={labelStyle}>Glass ratio</label>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <input type="range" min="0" max="1" step="0.05" value={selWall.glassRatio}
                  onChange={(e) => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, glassRatio: parseFloat(e.target.value) } : w))}
                  style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: "#999", width: 32 }}>{Math.round(selWall.glassRatio * 100)}%</span>
              </div>
              <label style={labelStyle}>Color</label>
              <input type="color" value={selWall.color}
                onChange={(e) => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, color: e.target.value } : w))}
                style={{ width: "100%", height: 28, border: "none", borderRadius: 6, marginBottom: 12 }} />
              <button
                onClick={() => { setWalls((prev) => prev.filter((w) => w.uid !== selectedWallUid)); setSelectedWallUid(null); }}
                style={{ ...btnStyle, background: "#5a2424", width: "100%" }}>
                Delete wall
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
          <label style={labelStyle}>Color</label>
          <input type="color" value={selectedItem.color} onChange={(e) => updateSelected({ color: e.target.value })} style={{ width: "100%", height: 28, marginBottom: 12, border: "none", borderRadius: 6 }} />

          {selectedItem.kind === "model" && selectedDef.sockets && selectedDef.sockets.length > 0 && (
            <>
              <label style={labelStyle}>Accessories</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                {selectedDef.sockets.map((s) => {
                  const repeatable = isRepeatableSocket(s);
                  const cfg = selectedItem.sockets && selectedItem.sockets[s];
                  return (
                    <div key={s}>
                      <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                        <input type="checkbox" checked={repeatable ? !!(cfg && cfg.enabled) : !!cfg} onChange={() => toggleSocket(s)} />
                        {s.replace("socket_", "")}
                      </label>
                      {repeatable && cfg && cfg.enabled && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4, marginLeft: 20 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 10, color: "#888", width: 60 }}>Count</span>
                            <button onClick={() => updateSocketConfig(s, { count: Math.max(1, cfg.count - 1) })} style={{ ...btnStyle, flex: "0 0 auto", padding: "2px 8px" }}>-</button>
                            <span style={{ fontSize: 12, width: 20, textAlign: "center" }}>{cfg.count}</span>
                            <button onClick={() => updateSocketConfig(s, { count: cfg.count + 1 })} style={{ ...btnStyle, flex: "0 0 auto", padding: "2px 8px" }}>+</button>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 10, color: "#888", width: 60 }}>Spacing</span>
                            <input type="number" min="0.05" step="0.05" value={fmt(metersTo(cfg.spacing, unit))}
                              onChange={(e) => updateSocketConfig(s, { spacing: Math.max(0.05, toMeters(parseFloat(e.target.value) || 0, unit)) })}
                              style={{ ...inputStyle, padding: "2px 6px" }} />
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 10, color: "#888", width: 60 }}>Base height</span>
                            <input type="number" min="0" step="0.05" value={fmt(metersTo(cfg.baseHeight, unit))}
                              onChange={(e) => updateSocketConfig(s, { baseHeight: Math.max(0, toMeters(parseFloat(e.target.value) || 0, unit)) })}
                              style={{ ...inputStyle, padding: "2px 6px" }} />
                          </div>
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
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ fontSize: 11, color: "#999", textTransform: "uppercase", letterSpacing: 0.5 }}>{title}</label>
      <div style={{ marginTop: 6 }}>{children}</div>
    </div>
  );
}

const inputStyle = { flex: 1, background: "#22242a", border: "1px solid #33363d", borderRadius: 6, color: "#fff", padding: "6px 8px", fontSize: 12, width: "100%" };
const btnStyle = { flex: 1, background: "#33363d", border: "none", borderRadius: 6, color: "#fff", padding: "6px 0", fontSize: 12, cursor: "pointer" };
const labelStyle = { fontSize: 11, color: "#999", display: "block", marginBottom: 4 };
const catalogCard = { display: "flex", alignItems: "center", gap: 10, background: "#22242a", border: "1px solid #33363d", borderRadius: 8, padding: "8px 10px", cursor: "grab" };
const countBadgeStyle = { flexShrink: 0, background: "#c4622d", color: "#fff", fontSize: 11, fontWeight: 700, borderRadius: 10, padding: "2px 7px", minWidth: 18, textAlign: "center" };
const pillStyle = (active) => ({
  flex: 1, padding: "6px 0", fontSize: 12, borderRadius: 6,
  border: "1px solid " + (active ? "#c4622d" : "#33363d"),
  background: active ? "#c4622d" : "#22242a", color: "#fff", cursor: "pointer",
});
