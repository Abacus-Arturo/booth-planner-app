import React, { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";

const APP_VERSION = "1.3.0";

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
const PROPS = [];

// ===================== Group hierarchy helpers (max 3 levels) =====================
// groupIds: [] = no group, ["g1"] = in one group, ["g1","g2"] = g1 inside g2, etc.
// Index 0 = innermost, last index = outermost (active for selection/drag)
const getGroupIds = (it) => Array.isArray(it?.groupIds) ? it.groupIds : (it?.groupId ? [it.groupId] : []);
const getOuterGroupId = (it) => { const ids = getGroupIds(it); return ids.length ? ids[ids.length - 1] : null; };
const getInnerGroupId = (it) => { const ids = getGroupIds(it); return ids.length ? ids[0] : null; };
const withOuterGroup = (it, gid) => ({ ...it, groupIds: [...getGroupIds(it), gid], groupId: undefined });
const withoutOuterGroup = (it) => { const ids = getGroupIds(it); return { ...it, groupIds: ids.slice(0, -1), groupId: undefined }; };
const migrateItem = (it) => it.groupIds ? it : { ...it, groupIds: it.groupId ? [it.groupId] : [], groupId: undefined };

function isRepeatableSocket(socketName) {
  return socketName.includes("shelf");
}
// sockets en el manifest pueden ser string ("socket_shelf") u objeto ({name, accessoryFile})
function getSocketName(s) { return typeof s === "string" ? s : s.name; }
function getSocketAccessoryFile(s) { return typeof s === "string" ? null : (s.accessoryFile || null); }

function buildWallMesh(wall, allWalls = []) {
  // Door
  if (wall.type === "door") {
    const t = wall.thickness || 0.1;
    const dw = wall.width || 0.9;
    const dh = wall.height || 2.1;          // clear opening height
    const wallH = wall.wallHeight || dh + 0.3; // full wall height above door
    const openAngle = (wall.openAngle || 0) * Math.PI / 180;
    const wdx = wall.x2 - wall.x1, wdz = wall.z2 - wall.z1;
    const len = Math.sqrt(wdx * wdx + wdz * wdz) || 0.01;
    const angle = Math.atan2(wdx, wdz) - Math.PI / 2;
    const cx = (wall.x1 + wall.x2) / 2, cz = (wall.z1 + wall.z2) / 2;
    const frameColor = wall.color || "#a07840";

    const group = new THREE.Group();
    group.position.set(cx, 0, cz);
    group.rotation.y = angle;
    group.userData.isWall = true;

    const frameMat = new THREE.MeshStandardMaterial({ color: frameColor, roughness: 0.7, metalness: 0.1 });
    const wallMat = new THREE.MeshStandardMaterial({ color: wall.wallColor || "#cccccc", roughness: 0.8, metalness: 0.05 });

    const jw = 0.05; // jamb width

    // Left jamb — sits at the very edge of the opening, no overlap with neighbors
    const ljGeo = new THREE.BoxGeometry(jw, dh, t);
    const lj = new THREE.Mesh(ljGeo, frameMat);
    lj.position.set(-len / 2 + jw / 2, dh / 2, 0);
    lj.castShadow = true;
    group.add(lj);

    // Right jamb
    const rj = new THREE.Mesh(ljGeo, frameMat);
    rj.position.set(len / 2 - jw / 2, dh / 2, 0);
    rj.castShadow = true;
    group.add(rj);

    // Lintel — exactly spans the opening, sits at dh
    const lintelH = Math.max(0.05, wallH - dh);
    const lintelGeo = new THREE.BoxGeometry(len, lintelH, t);
    const lintel = new THREE.Mesh(lintelGeo, wallMat);
    lintel.position.set(0, dh + lintelH / 2, 0);
    lintel.castShadow = true;
    group.add(lintel);

    // Thin header trim on lintel bottom
    const headerGeo = new THREE.BoxGeometry(len, 0.04, t);
    const header = new THREE.Mesh(headerGeo, frameMat);
    header.position.set(0, dh - 0.02, 0);
    group.add(header);

    // Door leaf — pivots from hinge side, flips inward/outward
    if (dh > 0.1) {
      const leafColor = wall.leafColor || "#c8a96e";
      const doorMat = new THREE.MeshStandardMaterial({ color: leafColor, roughness: 0.5, metalness: 0.05 });
      const leafGeo = new THREE.BoxGeometry(dw, dh - 0.02, t * 0.5);
      const leaf = new THREE.Mesh(leafGeo, doorMat);
      leaf.castShadow = true;
      const flip = wall.flipSide ? -1 : 1;      // 1 = inward, -1 = outward
      const hingeRight = wall.hingeSide === 'right'; // default left
      const pivot = new THREE.Group();
      const hingeX = hingeRight ? len / 2 - jw : -len / 2 + jw;
      pivot.position.set(hingeX, 0, 0);
      // leaf extends away from hinge
      leaf.position.set((hingeRight ? -1 : 1) * dw / 2, dh / 2, 0);
      pivot.rotation.y = flip * openAngle * (hingeRight ? -1 : 1);
      pivot.add(leaf);

      // Handle — knob + backplate on both faces
      const handleMat = new THREE.MeshStandardMaterial({ color: "#b8a060", roughness: 0.3, metalness: 0.8 });
      const knobGeo = new THREE.SphereGeometry(0.025, 12, 12);
      const barGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.1, 8);
      const handleOffset = (hingeRight ? -1 : 1) * (dw - 0.12); // near far edge from hinge
      const handleY = dh * 0.45;
      [-1, 1].forEach(side => {
        const knob = new THREE.Mesh(knobGeo, handleMat);
        knob.position.set(handleOffset, handleY, side * (t * 0.28));
        pivot.add(knob);
        const bar = new THREE.Mesh(barGeo, handleMat);
        bar.rotation.z = Math.PI / 2;
        bar.position.set(handleOffset, handleY, side * (t * 0.28 + 0.05));
        pivot.add(bar);
      });

      group.add(pivot);
    }

    return group;
  }

  // Column
  if (wall.type === "column") {
    const group = new THREE.Group();
    group.position.set(wall.x, 0, wall.z);
    if (wall.rotY) group.rotation.y = wall.rotY;
    const mat = new THREE.MeshStandardMaterial({ color: wall.color || "#cccccc", roughness: 0.7, metalness: 0.05 });
    let geo;
    if (wall.shape === "circular") {
      geo = new THREE.CylinderGeometry(wall.radius, wall.radius, wall.height, 32);
    } else {
      geo = new THREE.BoxGeometry(wall.width, wall.height, wall.depth);
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = wall.height / 2;
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    group.userData.isWall = true;
    return group;
  }

  // Wall — compute miter extension at each endpoint
  const t = wall.thickness || 0.1;
  const snapDist = t * 1.5;
  const otherWalls = allWalls.filter(w => w.uid !== wall.uid && w.type !== 'column');

  const ptConnects = (px, pz) => otherWalls.some(w => {
    if (w.type === 'door') return false; // never miter into a door opening
    return Math.hypot(w.x1-px, w.z1-pz) < snapDist || Math.hypot(w.x2-px, w.z2-pz) < snapDist;
  });

  const extStart = (!wall.noMiterStart && ptConnects(wall.x1, wall.z1)) ? t / 2 : 0;
  const extEnd   = (!wall.noMiterEnd   && ptConnects(wall.x2, wall.z2)) ? t / 2 : 0;

  const dx = wall.x2 - wall.x1, dz = wall.z2 - wall.z1;
  const len = Math.sqrt(dx * dx + dz * dz) || 0.01;
  const extLen = len + extStart + extEnd;
  const angle = Math.atan2(dx, dz) - Math.PI / 2;
  const h = wall.height, gr = Math.min(Math.max(wall.glassRatio, 0), 1);
  const solidH = h * (1 - gr), glassH = h * gr;

  // offset center by miter asymmetry
  const dirX = dx / len, dirZ = dz / len;
  const cx = (wall.x1 + wall.x2) / 2 + dirX * (extEnd - extStart) / 2;
  const cz = (wall.z1 + wall.z2) / 2 + dirZ * (extEnd - extStart) / 2;

  const group = new THREE.Group();
  group.position.set(cx, 0, cz);
  group.rotation.y = angle;

  if (solidH > 0.001) {
    const solidMat = new THREE.MeshStandardMaterial({ color: wall.color || "#cccccc", roughness: 0.8, metalness: 0.05 });
    const solid = new THREE.Mesh(new THREE.BoxGeometry(extLen, solidH, t), solidMat);
    solid.position.y = solidH / 2;
    solid.castShadow = true; solid.receiveShadow = true;
    group.add(solid);
  }
  if (glassH > 0.001) {
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0xddeeff, transparent: true, opacity: 0.25,
      roughness: 0, metalness: 0.05,
      transmission: 0.88, thickness: t, ior: 1.5,
      side: THREE.DoubleSide,
    });
    const glass = new THREE.Mesh(new THREE.BoxGeometry(extLen, glassH, t * 0.4), glassMat);
    glass.position.y = solidH + glassH / 2;
    group.add(glass);
  }
  group.userData.isWall = true;
  return group;
}

// Colors per nesting level for selection outline (outermost = index 0 of reversed groupIds)
const GROUP_LEVEL_COLORS = [
  0xff6a00, // level 1 — orange (default, no group)
  0x00e5ff, // level 2 — cyan
  0xa855f7, // level 3 — purple
  0xf59e0b, // level 4 — amber
  0x4ade80, // level 5+ — green
];

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
  const unitRef = useRef("m");
  useEffect(() => { unitRef.current = unit; }, [unit]);
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
  const [floorColor, setFloorColor] = useState("#878787");

  // Floor plan image
  const [floorPlan, setFloorPlan] = useState(null); // { dataUrl, realW, realH, opacity, x, z, visible }
  const [floorPlanModal, setFloorPlanModal] = useState(null); // { step: 'calibrate'|'outline', dataUrl, ... }
  const floorPlanFileRef = useRef(null);
  const DEFAULT_MANIFEST_URL = window.location.pathname.includes('/dev/')
    ? 'https://raw.githubusercontent.com/Abacus-Arturo/booth-planner-library/dev/models/manifest.json'
    : 'https://raw.githubusercontent.com/Abacus-Arturo/booth-planner-library/main/models/manifest.json';
  const [manifestUrl, setManifestUrl] = useState(DEFAULT_MANIFEST_URL);
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
  const [items, setItems] = useState([]); // {uid, catalogId, kind, x,z,rotY,color,sockets,groupIds}
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
  const selectedUidsRef = useRef([]);
  useEffect(() => { selectedUidsRef.current = selectedUids; }, [selectedUids]);
  const [selectedWallUid, setSelectedWallUid] = useState(null);
  const draggingWallHandleRef = useRef(null); // { type, wallUid/groupId/sourceUid, endpoint/role }
  const arrayHandleActiveRef = useRef(false); // true cuando estamos en modo array desde handle
  const [arrayHandleActive, setArrayHandleActive] = useState(false);
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
  const wallSessionIdRef = useRef(null);
  const [floorDark, setFloorDark] = useState(false);
  const floorColorRef = useRef("#878787");
  useEffect(() => { floorColorRef.current = floorColor; }, [floorColor]);
  const [measureToolActive, setMeasureToolActive] = useState(false);
  const measureToolActiveRef = useRef(false);
  useEffect(() => { measureToolActiveRef.current = measureToolActive; }, [measureToolActive]);
  const measureStateRef = useRef({ active: false, start: null, measures: [] });
  const [wallConfig, setWallConfig] = useState({ height: 2.4, glassRatio: 0, thickness: 0.1, color: "#cccccc" });
  const [columnConfig, setColumnConfig] = useState({ shape: "square", radius: 0.15, width: 0.3, depth: 0.3, height: 2.4, color: "#cccccc" });
  const [columnToolActive, setColumnToolActive] = useState(false);
  const columnToolActiveRef = useRef(false);
  useEffect(() => { columnToolActiveRef.current = columnToolActive; }, [columnToolActive]);
  const columnConfigRef = useRef(columnConfig);
  useEffect(() => { columnConfigRef.current = columnConfig; }, [columnConfig]);
  const columnLastClickRef = useRef(0);
  const [layerVisibility, setLayerVisibility] = useState({ models: true, primitives: true, props: true, walls: true });
  const [layerLock, setLayerLock] = useState({ models: false, primitives: false, props: false, walls: false });
  const [showSceneList, setShowSceneList] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState('properties'); // 'properties' | 'scene'

  const layerLockRef = useRef({ models: false, primitives: false, props: false, walls: false });
  useEffect(() => { layerLockRef.current = layerLock; }, [layerLock]);
  const [hiddenCatalogIds, setHiddenCatalogIds] = useState(new Set());
  const [appSettings, setAppSettings] = useState({ animations: true });
  const [showSettings, setShowSettings] = useState(false);
  const [showIslandBuilder, setShowIslandBuilder] = useState(false);
  const [layoutMode, setLayoutMode] = useState(false);
  const layoutModeRef = useRef(false);
  useEffect(() => { layoutModeRef.current = layoutMode; }, [layoutMode]);
  const [layout2dTool, setLayout2dTool] = useState("select"); // select | wall | column | door | model
  const setLayoutModeUIRef = useRef(null);
  useEffect(() => { setLayoutModeUIRef.current = setLayoutMode; }, []);
  const appSettingsRef = useRef(appSettings);
  useEffect(() => { appSettingsRef.current = appSettings; }, [appSettings]);
  const toggleCatalogVisibility = (id) => setHiddenCatalogIds((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const wallStateRef = useRef({ active: false, start: null, end: null, lockedAngle: null });
  const shiftKeyRef = useRef(false); // reliable shift tracking via keydown/keyup
  const altKeyRef = useRef(false);
  // tracks which nesting level the user is currently "inside" for click selection
  // -1 = outermost (last groupIds index), going down toward 0 (innermost) on dblclick
  const selectionDepthRef = useRef(null); // null = not in a group context
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
      const w = mount.clientWidth, h = mount.clientHeight;
      const aspect = w / h;
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
      new THREE.MeshStandardMaterial({ color: 0x878787, roughness: 0.85, metalness: 0.05 })
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

    const setTopMode = (isTop, isLayout = false) => {
      if (isTop) {
        hemi.intensity = 0;
        ambient.intensity = isLayout ? 3.5 : 2.2;
        key.intensity = 0;
        fill.intensity = 0;
        rim.intensity = 0;
        floor.material.color.setHex(isLayout ? 0x0d0f18 : 0xf0f0f0);
        floor.material.roughness = 1;
        renderer.shadowMap.enabled = false;
      } else {
        hemi.intensity = 0.7;
        ambient.intensity = 0.25;
        key.intensity = 2.4;
        fill.intensity = 0.5;
        rim.intensity = 0.7;
        floor.material.color.setHex(floorColorRef.current ? parseInt(floorColorRef.current.replace('#',''), 16) : 0x878787);
        floor.material.roughness = 0.85;
        renderer.shadowMap.enabled = true;
      }
    };

    const setView = (name) => {
      if (name === "free") {
        useOrtho = false; activeCam = camera;
        camera.aspect = mount.clientWidth / mount.clientHeight; camera.updateProjectionMatrix();
        setTopMode(false);
      } else {
        const a = VIEW_ANGLES[name];
        theta = a.theta; phi = a.phi;
        useOrtho = true; activeCam = orthoCam;
        updateCamera();
        setTopMode(name === "top");
      }
    };

    let isOrbiting = false, lastX = 0, lastY = 0;
    let isPanning = false, panLastX = 0, panLastY = 0;
    const dom = renderer.domElement;
    const onDown = (e) => {
      if (layoutModeRef.current) {
        // in layout mode only allow pan, no orbit
        if (e.button === 1 || (e.button === 0 && e.ctrlKey)) { isPanning = true; panLastX = e.clientX; panLastY = e.clientY; e.preventDefault(); }
        return;
      }
      if (e.button === 2) { isOrbiting = true; lastX = e.clientX; lastY = e.clientY; }
      else if (e.button === 1) { isPanning = true; panLastX = e.clientX; panLastY = e.clientY; e.preventDefault(); }
      else if (e.button === 0 && e.altKey) { isOrbiting = true; lastX = e.clientX; lastY = e.clientY; e.preventDefault(); }
      else if (e.button === 0 && e.ctrlKey) { isPanning = true; panLastX = e.clientX; panLastY = e.clientY; e.preventDefault(); }
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
      e.preventDefault();
      // Normalizar deltaY según deltaMode (pixel vs line vs page)
      const normY = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const normX = e.deltaMode === 1 ? e.deltaX * 20 : e.deltaMode === 2 ? e.deltaX * 400 : e.deltaX;

      // Dos dedos con componente horizontal = pan (trackpad/Magic Mouse)
      if (Math.abs(normX) > Math.abs(normY) * 0.3 && !e.ctrlKey) {
        const forward = new THREE.Vector3().subVectors(target, activeCam.position).normalize();
        const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
        const upV = new THREE.Vector3().crossVectors(right, forward).normalize();
        const panSpeed = radius * 0.003;
        target.addScaledVector(right, normX * panSpeed * 0.01);
        target.addScaledVector(upV, -normY * panSpeed * 0.01);
        updateCamera();
        return;
      }

      // Array mode: scroll = cantidad de copias
      if (lineStateRef.current.active) {
        const delta = normY > 0 ? -1 : 1;
        const next = Math.max(1, lineCountRef.current + delta);
        lineCountRef.current = next;
        threeRef.current.setLineCountUI(next);
        buildLineGhostsWithOffset(lineStateRef.current.start, lineStateRef.current.end, next, pendingLineDefRef.current);
        return;
      }
      if (arrayHandleActiveRef.current) {
        const delta = normY > 0 ? -1 : 1;
        const next = Math.max(1, lineCountRef.current + delta);
        lineCountRef.current = next;
        threeRef.current.setLineCountUI(next);
        const state = threeRef.current._arrayDragState;
        if (state) threeRef.current.buildArrayGhosts(state.origin, state.endPt, next, state.src, 0);
        return;
      }

      // Zoom — normalizado y menos sensible
      const zoomDelta = normY * 0.003;
      const minRadius = layoutModeRef.current ? 1 : 3;
      const maxRadius = layoutModeRef.current ? 80 : 40;
      radius = Math.min(Math.max(radius + zoomDelta * radius * 0.1, minRadius), maxRadius);
      updateCamera();
    };
    const onCtx = (e) => e.preventDefault();
    const onMouseLeave = () => { hoverSphere.visible = false; hoveredUid = null; hideColumnGhost(); };
    dom.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMoveOrbit);
    window.addEventListener("pointerup", onUp);
    dom.addEventListener("wheel", onWheel, { passive: false });
    dom.addEventListener("contextmenu", onCtx);
    dom.addEventListener("pointerleave", onMouseLeave);

    // ---- Item group + drag/select ----
    const itemGroup = new THREE.Group();
    scene.add(itemGroup);
    const wallGroup = new THREE.Group();
    scene.add(wallGroup);
    const handleGroup = new THREE.Group();
    scene.add(handleGroup);
    const ghostGroup = new THREE.Group();
    scene.add(ghostGroup);

    // Measure tool
    const measureGroup = new THREE.Group();
    scene.add(measureGroup);
    // preview line while drawing
    const measureLineMat = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.15, gapSize: 0.08, depthTest: false });
    const measureLineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const measurePreviewLine = new THREE.Line(measureLineGeo, measureLineMat);
    measurePreviewLine.computeLineDistances();
    measurePreviewLine.visible = false;
    measurePreviewLine.renderOrder = 997;
    scene.add(measurePreviewLine);
    // preview label sprite
    const makeMeasureLabel = (text) => {
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'rgba(13,15,24,0.85)';
      ctx.roundRect(4, 4, 248, 56, 10);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 28px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, 128, 32);
      const tex = new THREE.CanvasTexture(canvas);
      const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(1.2, 0.3, 1);
      sprite.renderOrder = 997;
      return sprite;
    };
    const measurePreviewLabel = makeMeasureLabel('0.00m');
    measurePreviewLabel.visible = false;
    scene.add(measurePreviewLabel);
    // start dot
    const measureStartDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false })
    );
    measureStartDot.visible = false;
    measureStartDot.renderOrder = 997;
    scene.add(measureStartDot);

    // Column ghost
    const columnGhostMat = new THREE.MeshStandardMaterial({ color: 0xc4622d, transparent: true, opacity: 0.35 });
    let columnGhostMesh = null;
    const updateColumnGhost = (x, z) => {
      if (columnGhostMesh) scene.remove(columnGhostMesh);
      const cfg = columnConfigRef.current;
      let geo;
      if (cfg.shape === "circular") geo = new THREE.CylinderGeometry(cfg.radius, cfg.radius, cfg.height, 32);
      else geo = new THREE.BoxGeometry(cfg.width, cfg.height, cfg.depth);
      columnGhostMesh = new THREE.Mesh(geo, columnGhostMat);
      columnGhostMesh.position.set(x, cfg.height / 2, z);
      columnGhostMesh.raycast = () => {};
      scene.add(columnGhostMesh);
    };
    const hideColumnGhost = () => { if (columnGhostMesh) { scene.remove(columnGhostMesh); columnGhostMesh = null; } };
    const hoverSphereMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff, depthTest: false, transparent: true, opacity: 0.9 });
    const hoverSphere = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12), hoverSphereMat);
    hoverSphere.visible = false;
    hoverSphere.renderOrder = 998;
    hoverSphere.raycast = () => {};
    scene.add(hoverSphere);
    let hoveredUid = null;

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
    let wallDragGroupOrig = {}; // uid -> {x1,z1,x2,z2} for grouped walls
    let dragArmed = false; // solo cuenta como "arrastre" real una vez que pasas el umbral de píxeles
    let dragStartScreenX = 0, dragStartScreenY = 0;
    const DRAG_THRESHOLD_PX = 5;
    // Measure tool helpers
    const formatDist = (meters) => {
      const u = unitRef.current || 'm';
      if (u === 'ft') return `${(meters * 3.28084).toFixed(2)}ft`;
      if (u === 'in') return `${(meters * 39.3701).toFixed(1)}in`;
      return `${meters.toFixed(2)}m`;
    };
    const snapMeasurePoint = (raw) => {
      const SNAP_DIST = 0.3;
      let best = raw.clone(), bestD = SNAP_DIST;
      // snap to object corners
      itemGroup.children.forEach((c) => {
        if (!c.visible) return;
        const box = new THREE.Box3().setFromObject(c);
        const corners = [
          new THREE.Vector3(box.min.x, 0, box.min.z),
          new THREE.Vector3(box.max.x, 0, box.min.z),
          new THREE.Vector3(box.min.x, 0, box.max.z),
          new THREE.Vector3(box.max.x, 0, box.max.z),
        ];
        corners.forEach((corner) => {
          const d = raw.distanceTo(corner);
          if (d < bestD) { best = corner; bestD = d; }
        });
      });
      // snap to wall endpoints
      wallsRef.current.forEach((w) => {
        [new THREE.Vector3(w.x1, 0, w.z1), new THREE.Vector3(w.x2, 0, w.z2)].forEach((p) => {
          const d = raw.distanceTo(p);
          if (d < bestD) { best = p; bestD = d; }
        });
      });
      return best;
    };

    const onDownSelect = (e) => {
      if (e.button !== 0) return;
      if (e.altKey || e.ctrlKey) return;
      // ---- Column tool ----
      if (columnToolActiveRef.current) {
        const now = Date.now();
        if (now - (columnLastClickRef.current || 0) < 300) return; // ignore second click of dblclick
        columnLastClickRef.current = now;
        const raw = groundPoint(e.clientX, e.clientY);
        const cfg = columnConfigRef.current;
        const uid = `col_${Date.now()}`;
        setWalls((prev) => [...prev, {
          uid, type: "column",
          x: raw.x, z: raw.z,
          shape: cfg.shape, radius: cfg.radius,
          width: cfg.width, depth: cfg.depth,
          height: cfg.height, color: cfg.color,
        }]);
        return;
      }
      // ---- Wall tool flow ----
      if (measureToolActiveRef.current) {
        const raw = groundPoint(e.clientX, e.clientY);
        const pt = e.shiftKey ? raw : snapMeasurePoint(raw);
        const ms = measureStateRef.current;
        const { measurePreviewLine, measurePreviewLabel, measureStartDot, measureGroup, makeMeasureLabel: mkLabel } = threeRef.current;
        if (!ms.start) {
          ms.start = pt.clone();
          measureStartDot.position.copy(pt).setY(0.05);
          measureStartDot.visible = true;
        } else {
          const dist = ms.start.distanceTo(pt);
          if (dist > 0.05) {
            const lineGeo = new THREE.BufferGeometry().setFromPoints([ms.start.clone(), pt.clone()]);
            const line = new THREE.Line(lineGeo, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.15, gapSize: 0.08, depthTest: false }));
            line.computeLineDistances(); line.renderOrder = 997;
            measureGroup.add(line);
            [ms.start, pt].forEach((p) => {
              const dot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
              dot.position.copy(p).setY(0.05); dot.renderOrder = 997;
              measureGroup.add(dot);
            });
            const mid = ms.start.clone().lerp(pt, 0.5);
            const label = mkLabel(formatDist(dist));
            label.position.copy(mid).setY(0.35);
            measureGroup.add(label);
          }
          ms.start = pt.clone();
          measureStartDot.position.copy(pt).setY(0.05);
        }
        return;
      }

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
            const groupId = wallSessionIdRef.current;
            threeRef.current.commitWall({ uid, x1: ws.start.x, z1: ws.start.z, x2: ws.end.x, z2: ws.end.z, groupId, ...cfg });
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
              color: varyColor(baseColor, i), sockets: {}, groupIds: [groupId],
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
              if (h.userData.isColumnHandle) {
                draggingWallHandleRef.current = { type: 'columnScale', wallUid: h.userData.wallUid, axis: h.userData.axis, dir: h.userData.dir };
              } else if (h.userData.isColumnMove) {
                draggingWallHandleRef.current = { type: 'columnMove', wallUid: h.userData.wallUid };
              } else {
                draggingWallHandleRef.current = { type: 'wall', wallUid: h.userData.wallUid, endpoint: h.userData.endpoint };
              }
            } else if (h.userData.isLineHandle) {
              const groupId = h.userData.groupId;
              const groupItems = itemsRef.current.filter((it) => getOuterGroupId(it) === groupId);
              if (groupItems.length) {
                const pivot = { x: h.userData.pivotX, z: h.userData.pivotZ };
                const src = [...groupItems].sort((a, b) =>
                  Math.hypot(a.x - pivot.x, a.z - pivot.z) - Math.hypot(b.x - pivot.x, b.z - pivot.z)
                )[0];
                arrayHandleActiveRef.current = true;
                arrayHandleSourceRef.current = { ...src };
                lineCountRef.current = groupItems.length - 1;
                threeRef.current.setLineCountUI(groupItems.length - 1);
                threeRef.current.setArrayHandleActive(true);
                draggingWallHandleRef.current = { type: 'array', groupId };
                h.visible = false;
                // ocultar todos los items del grupo
                groupItems.forEach((it) => {
                  const c = itemGroup.children.find((c) => c.userData.uid === it.uid);
                  if (c) c.visible = false;
                });
              }
            } else if (h.userData.isArrayHandle) {
              if (h.userData.sourceGroupId) {
                const groupUids = h.userData.sourceGroupUids || [];
                const groupItems = itemsRef.current.filter((it) => groupUids.includes(it.uid));
                if (groupItems.length) {
                  const pivotItem = groupItems.find((it) => it.pivotX != null) || groupItems[0];
                  arrayHandleActiveRef.current = true;
                  arrayHandleSourceRef.current = { ...pivotItem, _isGroupArray: true, _groupUids: groupUids };
                  lineCountRef.current = 1;
                  threeRef.current.setLineCountUI(1);
                  threeRef.current.setArrayHandleActive(true);
                  draggingWallHandleRef.current = { type: 'array' };
                  h.visible = false;
                }
              } else {
                const srcItem = itemsRef.current.find((it) => it.uid === h.userData.sourceUid);
                if (srcItem) {
                  arrayHandleActiveRef.current = true;
                  arrayHandleSourceRef.current = { ...srcItem };
                  lineCountRef.current = 1;
                  threeRef.current.setLineCountUI(1);
                  threeRef.current.setArrayHandleActive(true);
                  draggingWallHandleRef.current = { type: 'array' };
                  h.visible = false;
                }
              }
            }
            dragArmed = false;
            dragStartScreenX = e.clientX; dragStartScreenY = e.clientY;
            return;
          }
        }
      }
      // check walls first — filtrar los que están ocultos (layer visibility)
      const wallHits = raycaster.intersectObjects(wallGroup.children, true).filter((h) => {
        let obj = h.object;
        while (obj.parent && obj.parent !== wallGroup) obj = obj.parent;
        return obj.visible && !layerLockRef.current.walls;
      });
      const hits = raycaster.intersectObjects(itemGroup.children, true).filter((h) => {
        let obj = h.object;
        while (obj.parent && obj.parent !== itemGroup) obj = obj.parent;
        if (!obj.visible) return false;
        const it = itemsRef.current.find((i) => i.uid === obj.userData.uid);
        if (!it) return true;
        if (it.kind === "model" && layerLockRef.current.models) return false;
        if (it.kind === "primitive" && layerLockRef.current.primitives) return false;
        if (it.kind === "prop" && layerLockRef.current.props) return false;
        return true;
      });
      // solo seleccionar pared si está más cerca que cualquier objeto
      if (wallHits.length && (!hits.length || wallHits[0].distance < hits[0].distance)) {
        let obj = wallHits[0].object;
        while (obj.parent && obj.parent !== wallGroup) obj = obj.parent;
        const wuid = obj.userData.wallUid;
        threeRef.current.setSelectedWall(wuid);
        threeRef.current.setSelected(null);
        const wallData = wallsRef.current.find((w) => w.uid === wuid);
        if (wallData) {
          draggingWallUid = wuid;
          dragArmed = false;
          dragStartScreenX = e.clientX; dragStartScreenY = e.clientY;
          wallDragStartPt = groundPoint(e.clientX, e.clientY);
          if (wallData.type === "column") {
            wallDragOrigX1 = wallData.x; wallDragOrigZ1 = wallData.z;
            wallDragOrigX2 = wallData.x; wallDragOrigZ2 = wallData.z;
          } else if (wallData.groupId) {
            // store all walls in the group
            wallDragGroupOrig = {};
            wallsRef.current.filter((w) => w.groupId === wallData.groupId).forEach((w) => {
              wallDragGroupOrig[w.uid] = { x1: w.x1, z1: w.z1, x2: w.x2, z2: w.z2 };
            });
            wallDragOrigX1 = wallData.x1; wallDragOrigZ1 = wallData.z1;
            wallDragOrigX2 = wallData.x2; wallDragOrigZ2 = wallData.z2;
          } else {
            wallDragOrigX1 = wallData.x1; wallDragOrigZ1 = wallData.z1;
            wallDragOrigX2 = wallData.x2; wallDragOrigZ2 = wallData.z2;
          }
        }
        return;
      }
      if (hits.length) {
        let obj = hits[0].object;
        while (obj.parent && obj.parent !== itemGroup) obj = obj.parent;
        threeRef.current.setSelectedWall(null); // deselect wall when clicking object
        draggingUid = obj.userData.uid;
        dragArmed = false;
        dragStartScreenX = e.clientX; dragStartScreenY = e.clientY;
        const clickedItem = itemsRef.current.find((it) => it.uid === draggingUid);
        const clickedGroupIds = getGroupIds(clickedItem);

        if (clickedGroupIds.length && !e.shiftKey) {
          const startPt = groundPoint(e.clientX, e.clientY);
          // if the clicked item is already part of the current selection, keep the whole selection
          if (selectedUidsRef.current.includes(draggingUid)) {
            dragOffsetsRef.current = {};
            selectedUidsRef.current.forEach((uid) => {
              const it = itemsRef.current.find((i) => i.uid === uid);
              if (it) dragOffsetsRef.current[uid] = {
                dx: it.x - startPt.x, dz: it.z - startPt.z,
                pivotDx: it.pivotX != null ? it.pivotX - startPt.x : null,
                pivotDz: it.pivotZ != null ? it.pivotZ - startPt.z : null,
              };
            });
          } else {
            // determine which level to select based on selectionDepthRef
            const depth = selectionDepthRef.current;
            let activeLevel;
            if (depth === null || depth >= clickedGroupIds.length) {
              activeLevel = clickedGroupIds.length - 1; // outermost
            } else {
              activeLevel = depth;
            }
            selectionDepthRef.current = activeLevel;
            const activeGroupId = clickedGroupIds[activeLevel];
            // select all items that contain this groupId anywhere in their groupIds array
            const groupUids = itemsRef.current
              .filter((it) => getGroupIds(it).includes(activeGroupId))
              .map((it) => it.uid);
            threeRef.current.setSelectedGroup(groupUids);
            dragOffsetsRef.current = {};
            groupUids.forEach((uid) => {
              const it = itemsRef.current.find((i) => i.uid === uid);
              if (it) dragOffsetsRef.current[uid] = {
                dx: it.x - startPt.x, dz: it.z - startPt.z,
                pivotDx: it.pivotX != null ? it.pivotX - startPt.x : null,
                pivotDz: it.pivotZ != null ? it.pivotZ - startPt.z : null,
              };
            });
          }
        } else if (clickedGroupIds.length && e.shiftKey) {
          // Shift+click on a grouped item: add/remove whole outer group to selection
          const activeGroupId = clickedGroupIds[clickedGroupIds.length - 1]; // outermost
          const groupUids = itemsRef.current
            .filter((it) => getGroupIds(it).includes(activeGroupId))
            .map((it) => it.uid);
          const alreadySelected = groupUids.every((uid) => selectedUidsRef.current.includes(uid));
          const newSelection = alreadySelected
            ? selectedUidsRef.current.filter((uid) => !groupUids.includes(uid))
            : [...new Set([...selectedUidsRef.current, ...groupUids])];
          threeRef.current.setSelectedGroup(newSelection);
          // drag offsets for entire new selection
          const startPt = groundPoint(e.clientX, e.clientY);
          dragOffsetsRef.current = {};
          newSelection.forEach((uid) => {
            const it = itemsRef.current.find((i) => i.uid === uid);
            if (it) dragOffsetsRef.current[uid] = {
              dx: it.x - startPt.x, dz: it.z - startPt.z,
              pivotDx: it.pivotX != null ? it.pivotX - startPt.x : null,
              pivotDz: it.pivotZ != null ? it.pivotZ - startPt.z : null,
            };
          });
        } else {
          threeRef.current.setSelected(draggingUid, e.shiftKey);
          if (!e.shiftKey) selectionDepthRef.current = null;
          const startPt = groundPoint(e.clientX, e.clientY);
          const currentSelected = selectedUidsRef.current;
          // if clicking an already-selected item, drag all selected together
          const groupUidsForDrag = currentSelected.includes(draggingUid)
            ? currentSelected
            : [draggingUid];
          dragOffsetsRef.current = {};
          groupUidsForDrag.forEach((uid) => {
            const it = itemsRef.current.find((i) => i.uid === uid);
            if (it) dragOffsetsRef.current[uid] = {
              dx: it.x - startPt.x, dz: it.z - startPt.z,
              pivotDx: it.pivotX != null ? it.pivotX - startPt.x : null,
              pivotDz: it.pivotZ != null ? it.pivotZ - startPt.z : null,
            };
          });
        }
      } else {
        threeRef.current.setSelected(null);
        threeRef.current.setSelectedWall(null);
        selectionDepthRef.current = null;
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
      shiftKeyRef.current = e.shiftKey;
      altKeyRef.current = e.altKey;
      // ---- Hover highlight ----
      if (!draggingUid && !draggingWallUid && !draggingWallHandleRef.current) {
        const rect = dom.getBoundingClientRect();
        pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, activeCam);
        const hoverItemHits = raycaster.intersectObjects(itemGroup.children, true).filter((h) => {
          let obj = h.object; while (obj.parent && obj.parent !== itemGroup) obj = obj.parent;
          if (!obj.visible) return false;
          const it = itemsRef.current.find((i) => i.uid === obj.userData.uid);
          if (!it) return true;
          if (it.kind === "model" && layerLockRef.current.models) return false;
          if (it.kind === "primitive" && layerLockRef.current.primitives) return false;
          if (it.kind === "prop" && layerLockRef.current.props) return false;
          return true;
        });
        const hoverWallHits = raycaster.intersectObjects(wallGroup.children, true).filter((h) => {
          let obj = h.object; while (obj.parent && obj.parent !== wallGroup) obj = obj.parent;
          return obj.visible && !layerLockRef.current.walls;
        });
        const wallCloser = hoverWallHits.length && (!hoverItemHits.length || hoverWallHits[0].distance < hoverItemHits[0].distance);

        if (wallCloser) {
          // hover sobre pared
          let obj = hoverWallHits[0].object;
          while (obj.parent && obj.parent !== wallGroup) obj = obj.parent;
          const uid = obj.userData.wallUid;
          if (uid !== hoveredUid) {
            hoveredUid = uid;
            const box = new THREE.Box3().setFromObject(obj);
            const top = box.max.y + 0.2;
            const center = box.getCenter(new THREE.Vector3());
            hoverSphere.position.set(center.x, top, center.z);
            hoverSphere.visible = true;
          }
        } else if (hoverItemHits.length) {
          // hover sobre objeto
          let obj = hoverItemHits[0].object;
          while (obj.parent && obj.parent !== itemGroup) obj = obj.parent;
          const uid = obj.userData.uid;
          if (uid !== hoveredUid) {
            hoveredUid = uid;
            const box = new THREE.Box3().setFromObject(obj);
            const top = box.max.y + 0.2;
            const center = box.getCenter(new THREE.Vector3());
            hoverSphere.position.set(center.x, top, center.z);
            hoverSphere.visible = true;
          }
        } else {
          hoveredUid = null;
          hoverSphere.visible = false;
        }
      } else {
        hoveredUid = null;
        hoverSphere.visible = false;
      }

      // ---- Wall/Line handle drag ----
      if (draggingWallHandleRef.current) {
        const isArrayDrag = draggingWallHandleRef.current.type === 'array';
        if (!dragArmed) {
          const dx = e.clientX - dragStartScreenX, dy = e.clientY - dragStartScreenY;
          // array: no threshold — ghosts aparecen inmediatamente
          if (!isArrayDrag && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          dragArmed = true;
          // ocultar items del array en el primer move real
          if (isArrayDrag && arrayHandleSourceRef.current) {
            const src = arrayHandleSourceRef.current;
            const existingGroupId = draggingWallHandleRef.current.groupId;
            let uidsToHide = [];
            if (src._isGroupArray) {
              uidsToHide = src._groupUids || [];
            } else if (existingGroupId) {
              uidsToHide = itemsRef.current.filter((it) => getOuterGroupId(it) === existingGroupId).map((it) => it.uid);
            } else {
              uidsToHide = [src.uid];
            }
            uidsToHide.forEach((uid) => {
              const c = itemGroup.children.find((c) => c.userData.uid === uid);
              if (c) c.visible = false;
            });
          }
        }
        const raw = groundPoint(e.clientX, e.clientY);
        const handle = draggingWallHandleRef.current;

        if (handle.type === 'columnMove') {
          setWalls((prev) => prev.map((w) => w.uid === handle.wallUid ? { ...w, x: raw.x, z: raw.z } : w));

        } else if (handle.type === 'columnScale') {
          const wall = wallsRef.current.find((w) => w.uid === handle.wallUid);
          if (!wall) return;
          // mover solo el lado del handle — el lado opuesto queda fijo
          if (handle.axis === 'x') {
            if (wall.shape === "circular") {
              const newR = Math.max(0.05, handle.dir > 0 ? raw.x - wall.x : wall.x - raw.x);
              setWalls((prev) => prev.map((w) => w.uid === handle.wallUid ? { ...w, radius: newR } : w));
            } else {
              const oppositeEdge = handle.dir > 0 ? wall.x - wall.width / 2 : wall.x + wall.width / 2;
              const newW = Math.max(0.1, handle.dir > 0 ? raw.x - oppositeEdge : oppositeEdge - raw.x);
              const newX = handle.dir > 0 ? oppositeEdge + newW / 2 : oppositeEdge - newW / 2;
              setWalls((prev) => prev.map((w) => w.uid === handle.wallUid ? { ...w, width: newW, x: newX } : w));
            }
          } else {
            if (wall.shape === "circular") {
              const newR = Math.max(0.05, handle.dir > 0 ? raw.z - wall.z : wall.z - raw.z);
              setWalls((prev) => prev.map((w) => w.uid === handle.wallUid ? { ...w, radius: newR } : w));
            } else {
              const oppositeEdge = handle.dir > 0 ? wall.z - wall.depth / 2 : wall.z + wall.depth / 2;
              const newD = Math.max(0.1, handle.dir > 0 ? raw.z - oppositeEdge : oppositeEdge - raw.z);
              const newZ = handle.dir > 0 ? oppositeEdge + newD / 2 : oppositeEdge - newD / 2;
              setWalls((prev) => prev.map((w) => w.uid === handle.wallUid ? { ...w, depth: newD, z: newZ } : w));
            }
          }

        } else if (handle.type === 'wall') {
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
          const n = Math.max(1, lineCountRef.current);
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
          // no overlap: distancia mínima = ancho del objeto × copias
          const minDist = (def?.w || 1) * n;
          dist = Math.max(Math.max(0.1, dist), minDist);
          const endPt = new THREE.Vector3(
            origin.x + Math.sin(angle) * dist,
            0,
            origin.z + Math.cos(angle) * dist
          );
          threeRef.current.buildArrayGhosts(origin, endPt, n, src, 0);
        }
        return;
      }
      if (columnToolActiveRef.current) {
        const raw = groundPoint(e.clientX, e.clientY);
        updateColumnGhost(raw.x, raw.z);
        return;
      }

      if (measureToolActiveRef.current) {
        const raw = groundPoint(e.clientX, e.clientY);
        const pt = e.shiftKey ? raw : snapMeasurePoint(raw);
        const ms = measureStateRef.current;
        const { measurePreviewLine, measurePreviewLabel, measureStartDot } = threeRef.current;
        if (ms.start) {
          // update preview line
          const positions = measurePreviewLine.geometry.attributes.position;
          positions.setXYZ(0, ms.start.x, 0.05, ms.start.z);
          positions.setXYZ(1, pt.x, 0.05, pt.z);
          positions.needsUpdate = true;
          measurePreviewLine.geometry.computeBoundingSphere();
          measurePreviewLine.computeLineDistances();
          measurePreviewLine.visible = true;
          // update label
          const dist = ms.start.distanceTo(pt);
          const mid = ms.start.clone().lerp(pt, 0.5);
          measurePreviewLabel.position.copy(mid).setY(0.35);
          measurePreviewLabel.material.map.dispose();
          const canvas = document.createElement('canvas');
          canvas.width = 256; canvas.height = 64;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = 'rgba(13,15,24,0.85)';
          ctx.roundRect(4, 4, 248, 56, 10); ctx.fill();
          ctx.fillStyle = '#00e5ff';
          ctx.font = 'bold 28px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(formatDist(dist), 128, 32);
          measurePreviewLabel.material.map = new THREE.CanvasTexture(canvas);
          measurePreviewLabel.material.needsUpdate = true;
          measurePreviewLabel.visible = true;
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
          const { pt: posSnapped, snapped: didSnap } = snapWallPoint(raw, false, wallsRef.current, floorWRef.current, floorDRef.current);
          const isShift = e.shiftKey || shiftKeyRef.current;
          const isAlt = e.altKey || altKeyRef.current;
          if (isAlt) {
            ws.lockedAngle = null;
            ws.end = posSnapped;
          } else if (isShift) {
            // Lock angle: capture it the moment Shift is first pressed, then only vary length
            if (ws.lockedAngle === null) {
              const cur = new THREE.Vector3().subVectors(ws.end, ws.start);
              const curLen = cur.length();
              if (curLen > 0.001) {
                const curAngle = Math.atan2(cur.x, cur.z);
                ws.lockedAngle = Math.round(curAngle / SNAP_STEP) * SNAP_STEP;
              } else {
                ws.lockedAngle = 0;
              }
            }
            const a = ws.lockedAngle;
            const dir = new THREE.Vector3().subVectors(raw, ws.start);
            const len = Math.max(0.01, dir.x * Math.sin(a) + dir.z * Math.cos(a));
            ws.end = new THREE.Vector3(ws.start.x + Math.sin(a) * len, 0, ws.start.z + Math.cos(a) * len);
          } else {
            ws.lockedAngle = null;
            ws.end = snapLineEnd(ws.start, posSnapped, false);
          }
          snapIndicator.position.set(posSnapped.x, 0.01, posSnapped.z);
          snapIndicator.visible = didSnap;
          threeRef.current.updateWallGhost(ws.start, ws.end, wallConfigRef.current);
        }
        return;
      }
      // drag de pared/columna seleccionada
      if (draggingWallUid) {
        if (!dragArmed) {
          const dx = e.clientX - dragStartScreenX, dy = e.clientY - dragStartScreenY;
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          dragArmed = true;
        }
        const pt = groundPoint(e.clientX, e.clientY);
        const dx = pt.x - wallDragStartPt.x, dz = pt.z - wallDragStartPt.z;
        const wall = wallsRef.current.find((w) => w.uid === draggingWallUid);
        if (wall?.type === "column") {
          setWalls((prev) => prev.map((w) => w.uid === draggingWallUid ? { ...w, x: wallDragOrigX1 + dx, z: wallDragOrigZ1 + dz } : w));
        } else if (wall?.groupId) {
          // mover todo el grupo de paredes junto
          setWalls((prev) => prev.map((w) => {
            if (w.groupId !== wall.groupId) return w;
            const orig = wallDragGroupOrig[w.uid];
            if (!orig) return w;
            return { ...w, x1: orig.x1 + dx, z1: orig.z1 + dz, x2: orig.x2 + dx, z2: orig.z2 + dz };
          }));
        } else {
          threeRef.current.moveWall(draggingWallUid, wallDragOrigX1 + dx, wallDragOrigZ1 + dz, wallDragOrigX2 + dx, wallDragOrigZ2 + dz);
        }
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
      if (draggedItem && draggedItem.kind === "prop" && Object.keys(dragOffsetsRef.current).length <= 1) {
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

        // click simple sin drag — agregar una copia más
        if (!state) {
          const src = arrayHandleSourceRef.current;
          if (src && !src._isGroupArray) {
            const groupItems = existingGroupId
              ? itemsRef.current.filter((it) => getOuterGroupId(it) === existingGroupId)
              : [src];
            const def = findDefRef.current(src.kind, src.catalogId);
            const objWidth = def?.w || 1;

            // calcular espaciado actual
            let spacing = objWidth; // default: continuo (espaciado 0 entre bordes = ancho entre centros)
            if (groupItems.length >= 2) {
              const sorted = [...groupItems].sort((a, b) => {
                const pivot = { x: groupItems[0].pivotX ?? groupItems[0].x, z: groupItems[0].pivotZ ?? groupItems[0].z };
                return Math.hypot(a.x - pivot.x, a.z - pivot.z) - Math.hypot(b.x - pivot.x, b.z - pivot.z);
              });
              spacing = Math.hypot(sorted[1].x - sorted[0].x, sorted[1].z - sorted[0].z);
            }

            // dirección del array
            const rotY = src.rotY || 0;
            const dir = new THREE.Vector3(Math.sin(rotY + Math.PI / 2), 0, Math.cos(rotY + Math.PI / 2));

            // último item del grupo
            const lastItem = groupItems.length > 1
              ? [...groupItems].sort((a, b) => {
                  const px = groupItems[0].pivotX ?? groupItems[0].x;
                  const pz = groupItems[0].pivotZ ?? groupItems[0].z;
                  return Math.hypot(b.x - px, b.z - pz) - Math.hypot(a.x - px, a.z - pz);
                })[0]
              : src;

            const newPos = new THREE.Vector3(
              lastItem.x + dir.x * spacing,
              0,
              lastItem.z + dir.z * spacing
            );

            const groupId = existingGroupId || `line_${Date.now()}`;
            const newItem = {
              uid: `${src.catalogId}_${Date.now()}_click`,
              catalogId: src.catalogId, kind: src.kind,
              x: newPos.x, z: newPos.z, rotY: src.rotY,
              color: varyColor(src.color || "#888888", groupItems.length),
              sockets: { ...src.sockets }, groupIds: [groupId],
              pivotX: src.pivotX ?? src.x, pivotZ: src.pivotZ ?? src.z,
            };

            if (!existingGroupId) {
              threeRef.current.addToGroup(src.uid, groupId, src.x, src.z, src.rotY);
            }
            threeRef.current.commitLineItems([newItem]);
            const allUids = [...groupItems.map((it) => it.uid), newItem.uid];
            if (!existingGroupId) allUids.unshift(src.uid);
            setTimeout(() => threeRef.current.setSelectedGroup(allUids), 0);
          }
          arrayHandleActiveRef.current = false;
          arrayHandleSourceRef.current = null;
          threeRef.current.setArrayHandleActive(false);
          draggingWallHandleRef.current = null;
          snapIndicator.visible = false;
          return;
        }

        if (state && state.n > 0) {
          const { origin, endPt, n, src } = state;
          const dir = new THREE.Vector3().subVectors(endPt, origin);
          const angle = Math.atan2(dir.x, dir.z) - Math.PI / 2;
          const baseColor = src.color || "#888888";

          // no overlap: distancia mínima = ancho del objeto × n
          const def = findDefRef.current(src.kind, src.catalogId);
          const minDist = (def?.w || 1) * n;
          const totalDist = origin.distanceTo(endPt);
          const clampedEndPt = totalDist < minDist
            ? origin.clone().addScaledVector(dir.normalize(), minDist)
            : endPt;

          if (existingGroupId) {
            setItems((prev) => {
              const groupItems = prev.filter((it) => getOuterGroupId(it) === existingGroupId);
              const nonGroup = prev.filter((it) => getOuterGroupId(it) !== existingGroupId);
              const total = n + 1;
              const newGroup = [];
              for (let i = 0; i < total; i++) {
                const t = n === 0 ? 0 : i / n;
                const pos = new THREE.Vector3().copy(origin).lerp(clampedEndPt, t);
                const existing = groupItems[i];
                newGroup.push(existing
                  ? { ...existing, x: pos.x, z: pos.z, rotY: angle, pivotX: origin.x, pivotZ: origin.z }
                  : {
                    uid: `${src.catalogId}_${Date.now()}_arr${i}`,
                    catalogId: src.catalogId, kind: src.kind,
                    x: pos.x, z: pos.z, rotY: angle,
                    color: varyColor(baseColor, i), sockets: { ...src.sockets }, groupIds: [existingGroupId],
                    pivotX: origin.x, pivotZ: origin.z,
                  });
              }
              setTimeout(() => threeRef.current.setSelectedGroup(newGroup.map((it) => it.uid)), 0);
              return [...nonGroup, ...newGroup];
            });
          } else if (src._isGroupArray) {
            const groupUids = src._groupUids;
            const groupItems = itemsRef.current.filter((it) => groupUids.includes(it.uid));
            const allNewUids = [];
            const newItems = [];
            for (let i = 1; i <= n; i++) {
              const t = i / n;
              const pos = new THREE.Vector3().copy(origin).lerp(clampedEndPt, t);
              const offset = new THREE.Vector3(pos.x - src.x, 0, pos.z - src.z);
              const newGroupId = `group_${Date.now()}_${i}`;
              const groupNewUids = [];
              groupItems.forEach((it) => {
                const uid = `${it.catalogId}_${Date.now()}_g${i}_${Math.random().toString(36).slice(2,6)}`;
                groupNewUids.push(uid);
                newItems.push({
                  ...it, uid,
                  x: it.x + offset.x, z: it.z + offset.z,
                  groupIds: [newGroupId],
                  groupId: undefined,
                  pivotX: (it.pivotX ?? it.x) + offset.x,
                  pivotZ: (it.pivotZ ?? it.z) + offset.z,
                });
              });
              allNewUids.push(...groupNewUids);
            }
            threeRef.current.commitLineItems(newItems);
            setTimeout(() => threeRef.current.setSelectedGroup(allNewUids), 0);
          } else {
            const groupId = `line_${Date.now()}`;
            const newItems = [];
            for (let i = 1; i <= n; i++) {
              const t = i / n;
              const pos = new THREE.Vector3().copy(origin).lerp(clampedEndPt, t);
              newItems.push({
                uid: `${src.catalogId}_${Date.now()}_arr${i}`,
                catalogId: src.catalogId, kind: src.kind,
                x: pos.x, z: pos.z, rotY: angle,
                color: varyColor(baseColor, i), sockets: { ...src.sockets }, groupIds: [groupId],
                pivotX: origin.x, pivotZ: origin.z,
              });
            }
            threeRef.current.addToGroup(src.uid, groupId, origin.x, origin.z, angle);
            threeRef.current.commitLineItems(newItems);
            const allGroupUids = [src.uid, ...newItems.map((it) => it.uid)];
            setTimeout(() => threeRef.current.setSelectedGroup(allGroupUids), 0);
          }
          threeRef.current._arrayDragState = null;
          clearGhosts();
        } else {
          clearGhosts();
        }
        arrayHandleActiveRef.current = false;
        arrayHandleSourceRef.current = null;
        threeRef.current.setArrayHandleActive(false);
      }
      if (draggingWallHandleRef.current) {
        draggingWallHandleRef.current = null;
        snapIndicator.visible = false;
      }
    };
    dom.addEventListener("pointerdown", onDownSelect);
    const onDblClick = (e) => {
      // doble click termina column tool
      if (columnToolActiveRef.current) {
        hideColumnGhost();
        setColumnToolActive(false);
        return;
      }
      // doble click termina wall tool
      if (wallToolActiveRef.current) {
        wallStateRef.current = { active: false, start: null, end: null };
        threeRef.current.clearWallGhost && threeRef.current.clearWallGhost();
        wallSessionIdRef.current = null;
        setWallToolActive(false);
        return;
      }
      // doble click termina measure tool
      if (measureToolActiveRef.current) {
        measureStateRef.current = { active: false, start: null, measures: [] };
        const { measurePreviewLine, measurePreviewLabel, measureStartDot, measureGroup } = threeRef.current;
        measurePreviewLine.visible = false;
        measurePreviewLabel.visible = false;
        measureStartDot.visible = false;
        while (measureGroup.children.length) measureGroup.remove(measureGroup.children[0]);
        setMeasureToolActive(false);
        return;
      }
      if (pendingLineDefRef.current) return;
      const rect = dom.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, activeCam);
      const hits = raycaster.intersectObjects(itemGroup.children, true);
      if (hits.length) {
        let obj = hits[0].object;
        while (obj.parent && obj.parent !== itemGroup) obj = obj.parent;
        const uid = obj.userData.uid;
        const clickedItem = itemsRef.current.find((it) => it.uid === uid);
        const ids = getGroupIds(clickedItem);
        const currentDepth = selectionDepthRef.current;
        if (ids.length && currentDepth !== null && currentDepth > 0) {
          // drill one level inward — find the groupId one level in from current
          const newDepth = currentDepth - 1;
          selectionDepthRef.current = newDepth;
          const activeGroupId = ids[newDepth];
          const groupUids = itemsRef.current
            .filter((it) => getGroupIds(it).includes(activeGroupId))
            .map((it) => it.uid);
          threeRef.current.setSelectedGroup(groupUids);
        } else {
          // already at innermost or no group — select individual item
          selectionDepthRef.current = null;
          threeRef.current.setSelectedGroup([uid]);
        }
      }
    };
    dom.addEventListener("dblclick", onDblClick);
    window.addEventListener("pointermove", onMoveDrag);
    window.addEventListener("pointerup", onUpDrag);

    const onResize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      camera.aspect = w / h; camera.updateProjectionMatrix();
      updateOrthoFrustum(radius);
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    let raf;
    const spawnAnimations = []; // { container, startTime }
    const ANIM_DURATION = 200; // ms
    const springEase = (t) => {
      if (t <= 0) return 1; if (t >= 1) return 1;
      // empieza en 1, baja a 0.85, rebota a 1.08, regresa a 1
      return 1 + Math.sin(t * Math.PI * 2) * (1 - t) * 0.12;
    };
    const animate = () => {
      raf = requestAnimationFrame(animate);
      // spring animations
      const now = performance.now();
      for (let i = spawnAnimations.length - 1; i >= 0; i--) {
        const { container, startTime } = spawnAnimations[i];
        const t = Math.min((now - startTime) / ANIM_DURATION, 1);
        const s = springEase(t);
        container.scale.set(s, s, s);
        if (t >= 1) { container.scale.set(1, 1, 1); spawnAnimations.splice(i, 1); }
      }
      renderer.render(scene, activeCam);
    };
    animate();

    threeRef.current = {
      scene, camera, renderer, itemGroup, wallGroup, handleGroup, floor, dom,
      clearGhosts,
      addSpawnAnimation: (container) => { spawnAnimations.push({ container, startTime: performance.now() }); },
      measureGroup, measurePreviewLine, measurePreviewLabel, measureStartDot, makeMeasureLabel,
      target, orthoCam, getRadiusThetaPhi: () => ({ radius, theta, phi }),
      setRadiusThetaPhi: (r, t, p) => { radius = r; theta = t; phi = p; updateCamera(); },
      focusOn: (x, y, z) => {
        const startTarget = target.clone();
        const endTarget = new THREE.Vector3(x, 0, z);
        const startRadius = radius;
        const endRadius = Math.max(4, startRadius * 0.7);
        const dur = 500; const t0 = performance.now();
        const step = () => {
          const t = Math.min((performance.now() - t0) / dur, 1);
          const e = 1 - Math.pow(1 - t, 3); // ease out cubic
          target.lerpVectors(startTarget, endTarget, e);
          radius = startRadius + (endRadius - startRadius) * e;
          updateCamera();
          if (t < 1) requestAnimationFrame(step);
        };
        step();
      },
      getActiveCamera: () => activeCam,
      syncSize: onResize,
      setView: (name) => { setView(name); threeRef.current.viewName = name; setViewUIRef.current && setViewUIRef.current(name); },
      applyLayoutMode: (enabled) => {
        if (enabled) {
          theta = 0; phi = 0.001;
          useOrtho = true; activeCam = orthoCam;
          updateCamera();
          setTopMode(true, true);
          threeRef.current.viewName = "top";
          setViewUIRef.current && setViewUIRef.current("top");
          setLayoutModeUIRef.current && setLayoutModeUIRef.current(true);
        } else {
          useOrtho = false; activeCam = camera;
          camera.aspect = mount.clientWidth / mount.clientHeight; camera.updateProjectionMatrix();
          setTopMode(false);
          threeRef.current.viewName = "free";
          setViewUIRef.current && setViewUIRef.current("free");
          setLayoutModeUIRef.current && setLayoutModeUIRef.current(false);
        }
      },
      resetCamera: () => {
        target.set(0, 0, 0);
        radius = 14; theta = Math.PI / 4; phi = Math.PI / 3.2;
        useOrtho = false; activeCam = camera;
        camera.aspect = mount.clientWidth / mount.clientHeight; camera.updateProjectionMatrix();
        updateCamera();
        setTopMode(false);
        setViewUIRef.current && setViewUIRef.current("free");
        setLayoutModeUIRef.current && setLayoutModeUIRef.current(false);
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
        offsets[it.uid] ? { ...it, x: px + offsets[it.uid].dx, z: pz + offsets[it.uid].dz,
          pivotX: it.pivotX != null ? px + offsets[it.uid].pivotDx : it.pivotX,
          pivotZ: it.pivotZ != null ? pz + offsets[it.uid].pivotDz : it.pivotZ,
        } : it
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
      setArrayHandleActive: (v) => setArrayHandleActive(v),
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
      addToGroup: (uid, groupId, pivotX, pivotZ, rotY) => setItems((prev) => prev.map((it) => it.uid === uid ? { ...it, groupIds: [groupId], groupId: undefined, pivotX, pivotZ, rotY } : it)),
      redistributeLineGroup: (groupId, pivotX, pivotZ, endX, endZ) => {
        setItems((prev) => {
          const groupItems = prev.filter((it) => getOuterGroupId(it) === groupId);
          if (groupItems.length < 2) return prev;
          const n = groupItems.length;
          const angle = Math.atan2(endX - pivotX, endZ - pivotZ);
          const origin = new THREE.Vector3(pivotX, 0, pivotZ);
          const end = new THREE.Vector3(endX, 0, endZ);
          return prev.map((it) => {
            if (getOuterGroupId(it) !== groupId) return it;
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
        if (src._isGroupArray) {
          // group array — mostrar ghost del bounding box del grupo completo
          const groupUids = src._groupUids;
          const groupItems = itemsRef.current.filter((it) => groupUids.includes(it.uid));
          // calcular bounding box del grupo
          const xs = groupItems.map((it) => it.x), zs = groupItems.map((it) => it.z);
          const minX = Math.min(...xs), maxX = Math.max(...xs);
          const minZ = Math.min(...zs), maxZ = Math.max(...zs);
          const gw = (maxX - minX) + 2, gh = 2, gd = (maxZ - minZ) + 2;
          const makeGroupGhost = (offset) => {
            const geo = new THREE.BoxGeometry(gw, gh, gd);
            const mat = new THREE.MeshStandardMaterial({ color: 0x4ade80, roughness: 0.45, metalness: 0.15, transparent: true, opacity: 0.25 });
            const ghost = new THREE.Mesh(geo, mat);
            ghost.position.set(src.x + offset.x, gh / 2, src.z + offset.z);
            ghostGroup.add(ghost);
          };
          makeGroupGhost(new THREE.Vector3(0, 0, 0)); // original
          for (let i = 1; i <= n; i++) {
            const t = i / n;
            const pos = new THREE.Vector3().copy(origin).lerp(endPt, t);
            makeGroupGhost(new THREE.Vector3(pos.x - origin.x, 0, pos.z - origin.z));
          }
          threeRef.current._arrayDragState = { origin, endPt, n, src, angleOffset: 0 };
          return;
        }
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
      dom.removeEventListener("pointerleave", onMouseLeave);
      window.removeEventListener("resize", onResize);
      mount.removeChild(dom);
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Floor size + color sync
  useEffect(() => {
    const { floor, viewName } = threeRef.current;
    if (!floor) return;
    floor.scale.set(floorW, floorD, 1);
    // don't override the top-view flat floor color
    if (floor.material && viewName !== "top") floor.material.color.set(floorDark ? "#1a1a1a" : floorColor);
  }, [floorW, floorD, floorColor, floorDark]);

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

  useEffect(() => {
    const { scene } = threeRef.current;
    if (!scene) return;
    const mesh = scene.getObjectByName("__floorPlanMesh");
    if (mesh?.material) {
      mesh.material.opacity = layoutMode ? Math.min(1, (floorPlan?.opacity ?? 0.5) * 1.8) : (floorPlan?.opacity ?? 0.5);
    }
  }, [layoutMode, floorPlan]);

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
        if (wall.type === "column") {
          // 4 side handles for scaling
          const r = wall.shape === "circular" ? wall.radius : wall.width / 2;
          const d = wall.shape === "circular" ? wall.radius : wall.depth / 2;
          const makeColHandle = (x, z, axis, dir) => {
            const geo = new THREE.SphereGeometry(0.1, 16, 16);
            const mat = new THREE.MeshBasicMaterial({ color: 0xff6a00, depthTest: false });
            const sphere = new THREE.Mesh(geo, mat);
            sphere.position.set(wall.x + x, wall.height / 2, wall.z + z);
            sphere.renderOrder = 999;
            sphere.userData.isWallHandle = true;
            sphere.userData.wallUid = selectedWallUid;
            sphere.userData.isColumnHandle = true;
            sphere.userData.axis = axis;
            sphere.userData.dir = dir;
            return sphere;
          };
          handleGroup.add(makeColHandle(r + 0.12, 0, 'x', 1));   // right
          handleGroup.add(makeColHandle(-r - 0.12, 0, 'x', -1)); // left
          handleGroup.add(makeColHandle(0, d + 0.12, 'z', 1));   // front
          handleGroup.add(makeColHandle(0, -d - 0.12, 'z', -1)); // back
          // move handle — center top
          const moveSphere = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 16), new THREE.MeshBasicMaterial({ color: 0x00e5ff, depthTest: false }));
          moveSphere.position.set(wall.x, wall.height + 0.2, wall.z);
          moveSphere.renderOrder = 999;
          moveSphere.userData.isWallHandle = true;
          moveSphere.userData.wallUid = selectedWallUid;
          moveSphere.userData.isColumnMove = true;
          handleGroup.add(moveSphere);
        } else {
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
    }

    // Single object — "+" array expand handle (green sprite)
    if (selectedUids.length === 1 && !selectedWallUid) {
      const it = items.find((i) => i.uid === selectedUids[0]);
      const def = it && findDef(it.kind, it.catalogId);
      if (it && def) {
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

    // Group handles
    if (selectedUids.length > 1) {
      const selItems = items.filter((it) => selectedUids.includes(it.uid));
      const outerGroupId0 = getOuterGroupId(selItems[0]);
      const innerGroupId0 = getInnerGroupId(selItems[0]);
      const allSameOuterGroup = selItems.every((it) => getOuterGroupId(it) && getOuterGroupId(it) === outerGroupId0);
      const allSameInnerGroup = selItems.every((it) => getInnerGroupId(it) && getInnerGroupId(it) === innerGroupId0);
      // cyan re-edit handle: only show when all items share the same innermost group (a single line array)
      if (allSameInnerGroup && selItems[0].pivotX != null) {
        const sorted = [...selItems].sort((a, b) => {
          const da = Math.hypot(a.x - selItems[0].pivotX, a.z - (selItems[0].pivotZ ?? 0));
          const db = Math.hypot(b.x - selItems[0].pivotX, b.z - (selItems[0].pivotZ ?? 0));
          return da - db;
        });
        const last = sorted[sorted.length - 1];
        const cyanSprite = makeHandleSprite(0x00e5ff);
        cyanSprite.position.set(last.x, 0.5, last.z);
        cyanSprite.userData.isLineHandle = true;
        cyanSprite.userData.groupId = innerGroupId0;
        cyanSprite.userData.role = 'end';
        cyanSprite.userData.pivotX = selItems[0].pivotX;
        cyanSprite.userData.pivotZ = selItems[0].pivotZ ?? 0;
        handleGroup.add(cyanSprite);
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
      mesh = buildWallMesh(wall, walls);
      mesh.userData.wallUid = wall.uid;
      // highlight selected wall or its group
      const selectedWall = walls.find((w) => w.uid === selectedWallUid);
      const isInSelectedGroup = selectedWall?.groupId && wall.groupId === selectedWall.groupId;
      if (wall.uid === selectedWallUid || isInSelectedGroup) {
        mesh.traverse((c) => {
          if (c.isMesh) { c.material = c.material.clone(); c.material.emissive = new THREE.Color(0xff6a00); c.material.emissiveIntensity = isInSelectedGroup && wall.uid !== selectedWallUid ? 0.15 : 0.3; }
        });
        if (wall.type === "column") {
          const r = wall.shape === "circular" ? wall.radius : Math.max(wall.width, wall.depth) / 2;
          const outlineGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(r * 2.2, wall.height * 1.05, r * 2.2));
          const outlineLine = new THREE.LineSegments(outlineGeo, new THREE.LineBasicMaterial({ color: 0xff6a00, depthTest: false }));
          outlineLine.position.y = wall.height / 2;
          outlineLine.renderOrder = 999; outlineLine.raycast = () => {};
          mesh.add(outlineLine);
        } else {
          const dx = wall.x2 - wall.x1, dz = wall.z2 - wall.z1;
          const len = Math.sqrt(dx * dx + dz * dz) || 0.01;
          const outlineGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(len * 1.05, wall.height * 1.05, wall.thickness * 1.5));
          const outlineLine = new THREE.LineSegments(outlineGeo, new THREE.LineBasicMaterial({ color: 0xff6a00, depthTest: false }));
          outlineLine.position.y = wall.height / 2;
          outlineLine.renderOrder = 999; outlineLine.raycast = () => {};
          mesh.add(outlineLine);
        }
      }
      wallGroup.add(mesh);
    });
  }, [walls, selectedWallUid]);

  // ===================== Layer visibility =====================
  useEffect(() => {
    const { itemGroup, wallGroup } = threeRef.current;
    if (!itemGroup || !wallGroup) return;
    itemGroup.children.forEach((container) => {
      const it = items.find((i) => i.uid === container.userData.uid);
      if (!it) return;
      const catalogHidden = hiddenCatalogIds.has(it.catalogId);
      const isLocked = (it.kind === "model" && layerLock.models) ||
                       (it.kind === "primitive" && layerLock.primitives) ||
                       (it.kind === "prop" && layerLock.props);
      if (it.kind === "model") container.visible = layerVisibility.models && !catalogHidden;
      else if (it.kind === "primitive") container.visible = layerVisibility.primitives && !catalogHidden;
      else if (it.kind === "prop") container.visible = layerVisibility.props && !catalogHidden;
      // lock visual: opacidad 50% + tinte amarillo
      container.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((mat) => {
          if (isLocked) {
            mat.transparent = true;
            mat.opacity = 0.5;
            mat._lockedColorSaved = mat._lockedColorSaved || mat.color.clone();
            mat.color.lerp(new THREE.Color(0xf59e0b), 0.3);
          } else {
            mat.opacity = 1;
            mat.transparent = false;
            if (mat._lockedColorSaved) {
              mat.color.copy(mat._lockedColorSaved);
              delete mat._lockedColorSaved;
            }
          }
        });
      });
    });
    wallGroup.children.forEach((mesh) => {
      mesh.visible = layerVisibility.walls;
      mesh.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((mat) => {
          const isGlass = mat.transmission > 0; // skip glass materials
          if (layerLock.walls) {
            mat.transparent = true;
            mat.opacity = isGlass ? mat.opacity * 0.5 : 0.5;
            mat._lockedColorSaved = mat._lockedColorSaved || mat.color.clone();
            mat.color.lerp(new THREE.Color(0xf59e0b), 0.3);
          } else {
            if (!isGlass) {
              mat.opacity = 1;
              mat.transparent = false;
            }
            if (mat._lockedColorSaved) {
              mat.color.copy(mat._lockedColorSaved);
              delete mat._lockedColorSaved;
            }
          }
        });
      });
    });
    // deselect walls/columns when their layer is hidden
    if (!layerVisibility.walls && selectedWallUid) {
      setSelectedWallUid(null);
    }
    // deselect items when their layer is hidden
    if (selectedUids.length > 0) {
      const anyHidden = selectedUids.some((uid) => {
        const it = items.find((i) => i.uid === uid);
        if (!it) return false;
        if (it.kind === "model" && (!layerVisibility.models || hiddenCatalogIds.has(it.catalogId))) return true;
        if (it.kind === "primitive" && !layerVisibility.primitives) return true;
        if (it.kind === "prop" && !layerVisibility.props) return true;
        return false;
      });
      if (anyHidden) setSelectedUids([]);
    }
  }, [layerVisibility, layerLock, hiddenCatalogIds, items, selectedWallUid]);

  // ===================== Sync items -> meshes (GLB real con caché + placeholder mientras carga) =====================
  const loadedUidsRef = useRef(new Set()); // evita relanzar la carga si ya se está cargando ese uid

  const PAINT_MATERIAL_NAME = "paint_color";
  const applyColorToContainer = (container, color, def) => {
    // si el modelo tiene paintable: false, no teñir nada
    if (def && def.paintable === false) return;
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
      const hasFile = !!(def.file);
      const placeholderGeo = (it.kind !== "model" && !hasFile) ? buildPlaceholderGeometry(def.kind, pw, pdz, ph) : new THREE.BoxGeometry(def.w, def.h, def.d);
      const placeholderMat = new THREE.MeshStandardMaterial({ color: it.color || def.color || "#888888", roughness: 0.45, metalness: 0.15 });
      const placeholder = new THREE.Mesh(placeholderGeo, placeholderMat);
      placeholder.castShadow = true;
      placeholder.receiveShadow = true;
      placeholder.position.y = ((it.kind !== "model" && !hasFile) ? ph : def.h) / 2;
      placeholder.userData.isPlaceholder = true;
      placeholder.userData.curW = pw; placeholder.userData.curD = pdz; placeholder.userData.curH = ph;
      container.add(placeholder);

      if (container.userData.outline) { container.remove(container.userData.outline); container.userData.outline.geometry.dispose(); container.userData.outline.material.dispose(); }
      const phForOutline = (it.kind !== "model" && !hasFile) ? ph : def.h;
      const outline = buildOutlineBox(pw, phForOutline, pdz);
      outline.position.y = phForOutline / 2;
      outline.visible = false;
      container.userData.outline = outline;
      container.add(outline);

      if ((it.kind === "model" || (it.kind === "prop" && def.file)) && def.file && !loadedUidsRef.current.has(it.uid)) {
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
            applyColorToContainer(root, it.color || def.color || "#888888", def);
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
        // spring spawn animation
        if (appSettingsRef.current.animations) {
          threeRef.current.addSpawnAnimation(container);
        }
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
      if (container.userData.outline) {
        container.userData.outline.visible = isSelected;
        if (isSelected) {
          const depth = getGroupIds(it).length; // 0 = no group, 1 = one level, etc.
          const colorIdx = Math.min(depth, GROUP_LEVEL_COLORS.length - 1);
          container.userData.outline.material.color.setHex(GROUP_LEVEL_COLORS[colorIdx]);
        }
      }

      if (realModel) {
        applyColorToContainer(realModel, it.color || def.color || "#888888", def);
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
      shiftKeyRef.current = e.shiftKey;
      altKeyRef.current = e.altKey;
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
          wallSessionIdRef.current = null;
          setWallToolActive(false);
        }
        if (measureToolActiveRef.current) {
          measureStateRef.current = { active: false, start: null, measures: [] };
          const { measurePreviewLine, measurePreviewLabel, measureStartDot, measureGroup } = threeRef.current;
          measurePreviewLine.visible = false;
          measurePreviewLabel.visible = false;
          measureStartDot.visible = false;
          while (measureGroup.children.length) measureGroup.remove(measureGroup.children[0]);
          setMeasureToolActive(false);
        }
        if (columnToolActiveRef.current) {
          hideColumnGhost();
          setColumnToolActive(false);
        }
        if (arrayHandleActiveRef.current) {
          arrayHandleActiveRef.current = false;
          arrayHandleSourceRef.current = null;
          threeRef.current.setArrayHandleActive(false);
          draggingWallHandleRef.current = null;
          threeRef.current.clearGhosts && threeRef.current.clearGhosts();
          // restaurar visibilidad de todos los items
          const { itemGroup } = threeRef.current;
          if (itemGroup) itemGroup.children.forEach((c) => { c.visible = true; });
        }
        return;
      }

      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (inInput) return;

        // array mode — ↑↓ cambian cantidad de copias, ←→ bloqueados
        if (arrayHandleActiveRef.current) {
          e.preventDefault();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            const delta = e.key === "ArrowUp" ? 1 : -1;
            const next = Math.max(1, lineCountRef.current + delta);
            lineCountRef.current = next;
            threeRef.current.setLineCountUI(next);
            const state = threeRef.current._arrayDragState;
            if (state) threeRef.current.buildArrayGhosts(state.origin, state.endPt, next, state.src, 0);
          }
          return;
        }
        const handledByLine = threeRef.current.adjustLineAngle && threeRef.current.adjustLineAngle(
          (e.key === "ArrowLeft" ? -1 : 1) * (15 * Math.PI / 180)
        );
        if (handledByLine) { e.preventDefault(); return; }
        if (!selectedUids.length) return;
        e.preventDefault();

        if (e.shiftKey) {
          // Shift = rotar
          const deg = 15;
          const delta = (e.key === "ArrowLeft" ? -1 : 1) * (deg * Math.PI / 180);
          setItems((prev) => {
            const selItems = prev.filter((it) => selectedUids.includes(it.uid));
            if (e.altKey) {
              // Shift+Alt = cada objeto rota en su propio origen
              return prev.map((it) => selectedUids.includes(it.uid) ? { ...it, rotY: it.rotY + delta } : it);
            }
            // rotar alrededor del pivote formal si hay grupo, o centroide si es selección manual
            const allSameGroup = selItems.length > 1 && selItems.every((it) => getOuterGroupId(it) && getOuterGroupId(it) === getOuterGroupId(selItems[0]));
            const pivotItem = allSameGroup ? (selItems.find((it) => it.pivotX != null) || selItems[0]) : null;
            const pivotX = pivotItem ? (pivotItem.pivotX ?? pivotItem.x) : selItems.reduce((s, it) => s + it.x, 0) / selItems.length;
            const pivotZ = pivotItem ? (pivotItem.pivotZ ?? pivotItem.z) : selItems.reduce((s, it) => s + it.z, 0) / selItems.length;
            if (selItems.length > 1) {
              const axis = new THREE.Vector3(0, 1, 0);
              return prev.map((it) => {
                if (!selectedUids.includes(it.uid)) return it;
                const rel = new THREE.Vector3(it.x - pivotX, 0, it.z - pivotZ).applyAxisAngle(axis, delta);
                return { ...it, x: pivotX + rel.x, z: pivotZ + rel.z, rotY: it.rotY + delta };
              });
            }
            // objeto individual
            return prev.map((it) => selectedUids.includes(it.uid) ? { ...it, rotY: it.rotY + delta } : it);
          });
        } else {
          // Sin Shift = mover en el eje local del objeto más alineado con la cámara
          const STEP = 0.1;
          const cam = threeRef.current.getActiveCamera();
          const target = threeRef.current.target || new THREE.Vector3(0, 0, 0);
          // eje derecho y forward de la cámara proyectados al piso
          const camForward = new THREE.Vector3().subVectors(target, cam.position).setY(0).normalize();
          const camRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), camForward).normalize();

          // para cada objeto seleccionado, encontrar cuál eje local (+X o +Z) está más alineado con camRight/camForward
          const isHorizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
          const sign = (e.key === "ArrowLeft" || e.key === "ArrowUp") ? 1 : -1;
          const camAxis = isHorizontal ? camRight : camForward;

          setItems((prev) => prev.map((it) => {
            if (!selectedUids.includes(it.uid)) return it;
            const rotY = it.rotY || 0;
            // ejes locales del objeto en el plano XZ
            const localX = new THREE.Vector3(Math.cos(rotY), 0, -Math.sin(rotY));
            const localZ = new THREE.Vector3(Math.sin(rotY), 0,  Math.cos(rotY));
            // cuál eje local está más alineado con la dirección de la cámara
            const dotX = Math.abs(localX.dot(camAxis));
            const dotZ = Math.abs(localZ.dot(camAxis));
            let moveAxis, axisSign;
            if (dotX >= dotZ) {
              moveAxis = localX;
              axisSign = localX.dot(camAxis) >= 0 ? sign : -sign;
            } else {
              moveAxis = localZ;
              axisSign = localZ.dot(camAxis) >= 0 ? sign : -sign;
            }
            const dx = moveAxis.x * axisSign * STEP;
            const dz = moveAxis.z * axisSign * STEP;
            return { ...it, x: it.x + dx, z: it.z + dz,
              pivotX: it.pivotX != null ? it.pivotX + dx : it.pivotX,
              pivotZ: it.pivotZ != null ? it.pivotZ + dz : it.pivotZ };
          }));
        }
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedWallUid) {
          e.preventDefault();
          const selWall = wallsRef.current.find((w) => w.uid === selectedWallUid);
          setWalls((prev) => prev.filter((w) =>
            selWall?.groupId ? w.groupId !== selWall.groupId : w.uid !== selectedWallUid
          ));
          setSelectedWallUid(null);
          return;
        }
        if (selectedUids.length > 0) {
          if (inInput) return;
          e.preventDefault();
          setItems((prev) => prev.filter((it) => !selectedUids.includes(it.uid)));
          setSelectedUids([]);
        }
        return;
      }

      if (!selectedUids.length) return;
      if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const selItems = items.filter((it) => selectedUids.includes(it.uid));
        if (selItems.length) {
          const cx = selItems.reduce((s, it) => s + it.x, 0) / selItems.length;
          const cz = selItems.reduce((s, it) => s + it.z, 0) / selItems.length;
          threeRef.current.focusOn(cx, 0, cz);
        }
        return;
      }
      if ((e.key === "d" || e.key === "D") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        duplicateSelectedRef.current();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const onKeyUp = (e) => {
      shiftKeyRef.current = e.shiftKey;
      altKeyRef.current = e.altKey;
    };
    window.addEventListener("keyup", onKeyUp);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); };
  }, [selectedUids, wallToolActive, selectedWallUid]);

  const itemCounts = React.useMemo(() => {
    const m = {};
    items.forEach((it) => { m[it.catalogId] = (m[it.catalogId] || 0) + 1; });
    return m;
  }, [items]);

  const sceneListData = React.useMemo(() => {
    const categoryMap = {};
    Object.entries(itemCounts).filter(([, c]) => c > 0).forEach(([catalogId, count]) => {
      const it = items.find((i) => i.catalogId === catalogId);
      const kind = it?.kind || "model";
      const def = findDef(kind, catalogId);
      if (!def) return;
      const cat = def.category || (kind === "primitive" ? "Primitives" : kind === "prop" ? "Props" : "Models");
      if (!categoryMap[cat]) categoryMap[cat] = [];
      const accMap = {};
      items.filter((i) => i.catalogId === catalogId).forEach((i) => {
        if (!i.sockets) return;
        Object.entries(i.sockets).forEach(([sName, cfg]) => {
          if (!cfg) return;
          const isOn = typeof cfg === 'object' ? cfg.enabled : !!cfg;
          if (!isOn) return;
          const label = sName.includes('lamp') ? 'Lamp' : sName.includes('shelf') ? 'Shelves' : sName.replace('socket_', '');
          const n = typeof cfg === 'object' && cfg.count ? cfg.count : 1;
          accMap[label] = (accMap[label] || 0) + n;
        });
      });
      categoryMap[cat].push({ catalogId, name: def.name, count, accessories: accMap });
    });
    if (walls.length > 0) {
      categoryMap["Walls & Structure"] = [{ catalogId: "_walls", name: "Walls", count: walls.length, accessories: {} }];
    }
    return categoryMap;
  }, [items, walls, itemCounts]);

  // ===================== Selected item ops =====================
  const selectedItem = items.find((i) => i.uid === selectedUid);
  const selectedDef = selectedItem && findDef(selectedItem.kind, selectedItem.catalogId);
  const rightPanelOpen = !!(selectedItem && selectedDef);
  const isWholeGroupSelected = selectedUids.length > 1 && getOuterGroupId(selectedItem) &&
    items.filter((it) => selectedUids.includes(it.uid)).every((it) => getOuterGroupId(it) === getOuterGroupId(selectedItem));

  const updateSelected = (patch) => setItems((prev) => prev.map((it) => (it.uid === selectedUid ? { ...it, ...patch } : it)));
  const updateGroup = (patch) => setItems((prev) => prev.map((it) => (selectedUids.includes(it.uid) ? { ...it, ...patch } : it)));
  const [groupColorMode, setGroupColorMode] = useState('varied'); // 'varied' | 'solid'

  const updateColor = (color) => {
    if (isWholeGroupSelected) {
      setItems((prev) => {
        const groupItems = prev.filter((it) => selectedUids.includes(it.uid));
        return prev.map((it) => {
          if (!selectedUids.includes(it.uid)) return it;
          const idx = groupItems.indexOf(it);
          return { ...it, color: groupColorMode === 'varied' ? varyColor(color, idx) : color };
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
  // rotar todo el grupo alrededor del pivote (o centroide si no hay pivote formal)
  const rotateGroupAroundPivot = (deltaDeg) => {
    if (!selectedUids.length) return;
    const delta = deltaDeg * Math.PI / 180;
    const selItems = items.filter((it) => selectedUids.includes(it.uid));
    // use formal pivot if all share the same group, otherwise use centroid
    const outerGroup = getOuterGroupId(selectedItem);
    const allSameGroup = outerGroup && selItems.every((it) => getGroupIds(it).includes(outerGroup));
    const pivotItem = allSameGroup ? selItems.find((it) => it.pivotX != null) : null;
    const pivotX = pivotItem ? pivotItem.pivotX : selItems.reduce((s, it) => s + it.x, 0) / selItems.length;
    const pivotZ = pivotItem ? pivotItem.pivotZ : selItems.reduce((s, it) => s + it.z, 0) / selItems.length;
    setItems((prev) => prev.map((it) => {
      if (!selectedUids.includes(it.uid)) return it;
      const dx = it.x - pivotX, dz = it.z - pivotZ;
      const cos = Math.cos(delta), sin = Math.sin(delta);
      return { ...it, x: pivotX + dx * cos - dz * sin, z: pivotZ + dx * sin + dz * cos, rotY: it.rotY + delta };
    }));
  };
  const alignSelected = (type) => {
    if (selectedUids.length < 2) return;
    const selItems = items.filter((it) => selectedUids.includes(it.uid));

    // group items by outer groupId — treat each group as one unit
    const unitMap = {};
    selItems.forEach((it) => {
      const gid = getOuterGroupId(it) || it.uid;
      if (!unitMap[gid]) unitMap[gid] = { id: gid, uids: [] };
      unitMap[gid].uids.push(it.uid);
    });
    Object.values(unitMap).forEach((u) => {
      const its = selItems.filter((it) => u.uids.includes(it.uid));
      u.cx = its.reduce((s, it) => s + it.x, 0) / its.length;
      u.cz = its.reduce((s, it) => s + it.z, 0) / its.length;
    });
    const units = Object.values(unitMap);
    const anchorUnit = units.find((u) => u.uids.includes(selectedUid)) || units[units.length - 1];

    setItems((prev) => prev.map((it) => {
      if (!selectedUids.includes(it.uid)) return it;
      const unit = units.find((u) => u.uids.includes(it.uid));
      if (!unit || unit.id === anchorUnit.id) return it;
      const dx = it.x - unit.cx;
      const dz = it.z - unit.cz;
      if (type === 'x') return { ...it, x: anchorUnit.cx + dx };
      if (type === 'z') return { ...it, z: anchorUnit.cz + dz };
      if (type === 'both') return { ...it, x: anchorUnit.cx + dx, z: anchorUnit.cz + dz };
      return it;
    }));
  };

  const deleteSelected = () => { setItems((prev) => prev.filter((it) => !selectedUids.includes(it.uid))); setSelectedUids([]); };
  const mirrorSelected = () => {
    if (!selectedUids.length || !selectedItem) return;
    const selItems = items.filter((it) => selectedUids.includes(it.uid));
    const def = findDef(selectedItem.kind, selectedItem.catalogId);
    const depth = def?.d || 1;
    // use the rotY of the first/pivot item as the group's facing direction
    const rotY = selectedItem.rotY || 0;
    // "back" direction = opposite of facing direction
    const backX = Math.sin(rotY + Math.PI);
    const backZ = Math.cos(rotY + Math.PI);
    const groupId = `mirror_${Date.now()}`;
    const newItems = selItems.map((it, idx) => ({
      ...it,
      uid: `${it.catalogId}_mirror_${Date.now()}_${idx}`,
      x: it.x + backX * depth,
      z: it.z + backZ * depth,
      rotY: it.rotY + Math.PI,
      groupIds: [groupId],
      groupId: undefined,
      pivotX: undefined,
      pivotZ: undefined,
    }));
    // put originals and copies in the same group
    const allUids = [...selItems.map((it) => it.uid), ...newItems.map((it) => it.uid)];
    setItems((prev) => [
      ...prev.map((it) => selectedUids.includes(it.uid)
        ? { ...it, groupIds: [groupId], groupId: undefined, pivotX: undefined, pivotZ: undefined }
        : it),
      ...newItems,
    ]);
    setTimeout(() => threeRef.current.setSelectedGroup(allUids), 0);
  };
  const duplicateSelected = () => {
    if (!selectedUids.length) return;
    const offset = 0.4;
    const groupRemap = {}; // remap each groupIds level independently
    const selItems = items.filter((it) => selectedUids.includes(it.uid));
    const newItems = selItems.map((it, idx) => {
      const oldIds = getGroupIds(it);
      const newIds = oldIds.map((gid) => {
        if (!groupRemap[gid]) groupRemap[gid] = `${gid}_copy_${Date.now()}`;
        return groupRemap[gid];
      });
      return {
        ...it,
        uid: `${it.catalogId}_${Date.now()}_dup${idx}_${Math.random().toString(36).slice(2, 5)}`,
        x: it.x + offset,
        z: it.z + offset,
        groupIds: newIds,
        groupId: undefined,
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
    const isWholeGroup = selectedUids.length > 1 && getOuterGroupId(selectedItem) &&
      items.filter((it) => selectedUids.includes(it.uid)).every((it) => getOuterGroupId(it) === getOuterGroupId(selectedItem));
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
    const isWholeGroup = selectedUids.length > 1 && getOuterGroupId(selectedItem) &&
      items.filter((it) => selectedUids.includes(it.uid)).every((it) => getOuterGroupId(it) === getOuterGroupId(selectedItem));
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
      const pts = outlinePoints.map((p) => ({
        x: (p.x - m.imgW / 2) * scale,
        z: (p.y - m.imgH / 2) * scale,
      }));
      const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minZ = Math.min(...zs), maxZ = Math.max(...zs);
      const w = maxX - minX;
      const d = maxZ - minZ;
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      // go to confirm step with calculated dims
      setFloorPlanModal((prev) => ({ ...prev, step: "confirm", calcW: w, calcD: d, cx, cz, outlinePoints }));
    } else {
      // no outline — go to confirm with full image dims
      setFloorPlanModal((prev) => ({ ...prev, step: "confirm", calcW: realW, calcD: realH, cx: 0, cz: 0, outlinePoints: null }));
    }
  };

  const handleConfirmDimensions = (w, d) => {
    const m = floorPlanModal;
    setFloorW(w); setFloorD(d);

    if (m.outlinePoints && m.outlinePoints.length >= 3) {
      // crop the image to the outline bounding box, masking outside the polygon
      const pts = m.outlinePoints; // in image pixel coords
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const minX = Math.max(0, Math.floor(Math.min(...xs)));
      const minY = Math.max(0, Math.floor(Math.min(...ys)));
      const maxX = Math.min(m.imgW, Math.ceil(Math.max(...xs)));
      const maxY = Math.min(m.imgH, Math.ceil(Math.max(...ys)));
      const cropW = maxX - minX;
      const cropH = maxY - minY;

      const cropCanvas = document.createElement("canvas");
      cropCanvas.width = cropW;
      cropCanvas.height = cropH;
      const ctx = cropCanvas.getContext("2d");

      // clip to polygon (shifted to crop coords)
      ctx.beginPath();
      ctx.moveTo(pts[0].x - minX, pts[0].y - minY);
      pts.slice(1).forEach((p) => ctx.lineTo(p.x - minX, p.y - minY));
      ctx.closePath();
      ctx.clip();

      // draw the original image offset so the crop region aligns
      const srcImg = new Image();
      srcImg.onload = () => {
        ctx.drawImage(srcImg, -minX, -minY);
        const croppedDataUrl = cropCanvas.toDataURL("image/png");
        // realW/realH are already in meters from the outline step
        setFloorPlan({ dataUrl: croppedDataUrl, realW: w, realH: d, opacity: 0.5, x: 0, z: 0, visible: true });
      };
      srcImg.src = m.dataUrl;
    } else {
      setFloorPlan({ dataUrl: m.dataUrl, realW: m.realW, realH: m.realH, opacity: 0.5, x: 0, z: 0, visible: true });
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
    wallConfig,
  });

  const restoreProjectData = (data) => {
    if (data.name) setProjectName(data.name);
    if (data.manifestUrl) setManifestUrl(data.manifestUrl);
    if (data.unit) setUnit(data.unit);
    if (data.floorW) setFloorW(data.floorW);
    if (data.floorD) setFloorD(data.floorD);
    if (data.floorColor) setFloorColor(data.floorColor);
    setFloorPlan(data.floorPlan || null);
    setItems((data.items || []).map(migrateItem));
    setWalls(data.walls || []);
    setCameras(data.cameras || []);
    if (data.catalogColors) setCatalogColors(data.catalogColors);
    if (data.wallConfig) setWallConfig(data.wallConfig);
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
    setFloorW(10); setFloorD(8); setFloorColor("#878787");
    setFloorPlan(null);
    setWallConfig({ height: 2.4, glassRatio: 0, thickness: 0.1, color: "#cccccc" });
    setProjectName("Untitled Project");
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
    {showIslandBuilder && (
      <IslandBuilder
        catalog={catalog.filter((c) => c.category !== "Props")}
        thumbs={thumbnails}
        catalogColors={catalogColors}
        unit={unit} UNITS={UNITS} fmt={fmt} metersTo={metersTo}
        onPlace={(newItems) => {
          setItems((prev) => [...prev, ...newItems]);
          setSelectedUids(newItems.map((i) => i.uid));
          setShowIslandBuilder(false);
        }}
        onCancel={() => setShowIslandBuilder(false)}
      />
    )}
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
        onConfirmDimensions={handleConfirmDimensions}
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
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#fff", letterSpacing: "-0.01em" }}>Booth Planner</span>
            <span style={{ fontSize: 9, color: "#475569", letterSpacing: "0.04em" }}>v{APP_VERSION}</span>
          </div>
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

          {/* Settings */}
          <button onClick={() => setShowSettings((v) => !v)}
            title="Settings"
            style={{ width: 32, height: 32, background: showSettings ? "#1e2035" : "none", border: "1px solid #1e2035", borderRadius: 8, color: "#64748b", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
        </div>
      </header>

      {/* Settings modal */}
      {showSettings && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "flex-end", paddingTop: 56, paddingRight: 16, pointerEvents: "none" }}>
          <div style={{ background: "#13162a", border: "1px solid #1e2035", borderRadius: 12, padding: 20, width: 280, pointerEvents: "auto", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", marginBottom: 16 }}>Settings</div>

            {/* Animations toggle */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 12, color: "#e2e8f0", fontWeight: 500 }}>Placement animations</div>
                <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>Spring effect when adding objects</div>
              </div>
              <div onClick={() => setAppSettings((s) => ({ ...s, animations: !s.animations }))}
                style={{ width: 36, height: 20, background: appSettings.animations ? "#5b4bff" : "#1e2035", border: appSettings.animations ? "none" : "1px solid #2a2f4a", borderRadius: 10, position: "relative", cursor: "pointer", flexShrink: 0 }}>
                <div style={{ width: 16, height: 16, background: appSettings.animations ? "#fff" : "#475569", borderRadius: "50%", position: "absolute", top: 2, left: appSettings.animations ? 18 : 2, transition: "left 0.15s" }} />
              </div>
            </div>
          </div>
        </div>
      )}

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
            <Section key={cat} title={cat} defaultOpen={false} badge={catCount > 0 ? catCount : null} visible={layerVisibility.models} onVisibilityToggle={() => setLayerVisibility((v) => ({ ...v, models: !v.models }))} locked={layerLock.models} onLockToggle={() => setLayerLock((v) => ({ ...v, models: !v.models }))}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {catItems.map((c) => {
                  const thumb = thumbnails[c.id];
                  const count = itemCounts[c.id] || 0;
                  const isHidden = hiddenCatalogIds.has(c.id);
                  return (
                    <div key={c.id} style={{ background: "#13162a", border: "1px solid #1e2035", borderRadius: 10, overflow: "hidden", opacity: isHidden ? 0.45 : layerLock.models ? 0.35 : libraryReady ? 1 : 0.5, pointerEvents: libraryReady && !layerLock.models ? "auto" : "none" }}>
                      <div style={{ display: "flex", alignItems: "stretch", gap: 0, position: "relative" }}>
                        {/* Eye toggle — esquina superior derecha */}
                        <button onClick={(e) => { e.stopPropagation(); toggleCatalogVisibility(c.id); }}
                          style={{ position: "absolute", top: 4, right: 4, zIndex: 2, width: 18, height: 18, background: "rgba(13,15,24,0.7)", border: "none", borderRadius: 4, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
                          {isHidden
                            ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2.5"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                            : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                          }
                        </button>

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

        {/* Island Builder — layout tool for models */}
        <Section title="Island Builder" defaultOpen={false}>
          <div style={{ marginBottom: 4 }}>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10, lineHeight: 1.5 }}>
              Build island configurations from any model. Paint a layout, set orientations, and place as a group.
            </div>
            <button onClick={() => setShowIslandBuilder(true)} style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              background: "linear-gradient(135deg, #5b4bff, #7c6dff)",
              border: "none", borderRadius: 10, color: "#fff",
              padding: "11px", fontSize: 13, cursor: "pointer", fontWeight: 600,
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
              Open Island Builder
            </button>
          </div>
        </Section>

        {/* Primitives */}
        <Section title="Primitives" defaultOpen={false} badge={items.filter((it) => it.kind === "primitive").length || null} visible={layerVisibility.primitives} onVisibilityToggle={() => setLayerVisibility((v) => ({ ...v, primitives: !v.primitives }))} locked={layerLock.primitives} onLockToggle={() => setLayerLock((v) => ({ ...v, primitives: !v.primitives }))}>
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
                <div key={p.id} draggable={!layerLock.primitives} onDragStart={() => !layerLock.primitives && setDragCatalog({ def: { ...p, color: "#9aa0a6" }, kind: "primitive" })}
                  style={{ background: "#13162a", border: "1px solid #1e2035", borderRadius: 10, padding: "10px 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, cursor: layerLock.primitives ? "not-allowed" : "grab", position: "relative", opacity: layerLock.primitives ? 0.35 : 1, pointerEvents: layerLock.primitives ? "none" : "auto" }}>
                  {count > 0 && <span style={{ position: "absolute", top: 6, right: 6, background: "#5b4bff", color: "#fff", fontSize: 9, fontWeight: 700, borderRadius: 8, padding: "1px 5px" }}>{count}</span>}
                  {PRIM_ICONS[p.kind] || PRIM_ICONS.box}
                  <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 500 }}>{p.name}</span>
                </div>
              );
            })}
          </div>
        </Section>

        {/* Props & Accessories */}
        <Section title="Props & Accessories" defaultOpen={false} badge={items.filter((it) => it.kind === "prop").length || null} visible={layerVisibility.props} onVisibilityToggle={() => setLayerVisibility((v) => ({ ...v, props: !v.props }))} locked={layerLock.props} onLockToggle={() => setLayerLock((v) => ({ ...v, props: !v.props }))}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[...PROPS, ...catalog.filter((c) => c.category === "Props")].map((p) => {
              const count = itemCounts[p.id] || 0;
              const thumb = thumbnails[p.id];
              return (
                <div key={p.id} draggable={!layerLock.props} onDragStart={() => !layerLock.props && setDragCatalog({ def: p, kind: "prop" })}
                  style={{ background: "#13162a", border: "1px solid #1e2035", borderRadius: 10, overflow: "hidden", cursor: layerLock.props ? "not-allowed" : "grab", position: "relative", opacity: layerLock.props ? 0.35 : 1, pointerEvents: layerLock.props ? "none" : "auto" }}>
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
        <Section title="Walls & Structure" defaultOpen={false} badge={walls.length || null} visible={layerVisibility.walls} onVisibilityToggle={() => setLayerVisibility((v) => ({ ...v, walls: !v.walls }))} locked={layerLock.walls} onLockToggle={() => setLayerLock((v) => ({ ...v, walls: !v.walls }))}>
          {/* Draw Wall button */}
          <button onClick={() => {
            if (layerLock.walls) return;
            setColumnToolActive(false);
            setWallToolActive((v) => {
              if (v) {
                wallStateRef.current = { active: false, start: null, end: null };
                threeRef.current.clearWallGhost && threeRef.current.clearWallGhost();
                wallSessionIdRef.current = null;
              } else {
                wallSessionIdRef.current = `wallgroup_${Date.now()}`;
              }
              return !v;
            });
          }} style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            background: wallToolActive ? "linear-gradient(135deg, #5b4bff, #7c6dff)" : "#13162a",
            border: wallToolActive ? "none" : "1px solid #1e2035",
            borderRadius: 10, color: wallToolActive ? "#fff" : layerLock.walls ? "#334155" : "#94a3b8",
            padding: "11px", fontSize: 13, cursor: layerLock.walls ? "not-allowed" : "pointer", fontWeight: 600, marginBottom: 8,
            opacity: layerLock.walls ? 0.4 : 1,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
            {wallToolActive ? "Stop Drawing" : "Draw Wall"}
          </button>
          {wallToolActive && (
            <div style={{ background: "#0f2a1e", border: "1px solid #1a4a30", borderRadius: 8, padding: "8px 10px", marginBottom: 10, fontSize: 10, color: "#86efac", lineHeight: 1.6 }}>
              Click = set start · Move · Click = place · <b>Shift</b> = lock angle · <b>Alt</b> = free angle · <b>Esc</b> = finish
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
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4 }}>Wall Color</label>
              <input type="color" value={wallConfig.color}
                onChange={(e) => setWallConfig((c) => ({ ...c, color: e.target.value }))}
                style={{ width: "100%", height: 32, border: "1px solid #1e2035", borderRadius: 8, padding: 2, cursor: "pointer", background: "none" }} />
            </div>
            {walls.some((w) => w.type !== "column") && (
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <button onClick={() => setWalls((prev) => prev.filter((w) => w.type === "column"))} style={{ background: "#2d1a1a", border: "1px solid #4a2020", borderRadius: 8, color: "#f87171", padding: "7px 12px", fontSize: 11, cursor: "pointer" }}>Clear all</button>
              </div>
            )}
          </div>

          {/* Divider */}
          <div style={{ borderTop: "1px solid #1e2035", marginBottom: 12 }} />

          {/* Place Column button */}
          <button onClick={() => {
            if (layerLock.walls) return;
            setWallToolActive(false);
            wallStateRef.current = { active: false, start: null, end: null };
            threeRef.current.clearWallGhost && threeRef.current.clearWallGhost();
            setColumnToolActive((v) => !v);
          }} style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            background: columnToolActive ? "linear-gradient(135deg, #c4622d, #e07a4a)" : "#13162a",
            border: columnToolActive ? "none" : "1px solid #1e2035",
            borderRadius: 10, color: columnToolActive ? "#fff" : layerLock.walls ? "#334155" : "#94a3b8",
            padding: "11px", fontSize: 13, cursor: layerLock.walls ? "not-allowed" : "pointer", fontWeight: 600, marginBottom: 8,
            opacity: layerLock.walls ? 0.4 : 1,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="8" y="2" width="8" height="20" rx="1"/></svg>
            {columnToolActive ? "Stop Placing" : "Place Column"}
          </button>
          {columnToolActive && (
            <div style={{ background: "#2d1a0a", border: "1px solid #4a2a10", borderRadius: 8, padding: "8px 10px", marginBottom: 10, fontSize: 10, color: "#fb923c", lineHeight: 1.6 }}>
              Click to place · Double-click or <b>Esc</b> to finish
            </div>
          )}

          {/* Column config */}
          <div style={{ background: "#0d0f18", border: "1px solid #1e2035", borderRadius: 8, padding: "10px", marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Column defaults</div>
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
              {["circular", "square"].map((s) => (
                <button key={s} onClick={() => setColumnConfig((c) => ({ ...c, shape: s }))}
                  style={{ flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600, borderRadius: 7, cursor: "pointer", border: `1px solid ${columnConfig.shape === s ? "#5b4bff" : "#1e2035"}`, background: columnConfig.shape === s ? "#5b4bff" : "#0d0f18", color: columnConfig.shape === s ? "#fff" : "#64748b" }}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {columnConfig.shape === "circular" ? (
                <div style={{ gridColumn: "span 2" }}>
                  <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 3 }}>Radius ({UNITS[unit].label})</label>
                  <input type="number" min="0.05" step="0.05" value={fmt(metersTo(columnConfig.radius, unit))}
                    onChange={(e) => setColumnConfig((c) => ({ ...c, radius: toMeters(parseFloat(e.target.value) || 0.1, unit) }))} style={inputStyle} />
                </div>
              ) : (
                <>
                  <div>
                    <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 3 }}>Width ({UNITS[unit].label})</label>
                    <input type="number" min="0.05" step="0.05" value={fmt(metersTo(columnConfig.width, unit))}
                      onChange={(e) => setColumnConfig((c) => ({ ...c, width: toMeters(parseFloat(e.target.value) || 0.1, unit) }))} style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 3 }}>Depth ({UNITS[unit].label})</label>
                    <input type="number" min="0.05" step="0.05" value={fmt(metersTo(columnConfig.depth, unit))}
                      onChange={(e) => setColumnConfig((c) => ({ ...c, depth: toMeters(parseFloat(e.target.value) || 0.1, unit) }))} style={inputStyle} />
                  </div>
                </>
              )}
              <div style={{ gridColumn: "span 2" }}>
                <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 3 }}>Height ({UNITS[unit].label})</label>
                <input type="number" min="0.1" step="0.1" value={fmt(metersTo(columnConfig.height, unit))}
                  onChange={(e) => setColumnConfig((c) => ({ ...c, height: toMeters(parseFloat(e.target.value) || 0.1, unit) }))} style={inputStyle} />
              </div>
            </div>
            <div style={{ marginTop: 6 }}>
              <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 3 }}>Color</label>
              <input type="color" value={columnConfig.color}
                onChange={(e) => setColumnConfig((c) => ({ ...c, color: e.target.value }))}
                style={{ width: "100%", height: 28, border: "1px solid #1e2035", borderRadius: 6, padding: 2, cursor: "pointer", background: "none" }} />
            </div>
          </div>
          {walls.some((w) => w.type === "column") && (
            <button onClick={() => setWalls((prev) => prev.filter((w) => w.type !== "column"))}
              style={{ width: "100%", background: "#2d1a1a", border: "1px solid #4a2020", borderRadius: 8, color: "#f87171", padding: "7px 12px", fontSize: 11, cursor: "pointer", marginTop: 4 }}>
              Clear all columns
            </button>
          )}
        </Section>

      </div>

      {/* ===== CANVAS ===== */}
      <div ref={mountRef} onDragOver={(e) => e.preventDefault()} onDrop={handleDrop} style={{ flex: 1, minWidth: 0, position: "relative" }}>

        {/* Layout 2D overlay */}
        {layoutMode && (
          <Layout2DOverlay
            mountRef={mountRef}
            threeRef={threeRef}
            items={items}
            walls={walls}
            catalog={catalog}
            floorW={floorW}
            floorD={floorD}
            floorPlan={floorPlan}
            selectedUids={selectedUids}
            selectedWallUid={selectedWallUid}
            activeTool={layout2dTool}
            setActiveTool={setLayout2dTool}
            onMoveItems={(patches) => setItems((prev) => prev.map((it) => { const p = patches[it.uid]; return p ? { ...it, ...p } : it; }))}
            onMoveWall={(uid, patch) => setWalls((prev) => prev.map((w) => w.uid === uid ? { ...w, ...patch } : w))}
            onSelectUids={(uids) => { setSelectedUids(uids); setSelectedWallUid(null); }}
            onSelectWall={(uid) => { setSelectedWallUid(uid); setSelectedUids([]); }}
            onAddWall={(wall) => {
              if (wall.__removeUid) {
                setWalls((prev) => prev.filter(w => w.uid !== wall.__removeUid));
              } else {
                setWalls((prev) => [...prev, wall]);
              }
            }}
            unit={unit}
            UNITS={UNITS}
            fmt={fmt}
            metersTo={metersTo}
          />
        )}
        {/* Loading overlay */}
        {!libraryReady && (
          <div style={{ position: "absolute", inset: 0, zIndex: 50, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, background: "rgba(13,15,24,0.9)", backdropFilter: "blur(4px)" }}>
            <div style={{ width: 36, height: 36, border: "3px solid #1e2035", borderTopColor: "#5b4bff", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            <style>{"@keyframes spin { to { transform: rotate(360deg); } }"}</style>
            <div style={{ fontSize: 13, color: "#94a3b8" }}>{manifestStatus ? manifestStatus.message : "Loading library…"}</div>
          </div>
        )}

        {/* Hint panel — top left */}
        {(() => {
          let title = null, color = "#94a3b8", hints = [];
          if (measureToolActive) {
            title = "Measure tool"; color = "#f59e0b";
            hints = [
              { key: "Click", desc: "set start point" },
              { key: "Click", desc: "place measurement" },
              { key: "Shift", desc: "free snap" },
              { key: "Esc", desc: "exit & clear" },
            ];
          } else if (arrayHandleActive) {
            title = "Array mode"; color = "#4ade80";
            hints = [
              { key: "Scroll / ↑ ↓", desc: "number of copies" },
              { key: "Shift", desc: "free angle" },
              { key: "Alt", desc: "snap to width" },
              { key: "Esc", desc: "cancel" },
            ];
          } else if (pendingLineDef) {
            title = `Array: ${pendingLineDef.def.name}`; color = "#4ade80";
            hints = [
              { key: "Click", desc: "set start point" },
              { key: "Scroll", desc: `copies (${lineCount})` },
              { key: "← →", desc: "rotate line" },
              { key: "Click", desc: "place" },
            ];
          } else if (wallToolActive) {
            title = "Wall tool"; color = "#5b4bff";
            hints = [
              { key: "Click", desc: "set point" },
              { key: "Shift", desc: "lock angle" },
              { key: "Alt", desc: "free angle" },
              { key: "Esc", desc: "finish" },
            ];
          } else if (selectedUids.length === 1 && selectedItem) {
            title = selectedItem.kind === "wall" ? "Wall selected" : "Object selected"; color = "#00e5ff";
            hints = [
              { key: "← → ↑ ↓", desc: "move" },
              { key: "Shift + ← →", desc: "rotate 15°" },
              { key: "Ctrl+D", desc: "duplicate" },
              { key: "Del", desc: "delete" },
              { key: "✚", desc: "drag to create array" },
            ];
          } else if (selectedUids.length > 1) {
            title = `Group (${selectedUids.length} objects)`; color = "#00e5ff";
            hints = [
              { key: "← → ↑ ↓", desc: "move group" },
              { key: "Shift + ← →", desc: "rotate around pivot" },
              { key: "Shift + Alt + ← →", desc: "rotate each in place" },
              { key: "Del", desc: "delete all" },
            ];
          }
          if (!title) return null;
          return (
            <div style={{ position: "absolute", top: 12, left: 12, background: "rgba(13,15,24,0.88)", border: `1px solid ${color}33`, borderRadius: 10, padding: "10px 14px", minWidth: 220, zIndex: 10, backdropFilter: "blur(8px)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color, marginBottom: 8, letterSpacing: "0.04em", textTransform: "uppercase" }}>{title}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {hints.map(({ key, desc }, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ background: "#1e2035", border: "1px solid #2a2f4a", borderRadius: 5, color: "#e2e8f0", fontSize: 10, fontWeight: 600, padding: "2px 7px", whiteSpace: "nowrap", fontFamily: "monospace" }}>{key}</span>
                    <span style={{ color: "#94a3b8", fontSize: 11 }}>{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* 3D / Layout mode toggle — top right above gizmo */}
        <div style={{ position: "absolute", top: 12, right: 12, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <div style={{ display: "flex", gap: 2, background: "rgba(13,17,23,0.85)", borderRadius: 10, padding: 4, backdropFilter: "blur(8px)", border: "1px solid #1e2035" }}>
            <button onClick={() => { setLayoutMode(false); threeRef.current.applyLayoutMode(false); }}
              style={{ padding: "5px 14px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700, background: !layoutMode ? "#5b4bff" : "transparent", color: !layoutMode ? "#fff" : "#64748b" }}>
              3D
            </button>
            <button onClick={() => { setLayoutMode(true); threeRef.current.applyLayoutMode(true); }}
              style={{ padding: "5px 14px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700, background: layoutMode ? "#00e5ff" : "transparent", color: layoutMode ? "#0d0f18" : "#64748b" }}>
              Layout
            </button>
          </div>

        {/* View gizmo — hidden in layout mode */}
        {!layoutMode && <div style={{ display: "flex", gap: 3, background: "rgba(13,17,23,0.85)", borderRadius: 10, padding: 5, backdropFilter: "blur(8px)", border: "1px solid #1e2035" }}>
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
        </div>}
        </div>

        {/* Camera panel button — below gizmo */}
        <div style={{ position: "absolute", top: 70, right: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {/* Floor dark mode */}
          <button onClick={() => {
            const next = !floorDark;
            setFloorDark(next);
            const { floor } = threeRef.current;
            if (floor?.material) floor.material.color.set(next ? "#1a1a1a" : floorColorRef.current);
          }}
            title="Dark floor"
            style={{ width: 36, height: 36, background: floorDark ? "#1a1a1a" : "rgba(13,17,23,0.85)", border: `1px solid ${floorDark ? "#4a4a4a" : "#1e2035"}`, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", backdropFilter: "blur(8px)" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={floorDark ? "#e2e8f0" : "#64748b"} strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
          </button>
          <button onClick={() => {
            const next = !measureToolActive;
            setMeasureToolActive(next);
            measureToolActiveRef.current = next;
            if (!next) {
              measureStateRef.current = { active: false, start: null, measures: [] };
              const { measurePreviewLine, measurePreviewLabel, measureStartDot, measureGroup } = threeRef.current;
              measurePreviewLine.visible = false;
              measurePreviewLabel.visible = false;
              measureStartDot.visible = false;
              while (measureGroup.children.length) measureGroup.remove(measureGroup.children[0]);
            }
          }}
            title="Measure"
            style={{ width: 36, height: 36, background: measureToolActive ? "#5b4bff" : "rgba(13,17,23,0.85)", border: `1px solid ${measureToolActive ? "#5b4bff" : "#1e2035"}`, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", backdropFilter: "blur(8px)" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={measureToolActive ? "#fff" : "#64748b"} strokeWidth="2"><path d="M2 12h20M2 12l4-4M2 12l4 4M22 12l-4-4M22 12l-4 4"/></svg>
          </button>
          {!layoutMode && <button onClick={() => setShowCameraPanel((v) => !v)}
            title="Cameras"
            style={{ width: 36, height: 36, background: showCameraPanel ? "#5b4bff" : "rgba(13,17,23,0.85)", border: "1px solid #1e2035", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", backdropFilter: "blur(8px)" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={showCameraPanel ? "#fff" : "#64748b"} strokeWidth="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          </button>}
          {!layoutMode && showCameraPanel && (
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
              <div style={{ marginTop: 4, color: "#475569", fontSize: 10 }}>Mac</div>
              <div>Right-click or Alt + drag: orbit · Ctrl + drag: pan</div>
              <div style={{ marginTop: 4, color: "#475569", fontSize: 10 }}>PC</div>
              <div>Right-click + drag: orbit · Middle-click: pan</div>
            </>
          ) : (
            <>
              <div>Click: select · Drag: move</div>
              <div>Shift+click: multi-select</div>
              <div style={{ marginTop: 4, color: "#475569", fontSize: 10 }}>Mac</div>
              <div>Right-click or Alt + drag: orbit</div>
              <div>Ctrl + drag: pan · Scroll: zoom</div>
              <div style={{ marginTop: 4, color: "#475569", fontSize: 10 }}>PC</div>
              <div>Right-click + drag: orbit</div>
              <div>Middle-click + drag: pan · Scroll: zoom</div>
            </>
          )}
        </div>
      </div>

      {/* Right panel — always visible, empty state when nothing is selected */}
      <div style={{ width: 280, minWidth: 280, maxWidth: 280, flexShrink: 0, background: "#0d1117", display: "flex", flexDirection: "column", borderLeft: "1px solid #1e2035" }}>
        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid #1e2035", flexShrink: 0 }}>
          {[["properties", "Properties"], ["scene", "Scene List"]].map(([tab, label]) => (
            <button key={tab} onClick={() => setRightPanelTab(tab)} style={{
              flex: 1, padding: "10px 0", background: "none", border: "none", cursor: "pointer",
              fontSize: 11, fontWeight: 600, color: rightPanelTab === tab ? "#e2e8f0" : "#475569",
              borderBottom: rightPanelTab === tab ? "2px solid #5b4bff" : "2px solid transparent",
            }}>{label}</button>
          ))}
        </div>

        {/* Scene List tab */}
        {rightPanelTab === 'scene' && (
          <SceneListPanel
            sceneListData={sceneListData}
            items={items}
            walls={walls}
            itemCounts={itemCounts}
            selectedUids={selectedUids}
            projectName={projectName}
            unit={unit}
            UNITS={UNITS}
            fmt={fmt}
            metersTo={metersTo}
            threeRef={threeRef}
            setRightPanelTab={setRightPanelTab}
          />
        )}

        {/* Properties tab */}
        {rightPanelTab === 'properties' && (
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {selectedWallUid && !selectedItem ? (() => {
          const selWall = walls.find((w) => w.uid === selectedWallUid);
          if (!selWall) return null;
          if (selWall.type === "door") return (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                <div style={{ width: 3, height: 20, background: "#f59e0b", borderRadius: 2 }} />
                <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0, color: "#e2e8f0" }}>Door Properties</h3>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                <div>
                  <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Width ({UNITS[unit].label})</label>
                  <input type="number" min="0.3" step="0.05" value={fmt(metersTo(selWall.width || 0.9, unit))}
                    onChange={(e) => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, width: toMeters(parseFloat(e.target.value) || 0.9, unit) } : w))}
                    style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Height ({UNITS[unit].label})</label>
                  <input type="number" min="0.5" step="0.1" value={fmt(metersTo(selWall.height || 2.1, unit))}
                    onChange={(e) => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, height: toMeters(parseFloat(e.target.value) || 2.1, unit) } : w))}
                    style={inputStyle} />
                </div>
              </div>
              <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Open angle — {Math.round(selWall.openAngle ?? 45)}°</label>
              <input type="range" min="0" max="180" step="5" value={selWall.openAngle ?? 45}
                onChange={(e) => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, openAngle: parseFloat(e.target.value) } : w))}
                style={{ width: "100%", accentColor: "#f59e0b", marginBottom: 12 }} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                <div>
                  <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Hinge</label>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[["left", "◀ Left"], ["right", "Right ▶"]].map(([v, label]) => (
                      <button key={v} onClick={() => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, hingeSide: v } : w))}
                        style={{ flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600, borderRadius: 7, cursor: "pointer", border: `1px solid ${(selWall.hingeSide || "left") === v ? "#f59e0b" : "#1e2035"}`, background: (selWall.hingeSide || "left") === v ? "#f59e0b22" : "#0d0f18", color: (selWall.hingeSide || "left") === v ? "#f59e0b" : "#64748b" }}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Swing</label>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[[false, "↑ In"], [true, "↓ Out"]].map(([v, label]) => (
                      <button key={String(v)} onClick={() => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, flipSide: v } : w))}
                        style={{ flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600, borderRadius: 7, cursor: "pointer", border: `1px solid ${!!selWall.flipSide === v ? "#f59e0b" : "#1e2035"}`, background: !!selWall.flipSide === v ? "#f59e0b22" : "#0d0f18", color: !!selWall.flipSide === v ? "#f59e0b" : "#64748b" }}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Frame Color</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
                <input type="color" value={selWall.color || "#a07840"}
                  onChange={(e) => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, color: e.target.value } : w))}
                  style={{ width: 36, height: 36, border: "1px solid #1e2035", borderRadius: 8, padding: 2, cursor: "pointer", background: "none", flexShrink: 0 }} />
                <div style={{ flex: 1, height: 36, background: selWall.color || "#a07840", borderRadius: 8, border: "1px solid #1e2035" }} />
              </div>
              <button onClick={() => { setWalls((prev) => prev.filter((w) => w.uid !== selectedWallUid)); setSelectedWallUid(null); }}
                style={{ width: "100%", background: "#2d1a1a", border: "1px solid #4a2020", borderRadius: 8, color: "#f87171", padding: "8px", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>
                Delete Door
              </button>
            </>
          );
          if (selWall.type === "column") return (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                <div style={{ width: 3, height: 20, background: "#5b4bff", borderRadius: 2 }} />
                <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0, color: "#e2e8f0" }}>Column Properties</h3>
              </div>
              {/* Shape pills */}
              <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
                {["circular", "square"].map((s) => (
                  <button key={s} onClick={() => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, shape: s } : w))}
                    style={{ flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600, borderRadius: 7, cursor: "pointer", border: `1px solid ${selWall.shape === s ? "#5b4bff" : "#1e2035"}`, background: selWall.shape === s ? "#5b4bff" : "#0d0f18", color: selWall.shape === s ? "#fff" : "#64748b" }}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                {selWall.shape === "circular" ? (
                  <div style={{ gridColumn: "span 2" }}>
                    <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Radius ({UNITS[unit].label})</label>
                    <input type="number" min="0.05" step="0.05" value={fmt(metersTo(selWall.radius, unit))}
                      onChange={(e) => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, radius: toMeters(parseFloat(e.target.value) || 0.1, unit) } : w))}
                      style={inputStyle} />
                  </div>
                ) : (
                  <>
                    <div>
                      <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Width ({UNITS[unit].label})</label>
                      <input type="number" min="0.05" step="0.05" value={fmt(metersTo(selWall.width, unit))}
                        onChange={(e) => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, width: toMeters(parseFloat(e.target.value) || 0.1, unit) } : w))}
                        style={inputStyle} />
                    </div>
                    <div>
                      <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Depth ({UNITS[unit].label})</label>
                      <input type="number" min="0.05" step="0.05" value={fmt(metersTo(selWall.depth, unit))}
                        onChange={(e) => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, depth: toMeters(parseFloat(e.target.value) || 0.1, unit) } : w))}
                        style={inputStyle} />
                    </div>
                  </>
                )}
                <div style={{ gridColumn: "span 2" }}>
                  <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Height ({UNITS[unit].label})</label>
                  <input type="number" min="0.1" step="0.1" value={fmt(metersTo(selWall.height, unit))}
                    onChange={(e) => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, height: toMeters(parseFloat(e.target.value) || 0.1, unit) } : w))}
                    style={inputStyle} />
                </div>
              </div>
              {/* Position */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                <div>
                  <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>X ({UNITS[unit].label})</label>
                  <input type="number" step="0.1" value={fmt(metersTo(selWall.x, unit))}
                    onChange={(e) => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, x: toMeters(parseFloat(e.target.value) || 0, unit) } : w))}
                    style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Z ({UNITS[unit].label})</label>
                  <input type="number" step="0.1" value={fmt(metersTo(selWall.z, unit))}
                    onChange={(e) => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, z: toMeters(parseFloat(e.target.value) || 0, unit) } : w))}
                    style={inputStyle} />
                </div>
              </div>
              <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Color</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
                <input type="color" value={selWall.color}
                  onChange={(e) => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, color: e.target.value } : w))}
                  style={{ width: 36, height: 36, border: "1px solid #1e2035", borderRadius: 8, padding: 2, cursor: "pointer", background: "none", flexShrink: 0 }} />
                <div style={{ flex: 1, height: 36, background: selWall.color, borderRadius: 8, border: "1px solid #1e2035" }} />
              </div>
              {/* Rotate + Duplicate + Delete */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button onClick={() => setWalls((prev) => prev.map((w) => w.uid === selectedWallUid ? { ...w, rotY: ((w.rotY || 0) + Math.PI / 2) } : w))}
                  style={{ flex: 1, background: "#13162a", border: "1px solid #1e2035", borderRadius: 8, color: "#94a3b8", padding: "8px", fontSize: 11, cursor: "pointer", fontWeight: 500, minWidth: 60 }}>
                  ↻ 90°
                </button>
                <button onClick={() => {
                  const newCol = { ...selWall, uid: `col_${Date.now()}`, x: selWall.x + (selWall.radius || selWall.width || 0.3) * 2 + 0.1 };
                  setWalls((prev) => [...prev, newCol]);
                }} style={{ flex: 1, background: "#13162a", border: "1px solid #1e2035", borderRadius: 8, color: "#94a3b8", padding: "8px", fontSize: 11, cursor: "pointer", fontWeight: 500, minWidth: 60 }}>
                  Duplicate
                </button>
                <button onClick={() => { setWalls((prev) => prev.filter((w) => w.uid !== selectedWallUid)); setSelectedWallUid(null); }}
                  style={{ flex: 1, background: "#2d1a1a", border: "1px solid #4a2020", borderRadius: 8, color: "#f87171", padding: "8px", fontSize: 11, cursor: "pointer", fontWeight: 500, minWidth: 60 }}>
                  Delete
                </button>
              </div>
            </>
          );
          return (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 3, height: 20, background: "#5b4bff", borderRadius: 2 }} />
                  <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0, color: "#e2e8f0" }}>Wall Properties</h3>
                </div>
                {selWall.groupId && <span style={{ fontSize: 9, color: "#5b4bff", fontWeight: 700, background: "#5b4bff22", borderRadius: 4, padding: "2px 6px" }}>GROUP</span>}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                <div>
                  <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Height ({UNITS[unit].label})</label>
                  <input type="number" min="0.1" step="0.1" value={fmt(metersTo(selWall.height, unit))}
                    onChange={(e) => setWalls((prev) => prev.map((w) => (w.uid === selectedWallUid || (selWall.groupId && w.groupId === selWall.groupId)) ? { ...w, height: toMeters(parseFloat(e.target.value) || 0, unit) } : w))}
                    style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Thickness ({UNITS[unit].label})</label>
                  <input type="number" min="0.02" step="0.02" value={fmt(metersTo(selWall.thickness || 0.1, unit))}
                    onChange={(e) => setWalls((prev) => prev.map((w) => (w.uid === selectedWallUid || (selWall.groupId && w.groupId === selWall.groupId)) ? { ...w, thickness: toMeters(parseFloat(e.target.value) || 0.1, unit) } : w))}
                    style={inputStyle} />
                </div>
              </div>
              <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Glass — {Math.round(selWall.glassRatio * 100)}%</label>
              <input type="range" min="0" max="1" step="0.05" value={selWall.glassRatio}
                onChange={(e) => setWalls((prev) => prev.map((w) => (w.uid === selectedWallUid || (selWall.groupId && w.groupId === selWall.groupId)) ? { ...w, glassRatio: parseFloat(e.target.value) } : w))}
                style={{ width: "100%", accentColor: "#5b4bff", marginBottom: 12 }} />
              <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Color</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
                <input type="color" value={selWall.color}
                  onChange={(e) => setWalls((prev) => prev.map((w) => (w.uid === selectedWallUid || (selWall.groupId && w.groupId === selWall.groupId)) ? { ...w, color: e.target.value } : w))}
                  style={{ width: 36, height: 36, border: "1px solid #1e2035", borderRadius: 8, padding: 2, cursor: "pointer", background: "none", flexShrink: 0 }} />
                <div style={{ flex: 1, height: 36, background: selWall.color, borderRadius: 8, border: "1px solid #1e2035" }} />
              </div>
              {selWall.groupId && (
                <button onClick={() => {
                  setWalls((prev) => prev.map((w) => w.groupId === selWall.groupId ? { ...w, groupId: null } : w));
                }} style={{ width: "100%", background: "#13162a", border: "1px solid #1e2035", borderRadius: 8, color: "#94a3b8", padding: "8px", fontSize: 12, cursor: "pointer", fontWeight: 500, marginBottom: 8 }}>
                  Ungroup walls
                </button>
              )}
              <button
                onClick={() => {
                  setWalls((prev) => prev.filter((w) =>
                    selWall.groupId ? w.groupId !== selWall.groupId : w.uid !== selectedWallUid
                  ));
                  setSelectedWallUid(null);
                }}
                style={{ width: "100%", background: "#2d1a1a", border: "1px solid #4a2020", borderRadius: 8, color: "#f87171", padding: "8px", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>
                {selWall.groupId ? "Delete Wall Group" : "Delete Wall"}
              </button>
            </>
          );
        })() : selectedItem && selectedDef ? (
          <>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <div style={{ width: 3, height: 24, background: "#5b4bff", borderRadius: 2, flexShrink: 0 }} />
            <div>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0, color: "#e2e8f0" }}>{selectedDef.name}</h3>
              {selectedUids.length > 1 && <div style={{ fontSize: 10, color: "#c4622d", marginTop: 2 }}>{selectedUids.length} objects selected</div>}
            </div>
          </div>

          {/* Group card */}
          {(() => {
            const selItems = items.filter((it) => selectedUids.includes(it.uid));
            const outerGroupId0 = getOuterGroupId(selItems[0]);
            const innerGroupId0 = getInnerGroupId(selItems[0]);
            const allSameOuterGroup = selItems.length > 1 && selItems.every((it) => getOuterGroupId(it) && getOuterGroupId(it) === outerGroupId0);
            const allSameInnerGroup = selItems.length > 1 && selItems.every((it) => getInnerGroupId(it) && getInnerGroupId(it) === innerGroupId0);
            // "allSameGroup" for UI purposes = same outer group (could be super-group or single array)
            const allSameGroup = allSameOuterGroup;
            // array spacing panel only makes sense when all share the same innermost group
            const showArrayPanel = allSameInnerGroup && selItems[0].pivotX != null;
            const hasAnyGroup = selItems.some((it) => getGroupIds(it).length > 0);
            const isPartOfGroup = selectedUids.length === 1 && getGroupIds(selectedItem).length > 0;
            const depth = getGroupIds(selectedItem).length;

            // single item in a group
            if (isPartOfGroup) return (
              <div style={{ background: "#0e1a14", border: "1px solid #1a3a28", borderRadius: 10, padding: "10px 12px", marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                  <span style={{ fontSize: 11, color: "#4ade80", fontWeight: 600 }}>Part of a group {depth > 1 ? `(${depth} levels deep)` : ""}</span>
                </div>
                <div style={{ fontSize: 10, color: "#64748b", marginBottom: 8, lineHeight: 1.5 }}>Click = select outer group · Double-click = go one level in</div>
                <button onClick={() => setItems((prev) => prev.map((it) => it.uid === selectedItem.uid ? withoutOuterGroup(it) : it))}
                  style={{ width: "100%", background: "#13162a", border: "1px solid #1e2035", borderRadius: 7, color: "#94a3b8", padding: "6px", fontSize: 11, cursor: "pointer", fontWeight: 500 }}>
                  Remove from outer group
                </button>
              </div>
            );

            // multi-selection
            if (selectedUids.length > 1) return (
              <div style={{ background: "#0e1a14", border: "1px solid #1a3a28", borderRadius: 10, padding: "10px 12px", marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                  <span style={{ fontSize: 11, color: "#4ade80", fontWeight: 600 }}>
                    {allSameGroup ? "Whole group selected" : `${selectedUids.length} objects selected`}
                  </span>
                </div>
                {allSameGroup && (
                  <div style={{ fontSize: 10, color: "#64748b", marginBottom: 8, lineHeight: 1.5 }}>
                    ← → rotates around pivot · Shift+← → rotates each in place
                  </div>
                )}
                {allSameGroup && selItems[0].pivotX != null && (() => {
                  // only show array spacing panel when all items share the same inner group
                  if (!showArrayPanel) return null;
                  // calcular espaciado actual
                  const sorted = [...selItems].sort((a, b) => {
                    const px = selItems[0].pivotX; const pz = selItems[0].pivotZ ?? 0;
                    return Math.hypot(a.x - px, a.z - pz) - Math.hypot(b.x - px, b.z - pz);
                  });
                  const currentSpacing = sorted.length >= 2
                    ? Math.hypot(sorted[1].x - sorted[0].x, sorted[1].z - sorted[0].z)
                    : (findDef(selItems[0].kind, selItems[0].catalogId)?.w || 1);
                  const def = findDef(selItems[0].kind, selItems[0].catalogId);
                  const objWidth = def?.w || 1;
                  const centerToCenter = sorted.length >= 2
                    ? Math.hypot(sorted[1].x - sorted[0].x, sorted[1].z - sorted[0].z)
                    : objWidth;
                  const currentGap = centerToCenter - objWidth; // gap entre bordes
                  const minSpacing = 0; // mínimo gap = 0 (continuo)
                  const dir = sorted.length >= 2
                    ? new THREE.Vector3(sorted[1].x - sorted[0].x, 0, sorted[1].z - sorted[0].z).normalize()
                    : new THREE.Vector3(Math.sin(selItems[0].rotY + Math.PI / 2), 0, Math.cos(selItems[0].rotY + Math.PI / 2));
                  return (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 9, color: "#475569", marginBottom: 3 }}>Count</div>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <button onClick={() => {
                              if (sorted.length <= 1) return;
                              const last = sorted[sorted.length - 1];
                              const remaining = sorted.slice(0, -1);
                              if (remaining.length === 1) {
                                // queda solo 1 — desagrupar
                                setItems((prev) => prev
                                  .filter((it) => it.uid !== last.uid)
                                  .map((it) => it.uid === remaining[0].uid ? withoutOuterGroup(it) : it));
                                setTimeout(() => threeRef.current.setSelectedGroup([remaining[0].uid]), 0);
                              } else {
                                const newUids = selectedUids.filter((uid) => uid !== last.uid);
                                setItems((prev) => prev.filter((it) => it.uid !== last.uid));
                                setTimeout(() => threeRef.current.setSelectedGroup(newUids), 0);
                              }
                            }} style={{ width: 24, height: 24, background: "#1e2035", border: "1px solid #2a2f4a", borderRadius: 5, color: "#e2e8f0", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                            <span style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0", minWidth: 24, textAlign: "center" }}>{sorted.length}</span>
                            <button onClick={() => {
                              const last = sorted[sorted.length - 1];
                              const newPos = new THREE.Vector3(last.x + dir.x * centerToCenter, 0, last.z + dir.z * centerToCenter);
                              const newItem = {
                                uid: `${last.catalogId}_${Date.now()}_add`,
                                catalogId: last.catalogId, kind: last.kind,
                                x: newPos.x, z: newPos.z, rotY: last.rotY,
                                color: varyColor(last.color, sorted.length),
                                sockets: { ...last.sockets }, groupIds: getGroupIds(last),
                                pivotX: sorted[0].x, pivotZ: sorted[0].z,
                              };
                              threeRef.current.commitLineItems([newItem]);
                              setTimeout(() => threeRef.current.setSelectedGroup([...selectedUids, newItem.uid]), 0);
                            }} style={{ width: 24, height: 24, background: "#1e2035", border: "1px solid #2a2f4a", borderRadius: 5, color: "#e2e8f0", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                          </div>
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 9, color: "#475569", marginBottom: 3 }}>Spacing ({UNITS[unit].label})</div>
                          <input type="number" min="0" step="0.1"
                            value={fmt(metersTo(Math.max(0, currentGap), unit))}
                            onChange={(e) => {
                              const newGap = Math.max(0, toMeters(parseFloat(e.target.value) || 0, unit));
                              const newCenterToCenter = objWidth + newGap;
                              setItems((prev) => prev.map((it) => {
                                if (!selectedUids.includes(it.uid)) return it;
                                const idx = sorted.findIndex((s) => s.uid === it.uid);
                                if (idx < 0) return it;
                                const newPos = new THREE.Vector3(
                                  sorted[0].x + dir.x * newCenterToCenter * idx,
                                  0,
                                  sorted[0].z + dir.z * newCenterToCenter * idx
                                );
                                return { ...it, x: newPos.x, z: newPos.z };
                              }));
                            }}
                            style={{ ...inputStyle, width: "100%" }} />
                        </div>
                      </div>
                    </div>
                  );
                })()}
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    disabled={allSameOuterGroup}
                    onClick={() => {
                      const newGroupId = `group_${Date.now()}`;
                      const cx = selItems.reduce((s, it) => s + it.x, 0) / selItems.length;
                      const cz = selItems.reduce((s, it) => s + it.z, 0) / selItems.length;
                      setItems((prev) => prev.map((it) => selectedUids.includes(it.uid)
                        ? { ...withOuterGroup(it, newGroupId), pivotX: cx, pivotZ: cz }
                        : it));
                    }}
                    style={{ flex: 1, background: allSameOuterGroup ? "#1e2035" : "#5b4bff", border: "none", borderRadius: 7, color: allSameOuterGroup ? "#475569" : "#fff", padding: "7px", fontSize: 11, cursor: allSameOuterGroup ? "default" : "pointer", fontWeight: 600 }}>
                    Group
                  </button>
                  {hasAnyGroup && (
                    <button onClick={() => setItems((prev) => prev.map((it) => selectedUids.includes(it.uid) ? withoutOuterGroup(it) : it))}
                      style={{ flex: 1, background: "#13162a", border: "1px solid #1e2035", borderRadius: 7, color: "#94a3b8", padding: "7px", fontSize: 11, cursor: "pointer", fontWeight: 500 }}>
                      Ungroup
                    </button>
                  )}
                </div>

                {/* Alignment tools */}
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 6 }}>Align to last selected</div>
                  <div style={{ display: "flex", gap: 3 }}>
                    {[
                      ['x',    'M12 3v18M7 8h10M7 16h10', 'X axis'],
                      ['z',    'M3 12h18M8 7v10M16 7v10', 'Z axis'],
                      ['both', 'M12 3v18M3 12h18',        'Both'],
                    ].map(([type, path, label]) => (
                      <button key={type} onClick={() => alignSelected(type)} title={`Align ${label}`}
                        style={{ flex: 1, height: 30, background: "#1e2035", border: "1px solid #2a2f4a", borderRadius: 6, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2">
                          {path.split('M').filter(Boolean).map((d, i) => <path key={i} d={`M${d}`}/>)}
                        </svg>
                        <span style={{ fontSize: 9, color: "#64748b" }}>{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            );

            return null;
          })()}

          {/* Position */}
          {selectedUids.length === 1 && (
            <div style={{ background: "#13162a", border: "1px solid #1e2035", borderRadius: 10, padding: "10px 12px", marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 8 }}>Position ({UNITS[unit].label})</div>
              <div style={{ display: "flex", gap: 6 }}>
                {[["X", "x"], ["Z", "z"]].map(([label, key]) => (
                  <div key={key} style={{ flex: 1 }}>
                    <div style={{ fontSize: 9, color: "#475569", marginBottom: 3 }}>{label}</div>
                    <input type="number" step="0.1" value={fmt(metersTo(selectedItem[key], unit))}
                      onChange={(e) => updateSelected({ [key]: toMeters(parseFloat(e.target.value) || 0, unit) })} style={inputStyle} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Size — primitives only */}
          {selectedItem.kind === "primitive" && selectedUids.length === 1 && (
            <div style={{ background: "#13162a", border: "1px solid #1e2035", borderRadius: 10, padding: "10px 12px", marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 8 }}>Size ({UNITS[unit].label})</div>
              <div style={{ display: "flex", gap: 6 }}>
                {[["W", "w", selectedDef.w], ["D", "d", selectedDef.d], ["H", "h", selectedDef.h]].map(([label, key, def]) => (
                  <div key={key} style={{ flex: 1 }}>
                    <div style={{ fontSize: 9, color: "#475569", marginBottom: 3 }}>{label}</div>
                    <input type="number" min={fmt(metersTo(0.001, unit))} step={fmt(metersTo(0.01, unit))} value={fmt(metersTo(selectedItem[key] ?? def, unit))}
                      onChange={(e) => updateSelected({ [key]: Math.max(0.001, toMeters(parseFloat(e.target.value) || 0, unit)) })} style={inputStyle} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Prop height */}
          {selectedItem.kind === "prop" && selectedUids.length === 1 && (
            <div style={{ background: "#13162a", border: "1px solid #1e2035", borderRadius: 10, padding: "10px 12px", marginBottom: 8 }}>
              {selectedItem.parentUid ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
                    <span style={{ fontSize: 10, color: "#4ade80", fontWeight: 600 }}>
                      Attached to {(() => { const p = items.find(i => i.uid === selectedItem.parentUid); const d = p && findDef(p.kind, p.catalogId); return d ? d.name : "object"; })()}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 6 }}>Height ({UNITS[unit].label})</div>
                  <input type="number" step="0.05" value={fmt(metersTo(selectedItem.localOffset.y, unit))}
                    onChange={(e) => updateSelected({ localOffset: { ...selectedItem.localOffset, y: toMeters(parseFloat(e.target.value) || 0, unit) } })}
                    style={{ ...inputStyle, marginBottom: 8 }} />
                  <button onClick={() => updateSelected({ parentUid: null, localOffset: null, yOffset: selectedItem.localOffset.y })}
                    style={{ width: "100%", background: "#13162a", border: "1px solid #2a2f4a", borderRadius: 7, color: "#94a3b8", padding: "6px", fontSize: 11, cursor: "pointer" }}>
                    Detach
                  </button>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 6 }}>Height ({UNITS[unit].label})</div>
                  <input type="number" step="0.05" value={fmt(metersTo(selectedItem.yOffset || 0, unit))}
                    onChange={(e) => updateSelected({ yOffset: toMeters(parseFloat(e.target.value) || 0, unit) })} style={{ ...inputStyle, marginBottom: 6 }} />
                  <div style={{ fontSize: 10, color: "#475569" }}>Drag onto another object to attach</div>
                </>
              )}
            </div>
          )}

          {/* Rotation */}
          <div style={{ background: "#13162a", border: "1px solid #1e2035", borderRadius: 10, padding: "10px 12px", marginBottom: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 8 }}>Rotation</div>
            {selectedUids.length === 1 ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="number" step="1"
                  value={Math.round(((selectedItem.rotY * 180 / Math.PI) % 360 + 360) % 360)}
                  onChange={(e) => updateSelected({ rotY: (parseFloat(e.target.value) || 0) * Math.PI / 180 })}
                  style={{ ...inputStyle, flex: 1 }} />
                <span style={{ fontSize: 11, color: "#475569" }}>°</span>
                <button onClick={rotateSelected} style={{ background: "#1e2035", border: "1px solid #2a2f4a", borderRadius: 7, color: "#94a3b8", padding: "6px 10px", fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" }}>+90°</button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ fontSize: 10, color: "#475569" }}>Shift + ← → · rotate group around pivot</div>
                <div style={{ fontSize: 10, color: "#475569" }}>Shift + Alt + ← → · rotate each in place</div>
              </div>
            )}
          </div>

          {/* Color */}
          <div style={{ background: "#13162a", border: "1px solid #1e2035", borderRadius: 10, padding: "10px 12px", marginBottom: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 8 }}>Color</div>
            {isWholeGroupSelected && (
              <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
                {[["varied", "Varied"], ["solid", "Solid"]].map(([mode, label]) => (
                  <button key={mode} onClick={() => {
                    setGroupColorMode(mode);
                    // aplicar inmediatamente al grupo con el color actual
                    const baseColor = selectedItem.color;
                    setItems((prev) => {
                      const groupItems = prev.filter((it) => selectedUids.includes(it.uid));
                      return prev.map((it) => {
                        if (!selectedUids.includes(it.uid)) return it;
                        const idx = groupItems.indexOf(it);
                        return { ...it, color: mode === 'varied' ? varyColor(baseColor, idx) : baseColor };
                      });
                    });
                  }}
                    style={{ flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600, borderRadius: 7, cursor: "pointer", border: `1px solid ${groupColorMode === mode ? "#5b4bff" : "#1e2035"}`, background: groupColorMode === mode ? "#5b4bff" : "#0d0f18", color: groupColorMode === mode ? "#fff" : "#64748b" }}>
                    {label}
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="color" value={selectedItem.color} onChange={(e) => updateColor(e.target.value)}
                style={{ width: 40, height: 40, border: "1px solid #1e2035", borderRadius: 8, padding: 2, cursor: "pointer", background: "none", flexShrink: 0 }} />
              <div style={{ flex: 1, height: 40, background: selectedItem.color, borderRadius: 8, border: "1px solid #1e2035" }} />
            </div>
          </div>

          {/* Accessories */}
          {selectedItem.kind === "model" && selectedDef.sockets && selectedDef.sockets.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 8 }}>Accessories</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {selectedDef.sockets.map((s) => {
                  const sName = getSocketName(s);
                  const repeatable = isRepeatableSocket(sName);
                  const cfg = selectedItem.sockets && selectedItem.sockets[sName];
                  const isOn = repeatable ? !!(cfg && cfg.enabled) : !!cfg;
                  const isLamp = sName.includes("lamp");
                  const accentColor = isLamp ? "#f59e0b" : "#818cf8";
                  const accentBg = isLamp ? "#1a1600" : "#0e0d1f";
                  const accentBorder = isLamp ? "#f59e0b33" : "#5b4bff44";
                  const icon = isLamp
                    ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={isOn ? accentColor : "#475569"} strokeWidth="2"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 1 7 7c0 2.5-1.3 4.7-3.3 6H8.3C6.3 13.7 5 11.5 5 9a7 7 0 0 1 7-7z"/></svg>
                    : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={isOn ? accentColor : "#475569"} strokeWidth="2"><rect x="2" y="3" width="20" height="4" rx="1"/><rect x="2" y="10" width="20" height="4" rx="1"/><rect x="2" y="17" width="20" height="4" rx="1"/></svg>;
                  return (
                    <div key={sName} style={{ borderRadius: 10, border: `1.5px solid ${isOn ? accentBorder : "#1e2035"}`, background: isOn ? accentBg : "#13162a", overflow: "hidden" }}>
                      <div onClick={() => toggleSocket(sName)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", cursor: "pointer" }}>
                        <div style={{ width: 32, height: 32, borderRadius: 8, background: isOn ? `${accentColor}22` : "#1e2035", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          {icon}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: isOn ? accentColor : "#475569" }}>
                            {isLamp ? "Lamp" : "Shelves"}
                          </div>
                          <div style={{ fontSize: 10, color: isOn ? `${accentColor}99` : "#334155" }}>
                            {isOn && repeatable && cfg ? `${cfg.count} shelves · ${fmt(metersTo(cfg.spacing, unit))}${UNITS[unit].label} spacing` : isLamp ? "Overhead spotlight" : "Display shelving"}
                          </div>
                        </div>
                        <div style={{ width: 36, height: 20, background: isOn ? accentColor : "#1e2035", border: isOn ? "none" : "1px solid #2a2f4a", borderRadius: 10, position: "relative", flexShrink: 0 }}>
                          <div style={{ width: 16, height: 16, background: isOn ? "#fff" : "#475569", borderRadius: "50%", position: "absolute", top: 2, left: isOn ? 18 : 2 }} />
                        </div>
                      </div>
                      {isLamp && isOn && (
                        <div style={{ borderTop: "1px solid #1e2035", padding: "8px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                          <button onClick={() => { const sc = selectedItem.sockets[sName]; if (!sc) return; setItems((prev) => prev.map((it) => it.uid !== selectedItem.uid && it.catalogId === selectedItem.catalogId ? { ...it, sockets: { ...it.sockets, [sName]: sc } } : it)); }}
                            style={{ width: "100%", background: "#13162a", border: `1px solid ${accentColor}33`, borderRadius: 7, color: accentColor, fontSize: 10, padding: "6px", cursor: "pointer", fontWeight: 600 }}>
                            Apply to all {selectedDef.name}
                          </button>
                          <button onClick={() => setItems((prev) => prev.map((it) => it.catalogId === selectedItem.catalogId ? { ...it, sockets: { ...it.sockets, [sName]: null } } : it))}
                            style={{ width: "100%", background: "#13162a", border: "1px solid #2a2f4a", borderRadius: 7, color: "#64748b", fontSize: 10, padding: "6px", cursor: "pointer", fontWeight: 600 }}>
                            Turn off all {selectedDef.name}
                          </button>
                        </div>
                      )}
                      {repeatable && isOn && cfg && (
                        <div style={{ borderTop: "1px solid #1e2035", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontSize: 10, color: "#64748b", width: 72 }}>Count</span>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
                              <button onClick={() => updateSocketConfig(sName, { count: Math.max(1, cfg.count - 1) })}
                                style={{ width: 26, height: 26, background: "#1e2035", border: "1px solid #2a2f4a", borderRadius: 6, color: "#e2e8f0", fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                              <span style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0", minWidth: 20, textAlign: "center" }}>{cfg.count}</span>
                              <button onClick={() => updateSocketConfig(sName, { count: cfg.count + 1 })}
                                style={{ width: 26, height: 26, background: "#1e2035", border: "1px solid #2a2f4a", borderRadius: 6, color: "#e2e8f0", fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                            </div>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontSize: 10, color: "#64748b", width: 72 }}>Spacing</span>
                            <input type="number" min="0.05" step="0.05" value={fmt(metersTo(cfg.spacing, unit))}
                              onChange={(e) => updateSocketConfig(sName, { spacing: Math.max(0.05, toMeters(parseFloat(e.target.value) || 0, unit)) })}
                              style={{ ...inputStyle, flex: 1 }} />
                            <span style={{ fontSize: 10, color: "#475569" }}>{UNITS[unit].label}</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontSize: 10, color: "#64748b", width: 72 }}>Base height</span>
                            <input type="number" min="0" step="0.05" value={fmt(metersTo(cfg.baseHeight, unit))}
                              onChange={(e) => updateSocketConfig(sName, { baseHeight: Math.max(0, toMeters(parseFloat(e.target.value) || 0, unit)) })}
                              style={{ ...inputStyle, flex: 1 }} />
                            <span style={{ fontSize: 10, color: "#475569" }}>{UNITS[unit].label}</span>
                          </div>
                          <button onClick={() => { const sc = selectedItem.sockets[sName]; if (!sc) return; setItems((prev) => prev.map((it) => it.uid !== selectedItem.uid && it.catalogId === selectedItem.catalogId ? { ...it, sockets: { ...it.sockets, [sName]: { ...sc } } } : it)); }}
                            style={{ width: "100%", background: "#13162a", border: `1px solid ${accentColor}33`, borderRadius: 7, color: accentColor, fontSize: 10, padding: "6px", cursor: "pointer", fontWeight: 600 }}>
                            Apply to all {selectedDef.name}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Actions */}
          <div style={{ background: "#13162a", border: "1px solid #1e2035", borderRadius: 10, padding: "10px 12px", marginBottom: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 8 }}>Actions</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <button onClick={() => {
                if (selectedUids.length > 1) {
                  rotateGroupAroundPivot(90);
                } else {
                  rotateSelected();
                }
              }} style={{ flex: 1, background: "#1e2035", border: "1px solid #2a2f4a", borderRadius: 7, color: "#94a3b8", padding: "7px 4px", fontSize: 11, cursor: "pointer" }}>↻ 90°</button>
              <button onClick={duplicateSelected} style={{ flex: 1, background: "#1e2035", border: "1px solid #2a2f4a", borderRadius: 7, color: "#94a3b8", padding: "7px 4px", fontSize: 11, cursor: "pointer" }}>Duplicate</button>
              <button onClick={mirrorSelected} style={{ flex: 1, background: "#1e2035", border: "1px solid #2a2f4a", borderRadius: 7, color: "#94a3b8", padding: "7px 4px", fontSize: 11, cursor: "pointer" }}>Mirror</button>
            </div>
            <div style={{ fontSize: 9, color: "#334155", marginBottom: 8 }}>Ctrl/Cmd + D to duplicate</div>
            <button onClick={deleteSelected}
              style={{ width: "100%", background: "#2d1a1a", border: "1px solid #4a2020", borderRadius: 7, color: "#f87171", padding: "8px", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>
              Delete
            </button>
          </div>
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
        )}
      </div>{/* end right panel */}
      </div>{/* end main content */}

      {/* ===== BOTTOM BAR — Scene summary ===== */}
      <div style={{ height: 52, minHeight: 52, background: "#0d1117", borderTop: "1px solid #1e2035", display: "flex", alignItems: "center", padding: "0 16px", gap: 8, flexShrink: 0, overflowX: "auto" }}>
        <span style={{ fontSize: 11, color: "#334155", fontWeight: 600, whiteSpace: "nowrap", marginRight: 4 }}>In scene:</span>

        {/* Model chips — one per catalogId that has items */}
        {Object.entries(itemCounts).filter(([, count]) => count > 0).map(([catalogId, count]) => {
          const it = items.find((it) => it.catalogId === catalogId);
          const kind = it?.kind || "model";
          // hide chip if layer is hidden
          if (kind === "model" && (!layerVisibility.models || hiddenCatalogIds.has(catalogId))) return null;
          if (kind === "primitive" && !layerVisibility.primitives) return null;
          if (kind === "prop" && !layerVisibility.props) return null;
          const def = findDef(kind, catalogId);
          if (!def) return null;
          const thumb = thumbnails[catalogId];
          const color = catalogColors[catalogId] || def.color || "#1e2035";
          return (
            <div key={catalogId} style={{ display: "flex", alignItems: "center", gap: 6, background: "#13162a", border: "1px solid #1e2035", borderRadius: 20, padding: "4px 10px 4px 4px", flexShrink: 0 }}>
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
        {walls.length > 0 && layerVisibility.walls && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#13162a", border: "1px solid #1e2035", borderRadius: 20, padding: "4px 10px 4px 8px", flexShrink: 0 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>
            <span style={{ fontSize: 11, color: "#e2e8f0", fontWeight: 500 }}>Walls</span>
            <span style={{ background: "#5b4bff", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 10, padding: "1px 7px" }}>{walls.length}</span>
          </div>
        )}

        {/* Accessory chips */}
        {(() => {
          // contar accesorios activos por tipo
          const accCounts = {};
          items.forEach((it) => {
            if (!it.sockets) return;
            Object.entries(it.sockets).forEach(([sName, cfg]) => {
              if (!cfg) return;
              const isOn = typeof cfg === 'object' ? cfg.enabled : !!cfg;
              if (!isOn) return;
              // nombre legible del socket
              const label = sName.includes('lamp') ? 'Lamp' : sName.includes('shelf') ? 'Shelves' : sName.replace('socket_', '');
              const count = typeof cfg === 'object' && cfg.count ? cfg.count : 1;
              accCounts[label] = (accCounts[label] || 0) + count;
            });
          });
          return Object.entries(accCounts).map(([label, count]) => {
            const isLamp = label === 'Lamp';
            const color = isLamp ? "#f59e0b" : "#818cf8";
            const icon = isLamp
              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 1 7 7c0 2.5-1.3 4.7-3.3 6H8.3C6.3 13.7 5 11.5 5 9a7 7 0 0 1 7-7z"/></svg>
              : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><rect x="2" y="3" width="20" height="4" rx="1"/><rect x="2" y="10" width="20" height="4" rx="1"/><rect x="2" y="17" width="20" height="4" rx="1"/></svg>;
            return (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 5, background: "#13162a", border: `1px solid ${color}33`, borderRadius: 20, padding: "4px 10px 4px 8px", flexShrink: 0 }}>
                {icon}
                <span style={{ fontSize: 11, color: "#e2e8f0", fontWeight: 500 }}>{label}</span>
                <span style={{ background: color, color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 10, padding: "1px 7px" }}>{count}</span>
              </div>
            );
          });
        })()}

        {/* Empty state */}
        {Object.values(itemCounts).every((v) => !v) && walls.length === 0 && (
          <span style={{ fontSize: 11, color: "#1e2a3a", fontStyle: "italic" }}>No objects placed yet</span>
        )}

      </div>{/* end bottom bar */}

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

// ===================== Island Builder =====================
// palette colors for models added to the brush palette
const PALETTE_COLORS = ["#5b4bff","#00e5ff","#f59e0b","#4ade80","#f87171","#a855f7","#fb923c","#34d399"];

function IslandBuilder({ catalog, thumbs, catalogColors, unit, UNITS, fmt, metersTo, onPlace, onCancel }) {
  const [cols, setCols] = React.useState(4);
  const [rows, setRows] = React.useState(4);
  const [cells, setCells] = React.useState({});
  const [rowOffsets, setRowOffsets] = React.useState({});
  const [colOffsets, setColOffsets] = React.useState({});

  // palette: [{ id, def, color, dims }]
  const [palette, setPalette] = React.useState([]);
  const [activeBrushId, setActiveBrushId] = React.useState(null);
  const [showCatalogPicker, setShowCatalogPicker] = React.useState(false);
  const [loadingDims, setLoadingDims] = React.useState({});

  const activeBrush = palette.find((p) => p.id === activeBrushId);

  // add model to palette
  const addToPalette = (def) => {
    if (palette.find((p) => p.id === def.id)) {
      setActiveBrushId(def.id);
      setShowCatalogPicker(false);
      return;
    }
    const color = PALETTE_COLORS[palette.length % PALETTE_COLORS.length];
    const newEntry = { id: def.id, def, color, dims: null };
    setPalette((prev) => [...prev, newEntry]);
    setActiveBrushId(def.id);
    setShowCatalogPicker(false);
    // load real dims
    setLoadingDims((prev) => ({ ...prev, [def.id]: true }));
    measureModelDims(def.file)
      .then((d) => setPalette((prev) => prev.map((p) => p.id === def.id ? { ...p, dims: { w: d.w, d: d.d } } : p)))
      .catch(() => {})
      .finally(() => setLoadingDims((prev) => ({ ...prev, [def.id]: false })));
  };

  const getDims = (modelId) => {
    const entry = palette.find((p) => p.id === modelId);
    const def = entry?.def;
    return { w: entry?.dims?.w || def?.w || 1, d: entry?.dims?.d || def?.d || 1 };
  };

  const CELL_PX = 56;
  const ARROW_DIRS = [0, -Math.PI / 2, Math.PI, Math.PI / 2]; // N, E, S, W

  const autoRotate = (r, c, activeCells) => {
    const neighbours = [[r-1,c],[r,c+1],[r+1,c],[r,c-1]];
    const empty = neighbours.filter(([nr,nc]) => !activeCells[`${nr},${nc}`]);
    if (!empty.length) return 0;
    const faceMap = {
      [`${r-1},${c}`]: 0,           // north empty → face north
      [`${r},${c+1}`]: -Math.PI/2,  // east empty → face east
      [`${r+1},${c}`]: Math.PI,     // south empty → face south
      [`${r},${c-1}`]: Math.PI/2,   // west empty → face west
    };
    const best = empty.sort(([nr1,nc1],[nr2,nc2]) => {
      const n1 = [[nr1-1,nc1],[nr1+1,nc1],[nr1,nc1-1],[nr1,nc1+1]].filter(([a,b])=>activeCells[`${a},${b}`]).length;
      const n2 = [[nr2-1,nc2],[nr2+1,nc2],[nr2,nc2-1],[nr2,nc2+1]].filter(([a,b])=>activeCells[`${a},${b}`]).length;
      return n1 - n2;
    })[0];
    return faceMap[`${best[0]},${best[1]}`] ?? 0;
  };

  const cellSize = (rotY, modelId) => {
    const { w, d } = getDims(modelId);
    const is90 = Math.abs(Math.abs(rotY) - Math.PI / 2) < 0.01;
    return is90 ? { x: d, z: w } : { x: w, z: d };
  };

  const cycleOffset = (idx, map, setMap) => {
    setMap((prev) => { const cur = prev[idx] || 0; return { ...prev, [idx]: cur >= 1 ? 0 : cur + 0.5 }; });
  };

  const activeCells = Object.entries(cells).filter(([, v]) => v.active);

  const handlePlace = () => {
    if (!activeCells.length || !activeBrush) return;
    const groupId = `island_${Date.now()}`;

    // compute col widths and row depths per cell (each may have different model)
    const colWidths = {};
    for (let c = 0; c < cols; c++) {
      let maxW = 0;
      for (let r = 0; r < rows; r++) {
        const cell = cells[`${r},${c}`];
        if (cell?.active && !cell.isIntersection) { const sz = cellSize(cell.rotY, cell.modelId); maxW = Math.max(maxW, sz.x); }
      }
      colWidths[c] = maxW;
    }
    const rowDepths = {};
    for (let r = 0; r < rows; r++) {
      let maxD = 0;
      for (let c = 0; c < cols; c++) {
        const cell = cells[`${r},${c}`];
        if (cell?.active && !cell.isIntersection) { const sz = cellSize(cell.rotY, cell.modelId); maxD = Math.max(maxD, sz.z); }
      }
      rowDepths[r] = maxD;
    }
    const colX = {}; let accX = 0;
    for (let c = 0; c < cols; c++) { colX[c] = accX + colWidths[c] / 2; accX += colWidths[c]; }
    const rowZ = {}; let accZ = 0;
    for (let r = 0; r < rows; r++) { rowZ[r] = accZ + rowDepths[r] / 2; accZ += rowDepths[r]; }
    const cx = accX / 2, cz = accZ / 2;

    const newItems = activeCells.map(([key, cell], idx) => {
      const modelId = cell.modelId || activeBrushId;
      const def = palette.find((p) => p.id === modelId)?.def;
      if (!def) return null;
      const { d: mD } = getDims(modelId);
      const color = catalogColors[modelId] || def.color || "#888888";
      let wx, wz;
      if (cell.isIntersection) {
        const { ri, ci } = cell;
        const r = (ri - 1) / 2; const c2 = (ci - 1) / 2;
        const isInterRow = ri % 2 === 1; const isInterCol = ci % 2 === 1;
        if (isInterCol) {
          const x1 = colX[c2] !== undefined ? colX[c2] + (colWidths[c2]||0)/2 : 0;
          const x2 = colX[c2+1] !== undefined ? colX[c2+1] - (colWidths[c2+1]||0)/2 : x1;
          wx = (x1+x2)/2;
        } else { wx = colX[Math.floor(ci/2)] || 0; }
        if (isInterRow) {
          const z1 = rowZ[r] !== undefined ? rowZ[r] + (rowDepths[r]||0)/2 : 0;
          const z2 = rowZ[r+1] !== undefined ? rowZ[r+1] - (rowDepths[r+1]||0)/2 : z1;
          wz = (z1+z2)/2;
        } else { wz = rowZ[Math.floor(ri/2)] || 0; }
        const threeRotY = cell.rotY + Math.PI;
        wx += Math.sin(threeRotY) * (mD/2);
        wz += Math.cos(threeRotY) * (mD/2);
      } else {
        const [row, col] = key.split(",").map(Number);
        const sz = cellSize(cell.rotY, modelId);
        const xOff = (colOffsets[col]||0) * (rowDepths[row]||mD);
        const zOff = (rowOffsets[row]||0) * (colWidths[col]||sz.x);
        const snap = cell.snap ?? null;
        const cellW = colWidths[col]||sz.x; const cellD = rowDepths[row]||sz.z;
        const snapX = snap==='w'?-(cellW-sz.x)/2:snap==='e'?(cellW-sz.x)/2:0;
        const snapZ = snap==='n'?-(cellD-sz.z)/2:snap==='s'?(cellD-sz.z)/2:0;
        wx = colX[col] + xOff + snapX;
        wz = rowZ[row] + zOff + snapZ;
      }
      return {
        uid: `${modelId}_island_${Date.now()}_${idx}`,
        catalogId: modelId, kind: "model",
        x: wx - cx, z: wz - cz,
        rotY: cell.rotY + Math.PI,
        color, sockets: {}, groupIds: [groupId], pivotX: 0, pivotZ: 0,
      };
    }).filter(Boolean);

    onPlace(newItems);
  };

  const ArrowSvg = ({ rotY, size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#00e5ff" strokeWidth="2.5"
      style={{ transform: `rotate(${-(rotY*180/Math.PI)}deg)`, pointerEvents: "none" }}>
      <line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>
    </svg>
  );

  // catalog picker — grouped by category
  const categories = [...new Set(catalog.filter(c => c.category !== "Props").map(c => c.category || "Models"))];

  return (
    <div style={{ position:"fixed", inset:0, zIndex:2000, background:"rgba(0,0,0,0.8)", display:"flex", alignItems:"center", justifyContent:"center" }}
      onClick={(e) => { if (e.target===e.currentTarget) onCancel(); }}>
      <div style={{ background:"#0d1117", border:"1px solid #1e2035", borderRadius:16, padding:28, width:"min(96vw,700px)", maxHeight:"90vh", overflowY:"auto", display:"flex", flexDirection:"column", gap:18 }}>

        {/* Header */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:3, height:22, background:"#5b4bff", borderRadius:2 }}/>
            <h2 style={{ fontSize:16, fontWeight:700, color:"#e2e8f0", margin:0 }}>Island Builder</h2>
          </div>
          <button onClick={onCancel} style={{ background:"none", border:"none", color:"#64748b", fontSize:20, cursor:"pointer" }}>×</button>
        </div>

        {/* Palette */}
        <div>
          <div style={{ fontSize:10, fontWeight:700, color:"#64748b", letterSpacing:"0.07em", textTransform:"uppercase", marginBottom:8 }}>Model Palette</div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center" }}>
            {palette.map((p) => (
              <button key={p.id} onClick={() => setActiveBrushId(p.id)}
                style={{ display:"flex", alignItems:"center", gap:6, padding:"6px 10px", borderRadius:8, cursor:"pointer", border:`2px solid ${activeBrushId===p.id ? p.color : "transparent"}`, background: activeBrushId===p.id ? `${p.color}22` : "#13162a" }}>
                <div style={{ width:10, height:10, borderRadius:"50%", background:p.color, flexShrink:0 }}/>
                <span style={{ fontSize:11, fontWeight:600, color:"#e2e8f0" }}>{p.def.name}</span>
                {loadingDims[p.id] && <span style={{ fontSize:9, color:"#64748b" }}>…</span>}
                <button onClick={(e) => { e.stopPropagation(); setPalette((prev) => prev.filter((x) => x.id !== p.id)); if (activeBrushId===p.id) setActiveBrushId(palette.find(x=>x.id!==p.id)?.id||null); setCells((prev) => { const next={...prev}; Object.keys(next).forEach(k=>{ if(next[k].modelId===p.id) delete next[k]; }); return next; }); }}
                  style={{ background:"none", border:"none", color:"#475569", cursor:"pointer", fontSize:12, padding:0, marginLeft:2, lineHeight:1 }}>×</button>
              </button>
            ))}
            <button onClick={() => setShowCatalogPicker(true)}
              style={{ display:"flex", alignItems:"center", gap:4, padding:"6px 10px", borderRadius:8, cursor:"pointer", border:"1px dashed #2a3060", background:"transparent", color:"#5b4bff", fontSize:11, fontWeight:700 }}>
              + Add Model
            </button>
          </div>
          {palette.length === 0 && (
            <div style={{ fontSize:11, color:"#475569", marginTop:6 }}>Add at least one model to start painting.</div>
          )}
        </div>

        {/* Catalog picker */}
        {showCatalogPicker && (
          <div style={{ background:"#0a0c14", border:"1px solid #1e2035", borderRadius:12, padding:16, maxHeight:280, overflowY:"auto" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
              <span style={{ fontSize:11, fontWeight:700, color:"#94a3b8" }}>Select Model</span>
              <button onClick={() => setShowCatalogPicker(false)} style={{ background:"none", border:"none", color:"#64748b", cursor:"pointer", fontSize:16 }}>×</button>
            </div>
            {categories.map((cat) => {
              const catModels = catalog.filter((c) => (c.category||"Models")===cat && c.category!=="Props");
              return (
                <div key={cat} style={{ marginBottom:12 }}>
                  <div style={{ fontSize:9, fontWeight:700, color:"#475569", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:6 }}>{cat}</div>
                  <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                    {catModels.map((m) => {
                      const inPalette = palette.find((p) => p.id === m.id);
                      return (
                        <button key={m.id} onClick={() => addToPalette(m)}
                          style={{ padding:"5px 10px", borderRadius:7, fontSize:11, fontWeight:600, cursor:"pointer", border:`1px solid ${inPalette ? inPalette.color : "#1e2035"}`, background: inPalette ? `${inPalette.color}22` : "#13162a", color: inPalette ? "#e2e8f0" : "#94a3b8" }}>
                          {m.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Grid size */}
        <div style={{ display:"flex", gap:16, alignItems:"center" }}>
          <div style={{ fontSize:10, fontWeight:700, color:"#64748b", letterSpacing:"0.07em", textTransform:"uppercase" }}>Grid</div>
          {[["Cols", cols, setCols, setColOffsets], ["Rows", rows, setRows, setRowOffsets]].map(([label, val, setVal, setOff]) => (
            <div key={label} style={{ display:"flex", alignItems:"center", gap:6 }}>
              <span style={{ fontSize:11, color:"#94a3b8" }}>{label}</span>
              <button onClick={() => { setVal((v) => Math.max(1,v-1)); setCells({}); setOff({}); }} style={{ width:22, height:22, borderRadius:5, background:"#1e2035", border:"1px solid #2a2f4a", color:"#e2e8f0", cursor:"pointer", fontSize:13 }}>−</button>
              <span style={{ fontSize:13, fontWeight:600, color:"#e2e8f0", minWidth:20, textAlign:"center" }}>{val}</span>
              <button onClick={() => { setVal((v) => Math.min(8,v+1)); setCells({}); setOff({}); }} style={{ width:22, height:22, borderRadius:5, background:"#1e2035", border:"1px solid #2a2f4a", color:"#e2e8f0", cursor:"pointer", fontSize:13 }}>+</button>
            </div>
          ))}
          <button onClick={() => { setCells({}); setRowOffsets({}); setColOffsets({}); }} style={{ marginLeft:"auto", fontSize:10, color:"#f87171", background:"none", border:"none", cursor:"pointer", fontWeight:600 }}>Clear</button>
        </div>

        {/* Grid */}
        {palette.length > 0 && (
          <div style={{ alignSelf:"center", overflowX:"auto" }}>
            {/* Col offsets */}
            <div style={{ display:"flex", gap:3, marginBottom:3, marginLeft:26 }}>
              {Array.from({length:cols},(_,c) => {
                const off = colOffsets[c]||0;
                return (
                  <div key={c} style={{ width:CELL_PX, display:"flex", justifyContent:"center" }}>
                    <button onClick={() => cycleOffset(c, colOffsets, setColOffsets)}
                      style={{ fontSize:9, fontWeight:700, background:off?"#2a1f5a":"#13162a", border:`1px solid ${off?"#5b4bff":"#1e2035"}`, borderRadius:4, color:off?"#a5b4fc":"#334155", cursor:"pointer", padding:"2px 5px", minWidth:22 }}>
                      {off===0?"·":off===0.5?"½":"1"}
                    </button>
                  </div>
                );
              })}
            </div>
            <div style={{ display:"flex", gap:3 }}>
              {/* Row offsets */}
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                {Array.from({length:rows*2-1},(_,ri) => {
                  if (ri%2===1) return <div key={ri} style={{ height:14 }}/>;
                  const r = ri/2; const off = rowOffsets[r]||0;
                  return (
                    <div key={ri} style={{ height:CELL_PX, display:"flex", alignItems:"center" }}>
                      <button onClick={() => cycleOffset(r, rowOffsets, setRowOffsets)}
                        style={{ fontSize:9, fontWeight:700, background:off?"#2a1f5a":"#13162a", border:`1px solid ${off?"#5b4bff":"#1e2035"}`, borderRadius:4, color:off?"#a5b4fc":"#334155", cursor:"pointer", padding:"2px 4px", minWidth:18 }}>
                        {off===0?"·":off===0.5?"½":"1"}
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Cells + intersections */}
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                {Array.from({length:rows*2-1},(_,ri) => {
                  const isInterRow = ri%2===1;
                  const r = Math.floor(ri/2);
                  return (
                    <div key={ri} style={{ display:"flex", gap:3, alignItems:"center" }}>
                      {Array.from({length:cols*2-1},(_,ci) => {
                        const isInterCol = ci%2===1;
                        const c = Math.floor(ci/2);

                        if (isInterRow || isInterCol) {
                          const ikey = `i_${ri}_${ci}`;
                          const iactive = cells[ikey]?.active;
                          const irotY = cells[ikey]?.rotY||0;
                          const imodelId = cells[ikey]?.modelId;
                          const icolor = palette.find(p=>p.id===imodelId)?.color||"#5b4bff";
                          if (isInterRow && isInterCol) return <div key={ci} style={{ width:14, height:14 }}/>;
                          return (
                            <div key={ci} style={{ width:isInterCol?14:CELL_PX, height:isInterRow?14:CELL_PX, display:"flex", alignItems:"center", justifyContent:"center" }}>
                              <button
                                onClick={() => {
                                  if (!activeBrush) return;
                                  setCells((prev) => {
                                    const existing = prev[ikey];
                                    if (existing?.active) {
                                      const cur = existing.rotY||0;
                                      const idx = ARROW_DIRS.findIndex(d=>Math.abs(d-cur)<0.01);
                                      return {...prev,[ikey]:{...existing,rotY:ARROW_DIRS[(idx+1)%ARROW_DIRS.length]}};
                                    }
                                    return {...prev,[ikey]:{active:true,rotY:0,snap:null,isIntersection:true,ri,ci,modelId:activeBrushId}};
                                  });
                                }}
                                onContextMenu={(e)=>{e.preventDefault();setCells((prev)=>{const ex=prev[ikey];if(!ex?.active)return prev;return{...prev,[ikey]:{...ex,active:false}};});}}
                                style={{ width:14, height:14, borderRadius:"50%", padding:0, cursor:activeBrush?"pointer":"default", background:iactive?icolor:"#1e2035", border:`2px solid ${iactive?icolor:"#2a3060"}` }}>
                                {iactive && <div style={{ display:"flex", alignItems:"center", justifyContent:"center" }}><ArrowSvg rotY={irotY} size={10}/></div>}
                              </button>
                            </div>
                          );
                        }

                        // regular cell
                        const key = `${r},${c}`;
                        const cell = cells[key];
                        const active = cell?.active;
                        const rotY = cell?.rotY||0;
                        const modelId = cell?.modelId;
                        const brushColor = palette.find(p=>p.id===modelId)?.color||"#5b4bff";
                        return (
                          <div key={ci}
                            onClick={() => {
                              if (!activeBrush) return;
                              setCells((prev) => {
                                const existing = prev[key];
                                if (existing?.active) {
                                  if (existing.modelId === activeBrushId) {
                                    // same brush = rotate
                                    const cur = existing.rotY||0;
                                    const idx = ARROW_DIRS.findIndex(d=>Math.abs(d-cur)<0.01);
                                    return {...prev,[key]:{...existing,rotY:ARROW_DIRS[(idx+1)%ARROW_DIRS.length]}};
                                  } else {
                                    // different brush = repaint
                                    return {...prev,[key]:{...existing,modelId:activeBrushId}};
                                  }
                                }
                                return {...prev,[key]:{active:true,rotY:autoRotate(r,c,prev),modelId:activeBrushId,snap:null}};
                              });
                            }}
                            onContextMenu={(e)=>{e.preventDefault();setCells((prev)=>{const ex=prev[key];if(!ex?.active)return prev;return{...prev,[key]:{...ex,active:false}};});}}
                            style={{
                              width:CELL_PX, height:CELL_PX, borderRadius:8, cursor:activeBrush?"pointer":"default",
                              background:active?`${brushColor}18`:"#13162a",
                              border:`2px solid ${active?brushColor:"#1e2035"}`,
                              display:"flex", alignItems:"center", justifyContent:"center",
                              position:"relative", transition:"background 0.1s, border 0.1s", flexShrink:0,
                            }}>
                            {active && (
                              <>
                                <ArrowSvg rotY={rotY} size={22}/>
                                {[['n',{top:2,left:'50%',transform:'translateX(-50%)'}],['s',{bottom:2,left:'50%',transform:'translateX(-50%)'}],['w',{left:2,top:'50%',transform:'translateY(-50%)'}],['e',{right:2,top:'50%',transform:'translateY(-50%)'}]].map(([dir,pos])=>(
                                  <button key={dir} onClick={(e)=>{e.stopPropagation();setCells((prev)=>{const k=key;if(!prev[k])return prev;const cur=prev[k].snap;return{...prev,[k]:{...prev[k],snap:cur===dir?null:dir}};});}}
                                    style={{position:'absolute',...pos,width:8,height:8,borderRadius:'50%',padding:0,background:cell?.snap===dir?'#00e5ff':'#1e2035',border:`1px solid ${cell?.snap===dir?'#00e5ff':'#2a3060'}`,cursor:'pointer'}}/>
                                ))}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Legend */}
        {palette.length > 0 && (
          <div style={{ fontSize:10, color:"#475569", textAlign:"center" }}>
            Click = paint/rotate · Right-click = erase · Different brush on active cell = repaint · Edge dots = snap
          </div>
        )}

        {/* Preview */}
        {activeCells.length > 0 && (() => {
          const PREV_W=320, PREV_H=180, PAD=20;
          const cW={}, rD={};
          for (let c=0;c<cols;c++) { let mx=0; for(let r=0;r<rows;r++){const cell=cells[`${r},${c}`];if(cell?.active&&!cell.isIntersection){const sz=cellSize(cell.rotY,cell.modelId);mx=Math.max(mx,sz.x);}} cW[c]=mx; }
          for (let r=0;r<rows;r++) { let mx=0; for(let c=0;c<cols;c++){const cell=cells[`${r},${c}`];if(cell?.active&&!cell.isIntersection){const sz=cellSize(cell.rotY,cell.modelId);mx=Math.max(mx,sz.z);}} rD[r]=mx; }
          const cX={}; let aX=0; for(let c=0;c<cols;c++){cX[c]=aX+cW[c]/2;aX+=cW[c];}
          const rZ={}; let aZ=0; for(let r=0;r<rows;r++){rZ[r]=aZ+rD[r]/2;aZ+=rD[r];}
          const cx2=aX/2, cz2=aZ/2;
          const rects = activeCells.map(([key,cell])=>{
            const modelId=cell.modelId||activeBrushId;
            const sz=cellSize(cell.rotY,modelId);
            const color=palette.find(p=>p.id===modelId)?.color||"#5b4bff";
            let wx,wz;
            if(cell.isIntersection){
              const{ri,ci}=cell;const r2=(ri-1)/2;const c2=(ci-1)/2;
              const isIR=ri%2===1;const isIC=ci%2===1;
              if(isIC){const x1=cX[c2]!==undefined?cX[c2]+(cW[c2]||0)/2:0;const x2=cX[c2+1]!==undefined?cX[c2+1]-(cW[c2+1]||0)/2:x1;wx=(x1+x2)/2;}else{wx=cX[Math.floor(ci/2)]||0;}
              if(isIR){const z1=rZ[r2]!==undefined?rZ[r2]+(rD[r2]||0)/2:0;const z2=rZ[r2+1]!==undefined?rZ[r2+1]-(rD[r2+1]||0)/2:z1;wz=(z1+z2)/2;}else{wz=rZ[Math.floor(ri/2)]||0;}
              const{d:mD}=getDims(modelId);
              const tRY=cell.rotY+Math.PI;wx+=Math.sin(tRY)*(mD/2);wz+=Math.cos(tRY)*(mD/2);
            }else{
              const[row,col]=key.split(",").map(Number);
              const cellW2=cW[col]||sz.x;const cellD2=rD[row]||sz.z;
              const sX=cell.snap==='w'?-(cellW2-sz.x)/2:cell.snap==='e'?(cellW2-sz.x)/2:0;
              const sZ=cell.snap==='n'?-(cellD2-sz.z)/2:cell.snap==='s'?(cellD2-sz.z)/2:0;
              wx=cX[col]+sX;wz=rZ[row]+sZ;
            }
            return{x:wx-cx2,z:wz-cz2,w:sz.x,d:sz.z,rotY:cell.rotY,color};
          });
          const xs1=rects.map(r=>r.x-r.w/2),xs2=rects.map(r=>r.x+r.w/2);
          const zs1=rects.map(r=>r.z-r.d/2),zs2=rects.map(r=>r.z+r.d/2);
          const minX=Math.min(...xs1),maxX=Math.max(...xs2),minZ=Math.min(...zs1),maxZ=Math.max(...zs2);
          const spanX=(maxX-minX)||1,spanZ=(maxZ-minZ)||1;
          const scale=Math.min((PREV_W-PAD*2)/spanX,(PREV_H-PAD*2)/spanZ);
          const midX=(minX+maxX)/2,midZ=(minZ+maxZ)/2;
          const toSx=x=>PREV_W/2+(x-midX)*scale;
          const toSz=z=>PREV_H/2+(z-midZ)*scale;
          return(
            <div style={{background:"#0d0f18",border:"1px solid #1e2035",borderRadius:10,overflow:"hidden"}}>
              <div style={{fontSize:9,color:"#334155",padding:"6px 10px 0",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em"}}>Preview</div>
              <svg width={PREV_W} height={PREV_H} style={{display:"block"}}>
                <defs><clipPath id="pc"><rect x="0" y="0" width={PREV_W} height={PREV_H}/></clipPath></defs>
                <g clipPath="url(#pc)">
                  {rects.map((rect,i)=>{
                    const sx=toSx(rect.x),sz=toSz(rect.z);
                    const rw=rect.w*scale,rd=rect.d*scale;
                    const aLen=Math.min(rw,rd)*0.38;
                    const ax=-Math.sin(rect.rotY)*aLen,az=-Math.cos(rect.rotY)*aLen;
                    return(
                      <g key={i}>
                        <rect x={sx-rw/2} y={sz-rd/2} width={rw} height={rd} fill={`${rect.color}22`} stroke={rect.color} strokeWidth="1.5" rx="2"/>
                        <line x1={sx} y1={sz} x2={sx+ax} y2={sz+az} stroke={rect.color} strokeWidth="1.5" strokeLinecap="round"/>
                        <circle cx={sx+ax} cy={sz+az} r="2.5" fill={rect.color}/>
                      </g>
                    );
                  })}
                </g>
              </svg>
            </div>
          );
        })()}

        {/* Footer */}
        <div style={{display:"flex",gap:10,marginTop:4}}>
          <button onClick={onCancel} style={{flex:1,background:"#13162a",border:"1px solid #1e2035",borderRadius:10,color:"#94a3b8",padding:"11px",fontSize:13,cursor:"pointer",fontWeight:600}}>Cancel</button>
          <button onClick={handlePlace} disabled={!activeCells.length||!activeBrush}
            style={{flex:2,background:activeCells.length&&activeBrush?"linear-gradient(135deg,#5b4bff,#7c6dff)":"#1e2035",border:"none",borderRadius:10,color:activeCells.length&&activeBrush?"#fff":"#475569",padding:"11px",fontSize:13,cursor:activeCells.length&&activeBrush?"pointer":"default",fontWeight:700}}>
            Place {activeCells.length>0?`${activeCells.length} objects`:""}
          </button>
        </div>
      </div>
    </div>
  );
}

// ===================== Layout 2D Overlay =====================
function Layout2DOverlay({ mountRef, threeRef, items, walls, catalog, floorW, floorD, floorPlan, selectedUids, selectedWallUid, activeTool, setActiveTool, onMoveItems, onMoveWall, onSelectUids, onSelectWall, onAddWall, unit, UNITS, fmt, metersTo }) {
  const svgRef = React.useRef(null);
  const [size, setSize] = React.useState({ w: 800, h: 600 });
  const [wallStart, setWallStart] = React.useState(null);
  const [mouseWorld, setMouseWorld] = React.useState(null);
  const [dragging, setDragging] = React.useState(null);
  const [columnDrag, setColumnDrag] = React.useState(null);
  const [doorFirstClick, setDoorFirstClick] = React.useState(null); // { wallUid, projPt }
  const [, forceUpdate] = React.useReducer(x => x+1, 0);
  const wallSessionRef = React.useRef(null); // groupId for current wall session
  const wallLockedAngleRef = React.useRef(null); // angle locked when Shift is held
  const dragWasActiveRef = React.useRef(false); // prevent click after drag
  const activeToolRef = React.useRef(activeTool);
  React.useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
  const wallStartRef = React.useRef(wallStart);
  React.useEffect(() => { wallStartRef.current = wallStart; }, [wallStart]);
  const mouseWorldRef = React.useRef(mouseWorld);
  React.useEffect(() => { mouseWorldRef.current = mouseWorld; }, [mouseWorld]);

  // Project a world point onto a wall segment, return t in [0,1] and clamped point
  const projectOntoWall = React.useCallback((wx, wz, wall) => {
    const dx = wall.x2 - wall.x1, dz = wall.z2 - wall.z1;
    const len2 = dx * dx + dz * dz;
    if (len2 < 0.0001) return null;
    const t = Math.max(0.05, Math.min(0.95, ((wx - wall.x1) * dx + (wz - wall.z1) * dz) / len2));
    return { t, x: wall.x1 + t * dx, z: wall.z1 + t * dz };
  }, []);

  // resize observer
  React.useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
      forceUpdate();
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // re-render when camera changes (pan/zoom)
  React.useEffect(() => {
    let raf;
    const loop = () => { forceUpdate(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // world → screen: in top-down Three.js ortho, +X = right, +Z = INTO screen (down in SVG)
  const worldToScreen = React.useCallback((wx, wz) => {
    const cam = threeRef.current?.orthoCam;
    const target = threeRef.current?.target;
    if (!cam || !target) return { x: 0, y: 0 };
    const { left, right, top, bottom } = cam;
    const tw = right - left, th = top - bottom;
    const relX = wx - target.x;
    const relZ = wz - target.z;
    const nx = (relX - left) / tw;
    const ny = (relZ - bottom) / th; // Z increases downward in SVG (NOT flipped)
    return { x: nx * size.w, y: ny * size.h };
  }, [size, threeRef]);

  const screenToWorld = React.useCallback((sx, sy) => {
    const cam = threeRef.current?.orthoCam;
    const target = threeRef.current?.target;
    if (!cam || !target) return { x: 0, z: 0 };
    const { left, right, top, bottom } = cam;
    const tw = right - left, th = top - bottom;
    const nx = sx / size.w;
    const ny = sy / size.h;
    const wx = nx * tw + left + target.x;
    const wz = ny * th + bottom + target.z;
    return { x: wx, z: wz };
  }, [size, threeRef]);

  const snapWorld = (x, z, shiftKey) => {
    if (shiftKey) return { x, z };
    const snap = 0.25;
    return { x: Math.round(x / snap) * snap, z: Math.round(z / snap) * snap };
  };

  const getWorldFromEvent = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    return snapWorld(...Object.values(screenToWorld(sx, sy)), e.shiftKey);
  };

  // keyboard shortcuts
  React.useEffect(() => {
    const onKey = (e) => {
      if (!['INPUT','TEXTAREA'].includes(e.target.tagName)) {
        if (e.key === 'v' || e.key === 'V') setActiveTool('select');
        if (e.key === 'w' || e.key === 'W') setActiveTool('wall');
        if (e.key === 'c' || e.key === 'C') setActiveTool('column');
        if (e.key === 'd' || e.key === 'D') setActiveTool('door');
        if (e.key === 'Escape') { setWallStart(null); wallSessionRef.current = null; wallLockedAngleRef.current = null; setDoorFirstClick(null); setActiveTool('select'); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const draggingRef = React.useRef(null);
  draggingRef.current = dragging;
  const mouseDownPosRef = React.useRef(null); // track mousedown position for drag threshold

  React.useEffect(() => {
    const onMove = (e) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const raw = screenToWorld(sx, sy);
      let w = snapWorld(raw.x, raw.z, e.shiftKey);

      // Wall tool angle snap + lock: use refs to avoid stale closure
      if (activeToolRef.current === 'wall' && wallStartRef.current) {
        const ws = wallStartRef.current;
        const SNAP_STEP = Math.PI / 4;
        if (e.altKey) {
          // Alt = totally free, no angle snap, no position snap
          wallLockedAngleRef.current = null;
          w = { x: raw.x, z: raw.z };
        } else if (e.shiftKey) {
          if (wallLockedAngleRef.current === null) {
            const cur = mouseWorldRef.current ?? raw;
            const dx = cur.x - ws.x, dz = cur.z - ws.z;
            const curLen = Math.hypot(dx, dz);
            if (curLen > 0.001) {
              wallLockedAngleRef.current = Math.round(Math.atan2(dx, dz) / SNAP_STEP) * SNAP_STEP;
            } else {
              wallLockedAngleRef.current = 0;
            }
          }
          const a = wallLockedAngleRef.current;
          const dx = raw.x - ws.x, dz = raw.z - ws.z;
          const len = Math.max(0.01, dx * Math.sin(a) + dz * Math.cos(a));
          w = { x: ws.x + Math.sin(a) * len, z: ws.z + Math.cos(a) * len };
        } else {
          wallLockedAngleRef.current = null;
          const dx = raw.x - ws.x, dz = raw.z - ws.z;
          const len = Math.hypot(dx, dz);
          if (len > 0.001) {
            const a = Math.atan2(dx, dz);
            const snapped = Math.round(a / SNAP_STEP) * SNAP_STEP;
            const snappedLen = Math.max(0.01, dx * Math.sin(snapped) + dz * Math.cos(snapped));
            w = snapWorld(ws.x + Math.sin(snapped) * snappedLen, ws.z + Math.cos(snapped) * snappedLen, false);
          }
        }
      }
      setMouseWorld(w);
      if (columnDrag) setColumnDrag((prev) => prev ? { ...prev, end: w } : null);
      const drag = draggingRef.current;
      if (!drag) return;
      const dx = w.x - drag.startWorld.x;
      const dz = w.z - drag.startWorld.z;
      if (drag.type === 'items') {
        const patches = {};
        Object.entries(drag.startPositions).forEach(([uid, pos]) => { patches[uid] = { x: pos.x+dx, z: pos.z+dz }; });
        onMoveItems(patches);
      } else if (drag.type === 'endpoints') {
        drag.epPatches.forEach(ep => {
          if (ep.ep === 'start') onMoveWall(ep.uid, { x1: ep.x1+dx, z1: ep.z1+dz, x2: ep.x2, z2: ep.z2 });
          else onMoveWall(ep.uid, { x1: ep.x1, z1: ep.z1, x2: ep.x2+dx, z2: ep.z2+dz });
        });
      } else if (drag.type === 'wallGroup') {
        drag.groupWalls.forEach(gw => {
          const pos = drag.startPositions[gw.uid];
          if (pos) onMoveWall(gw.uid, { x1: pos.x1+dx, z1: pos.z1+dz, x2: pos.x2+dx, z2: pos.z2+dz });
        });
      } else if (drag.type === 'wall') {
        const pos = drag.startPositions;
        if (pos.isColumn) { onMoveWall(drag.uid, { x: pos.x+dx, z: pos.z+dz }); }
        else { onMoveWall(drag.uid, { x1: pos.x1+dx, z1: pos.z1+dz, x2: pos.x2+dx, z2: pos.z2+dz }); }
      }
    };
    const onUp = (e) => {
      if (draggingRef.current) {
        // Only suppress click if mouse actually moved (>4px threshold)
        const down = mouseDownPosRef.current;
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) {
          dragWasActiveRef.current = true;
        }
        setDragging(null);
      }
      if (columnDrag) {
        const rect = svgRef.current?.getBoundingClientRect();
        if (rect) {
          const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
          const w = screenToWorld(sx, sy);
          const cw = Math.abs(w.x - columnDrag.start.x), cd = Math.abs(w.z - columnDrag.start.z);
          if (cw > 0.05 || cd > 0.05) {
            dragWasActiveRef.current = true; // prevent onClick from firing
            onAddWall({ uid: `col_${Date.now()}`, type: 'column', x: (columnDrag.start.x+w.x)/2, z: (columnDrag.start.z+w.z)/2, width: Math.max(0.1,cw), depth: Math.max(0.1,cd), height: 2.8, color: "#888888" });
          }
        }
        setColumnDrag(null);
      }
    };
    const onMouseDown = (e) => { mouseDownPosRef.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousedown', onMouseDown); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [dragging, columnDrag, screenToWorld, onMoveItems, onMoveWall, onAddWall]);

  const handleMouseMove = (_e) => {
    // mouseWorld is set by the onMove listener which includes angle snap
  };

  const handleSvgClick = (e) => {
    if (dragWasActiveRef.current) { dragWasActiveRef.current = false; return; }
    // Use mouseWorld which already has angle+position snap applied
    const w = mouseWorld || getWorldFromEvent(e);
    if (activeTool === 'wall') {
      if (!wallStart) {
        wallSessionRef.current = `wallgroup_${Date.now()}`;
        setWallStart(w);
      } else {
        const wallConfig = { height: 2.4, thickness: 0.1, glassRatio: 0, color: "#ffffff" };
        onAddWall({ uid: `wall_${Date.now()}`, x1: wallStart.x, z1: wallStart.z, x2: w.x, z2: w.z, groupId: wallSessionRef.current, ...wallConfig });
        setWallStart(w);
        wallLockedAngleRef.current = null;
      }
    } else if (activeTool === 'door') {
      const plainWalls = walls.filter(wl => !wl.type || wl.type === 'wall');
      if (!doorFirstClick) {
        // First click: find closest wall and project
        let bestWall = null, bestDist = 1.2, bestProj = null;
        plainWalls.forEach(wl => {
          const proj = projectOntoWall(w.x, w.z, wl);
          if (!proj) return;
          const dist = Math.hypot(w.x - proj.x, w.z - proj.z);
          if (dist < bestDist) { bestDist = dist; bestWall = wl; bestProj = proj; }
        });
        if (bestWall && bestProj) {
          setDoorFirstClick({ wallUid: bestWall.uid, projPt: bestProj, t: bestProj.t });
          onSelectWall(bestWall.uid);
        }
      } else {
        // Second click: defines door span on the same wall
        const srcWall = walls.find(wl => wl.uid === doorFirstClick.wallUid);
        if (!srcWall) { setDoorFirstClick(null); return; }
        const proj2 = projectOntoWall(w.x, w.z, srcWall);
        if (!proj2) { setDoorFirstClick(null); return; }
        const t1 = Math.min(doorFirstClick.t, proj2.t);
        const t2 = Math.max(doorFirstClick.t, proj2.t);
        const wdx = srcWall.x2 - srcWall.x1, wdz = srcWall.z2 - srcWall.z1;
        const totalLen = Math.hypot(wdx, wdz);
        const doorW = (t2 - t1) * totalLen;
        if (doorW < 0.1) { setDoorFirstClick(null); return; }
        const gid = srcWall.groupId || `wallgroup_${Date.now()}`;
        const baseProps = { height: srcWall.height || 2.4, thickness: srcWall.thickness || 0.1, glassRatio: 0, color: srcWall.color || "#ffffff", groupId: gid };
        const ts = Date.now();
        const segA = { uid: `wall_${ts}_a`, x1: srcWall.x1, z1: srcWall.z1, x2: srcWall.x1 + wdx * t1, z2: srcWall.z1 + wdz * t1, ...baseProps, noMiterEnd: true };
        const doorSeg = { uid: `wall_${ts}_d`, type: 'door', x1: srcWall.x1 + wdx * t1, z1: srcWall.z1 + wdz * t1, x2: srcWall.x1 + wdx * t2, z2: srcWall.z1 + wdz * t2, width: doorW, height: Math.min(2.1, (srcWall.height || 2.4) - 0.1), wallHeight: srcWall.height || 2.4, wallColor: srcWall.color || "#cccccc", thickness: srcWall.thickness || 0.1, openAngle: 45, color: "#a07840", groupId: gid };
        const segC = { uid: `wall_${ts}_c`, x1: srcWall.x1 + wdx * t2, z1: srcWall.z1 + wdz * t2, x2: srcWall.x2, z2: srcWall.z2, ...baseProps, noMiterStart: true };
        const segALen = Math.hypot(segA.x2 - segA.x1, segA.z2 - segA.z1);
        const segCLen = Math.hypot(segC.x2 - segC.x1, segC.z2 - segC.z1);
        // Remove original and add segments
        onAddWall({ uid: `__remove__${srcWall.uid}`, __removeUid: srcWall.uid });
        if (segALen > 0.05) onAddWall(segA);
        onAddWall(doorSeg);
        if (segCLen > 0.05) onAddWall(segC);
        onSelectWall(doorSeg.uid);
        setDoorFirstClick(null);
        setActiveTool('select');
      }
    } else if (activeTool === 'select') {
      onSelectUids([]);
      onSelectWall(null);
    }
  };

  const cursorStyle = {
    select: 'default',
    wall: 'crosshair',
    column: 'crosshair',
    door: 'crosshair',
    model: 'copy',
  }[activeTool] || 'default';

  const isDrawingTool = activeTool === 'wall' || activeTool === 'column' || activeTool === 'door';

  // scale factor: pixels per meter
  const cam = threeRef.current?.orthoCam;
  const pxPerMeter = cam ? size.w / (cam.right - cam.left) : 50;

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 10, pointerEvents: 'none' }}>
      {/* Toolbar — always interactive */}
      <div style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', display: 'flex', flexDirection: 'column', gap: 4, background: 'rgba(13,17,23,0.92)', border: '1px solid #1e2035', borderRadius: 12, padding: 6, backdropFilter: 'blur(8px)', zIndex: 20, pointerEvents: 'all' }}>
        {[
          ['select', 'V', <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 3l14 9-7 1-4 7z"/></svg>],
          ['wall', 'W', <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>],
          ['column', 'C', <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="8" y="3" width="8" height="18" rx="1"/></svg>],
          ['door', 'D', <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="2" width="13" height="20" rx="1"/><path d="M16 12h2m2 0h-2m0-3v6" strokeLinecap="round"/><circle cx="13.5" cy="12" r="1" fill="currentColor" stroke="none"/></svg>],
        ].map(([tool, key, icon]) => (
          <button key={tool} onClick={() => { setActiveTool(tool); if (tool !== 'wall') setWallStart(null); setColumnDrag(null); }}
            title={`${tool.charAt(0).toUpperCase()+tool.slice(1)} (${key})`}
            style={{ width: 36, height: 36, borderRadius: 8, border: `1px solid ${activeTool===tool?'#00e5ff':'transparent'}`, background: activeTool===tool?'rgba(0,229,255,0.15)':'transparent', color: activeTool===tool?'#00e5ff':'#64748b', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
            {icon}
            <span style={{ position: 'absolute', bottom: 2, right: 3, fontSize: 7, opacity: 0.5, fontWeight: 700 }}>{key}</span>
          </button>
        ))}
      </div>

      {/* SVG — background transparent to pointer events unless drawing */}
      <svg ref={svgRef} width={size.w} height={size.h}
        style={{ position: 'absolute', inset: 0, cursor: cursorStyle, pointerEvents: 'none' }}
        onMouseMove={handleMouseMove}>

        {/* Invisible hit area — only active when drawing */}
        {isDrawingTool && (
          <rect x={0} y={0} width={size.w} height={size.h} fill="transparent"
            style={{ pointerEvents: 'all', cursor: cursorStyle }}
            onMouseDown={(e) => {
              if (activeTool === 'column') {
                const w = getWorldFromEvent(e);
                setColumnDrag({ start: w, end: w });
              }
            }}
            onClick={handleSvgClick}
            onContextMenu={(e) => { e.preventDefault(); setWallStart(null); setColumnDrag(null); }}
          />
        )}

        {/* Door preview (first click placed, hovering second point) */}
        {activeTool === 'door' && doorFirstClick && mouseWorld && (() => {
          const srcWall = walls.find(wl => wl.uid === doorFirstClick.wallUid);
          if (!srcWall) return null;
          const proj2 = projectOntoWall(mouseWorld.x, mouseWorld.z, srcWall);
          if (!proj2) return null;
          const t1 = Math.min(doorFirstClick.t, proj2.t);
          const t2 = Math.max(doorFirstClick.t, proj2.t);
          const wdx = srcWall.x2 - srcWall.x1, wdz = srcWall.z2 - srcWall.z1;
          const pp1 = worldToScreen(srcWall.x1 + wdx * t1, srcWall.z1 + wdz * t1);
          const pp2 = worldToScreen(srcWall.x1 + wdx * t2, srcWall.z1 + wdz * t2);
          const p1dot = worldToScreen(doorFirstClick.projPt.x, doorFirstClick.projPt.z);
          return (
            <g>
              <line x1={pp1.x} y1={pp1.y} x2={pp2.x} y2={pp2.y} stroke="#f59e0b" strokeWidth={4} strokeLinecap="round" opacity={0.9}/>
              <circle cx={p1dot.x} cy={p1dot.y} r={5} fill="#f59e0b" stroke="#0d0f18" strokeWidth={1.5}/>
              <circle cx={pp2.x} cy={pp2.y} r={5} fill="#f59e0b" stroke="#0d0f18" strokeWidth={1.5} strokeDasharray="3,2" opacity={0.7}/>
            </g>
          );
        })()}

        {/* Door preview first click marker */}
        {activeTool === 'door' && !doorFirstClick && mouseWorld && (() => {
          const plainWalls = walls.filter(wl => !wl.type || wl.type === 'wall');
          let bestProj = null, bestDist = 1.2;
          plainWalls.forEach(wl => {
            const proj = projectOntoWall(mouseWorld.x, mouseWorld.z, wl);
            if (!proj) return;
            const dist = Math.hypot(mouseWorld.x - proj.x, mouseWorld.z - proj.z);
            if (dist < bestDist) { bestDist = dist; bestProj = { x: proj.x, z: proj.z }; }
          });
          if (!bestProj) return null;
          const ps = worldToScreen(bestProj.x, bestProj.z);
          return <circle cx={ps.x} cy={ps.y} r={6} fill="none" stroke="#f59e0b" strokeWidth={2} opacity={0.8}/>;
        })()}

        {/* Walls */}
        {walls.filter(w => w.type !== 'column').map((wall) => {
          const p1 = worldToScreen(wall.x1, wall.z1);
          const p2 = worldToScreen(wall.x2, wall.z2);
          const selectedWall = walls.find(w => w.uid === selectedWallUid);
          const isSelected = wall.uid === selectedWallUid || (selectedWall?.groupId && wall.groupId === selectedWall.groupId);
          return (
            <g key={wall.uid} style={{ pointerEvents: 'all' }}
              onMouseDown={(e) => {
                if (activeTool === 'door') return; // let click bubble to hit rect
                e.stopPropagation();
                if (activeTool === 'select') {
                  const groupId = wall.groupId;
                  const groupWalls = groupId ? walls.filter(w => w.groupId === groupId) : [wall];
                  onSelectWall(wall.uid);
                  const ww = getWorldFromEvent(e);
                  const startPositions = {};
                  groupWalls.forEach(gw => { startPositions[gw.uid] = { x1: gw.x1, z1: gw.z1, x2: gw.x2, z2: gw.z2 }; });
                  setDragging({ type: 'wallGroup', groupWalls, startWorld: ww, startPositions });
                }
              }}
              onClick={(e) => {
                if (activeTool === 'door') { e.stopPropagation(); handleSvgClick(e); }
              }}>
              <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="transparent" strokeWidth={12} style={{ cursor: 'pointer' }} />
              <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                stroke={isSelected ? '#00e5ff' : wall.type === 'door' ? '#f59e0b' : '#e2e8f0'}
                strokeWidth={isSelected ? 3 : 2} strokeLinecap="round"
                strokeDasharray={wall.type === 'door' ? '6,3' : undefined}/>
              {isSelected && <>
                {[{x: p1.x, y: p1.y, ep: 'start'}, {x: p2.x, y: p2.y, ep: 'end'}].map(({x, y, ep}) => (
                  <circle key={ep} cx={x} cy={y} r={6} fill="#00e5ff" stroke="#0d0f18" strokeWidth={1.5}
                    style={{ cursor: 'grab', pointerEvents: 'all' }}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      const pt = ep === 'start' ? {x: wall.x1, z: wall.z1} : {x: wall.x2, z: wall.z2};
                      const snapDist = (wall.thickness || 0.1) * 2;
                      // find all walls that share this endpoint
                      const connected = walls.filter(w => w.uid !== wall.uid && w.type !== 'column' && (
                        Math.hypot(w.x1-pt.x, w.z1-pt.z) < snapDist ||
                        Math.hypot(w.x2-pt.x, w.z2-pt.z) < snapDist
                      ));
                      const ww = getWorldFromEvent(e);
                      // build endpoint patch info for each affected wall
                      const epPatches = [{ uid: wall.uid, ep, x1: wall.x1, z1: wall.z1, x2: wall.x2, z2: wall.z2 }];
                      connected.forEach(cw => {
                        const isStart = Math.hypot(cw.x1-pt.x, cw.z1-pt.z) < snapDist;
                        epPatches.push({ uid: cw.uid, ep: isStart ? 'start' : 'end', x1: cw.x1, z1: cw.z1, x2: cw.x2, z2: cw.z2 });
                      });
                      setDragging({ type: 'endpoints', startWorld: ww, epPatches });
                    }}/>
                ))}
              </>}
            </g>
          );
        })}

        {/* Columns */}
        {walls.filter(w => w.type === 'column').map((col) => {
          const p = worldToScreen(col.x, col.z);
          const hw = (col.width || 0.3) * pxPerMeter / 2;
          const hd = (col.depth || 0.3) * pxPerMeter / 2;
          const isSelected = col.uid === selectedWallUid;
          return (
            <g key={col.uid} style={{ pointerEvents: 'all' }} onMouseDown={(e) => {
              e.stopPropagation();
              if (activeTool === 'select') {
                onSelectWall(col.uid);
                const w = getWorldFromEvent(e);
                setDragging({ type: 'wall', uid: col.uid, startWorld: w, startPositions: { isColumn: true, x: col.x, z: col.z } });
              }
            }}>
              <rect x={p.x-hw} y={p.y-hd} width={hw*2} height={hd*2}
                fill={isSelected?'rgba(0,229,255,0.2)':'rgba(100,116,139,0.3)'}
                stroke={isSelected?'#00e5ff':'#94a3b8'} strokeWidth={isSelected?2:1.5} style={{ cursor: 'pointer' }}/>
            </g>
          );
        })}

        {/* Items */}
        {items.map((it) => {
          const def = catalog.find(c => c.id === it.catalogId);
          if (!def) return null;
          const w = (def.w || 1) * pxPerMeter;
          const d = (def.d || 1) * pxPerMeter;
          const p = worldToScreen(it.x, it.z);
          const isSelected = selectedUids.includes(it.uid);
          const angle = it.rotY * 180 / Math.PI; // corrected: no negation
          return (
            <g key={it.uid} transform={`rotate(${angle},${p.x},${p.y})`}
              onMouseDown={(e) => {
                e.stopPropagation();
                if (activeTool === 'select') {
                  const newSel = e.shiftKey ? (selectedUids.includes(it.uid) ? selectedUids.filter(u=>u!==it.uid) : [...selectedUids, it.uid]) : [it.uid];
                  onSelectUids(newSel);
                  const ww = getWorldFromEvent(e);
                  const startPos = {};
                  newSel.forEach(uid => { const item = items.find(i=>i.uid===uid); if (item) startPos[uid]={x:item.x,z:item.z}; });
                  setDragging({ type:'items', startWorld:ww, startPositions:startPos });
                }
              }}>
              <rect x={p.x-w/2} y={p.y-d/2} width={w} height={d}
                fill={isSelected?`${it.color||'#5b4bff'}44`:`${it.color||'#5b4bff'}22`}
                stroke={isSelected?'#00e5ff':it.color||'#5b4bff'}
                strokeWidth={isSelected?2:1.5} rx={3} style={{ cursor: activeTool==='select'?'grab':'default' }}/>
              <line x1={p.x} y1={p.y} x2={p.x} y2={p.y-d*0.35} stroke={isSelected?'#00e5ff':'rgba(255,255,255,0.4)'} strokeWidth={1.5} strokeLinecap="round"/>
              <circle cx={p.x} cy={p.y-d*0.35} r={2.5} fill={isSelected?'#00e5ff':'rgba(255,255,255,0.4)'}/>
              {w > 40 && <text x={p.x} y={p.y+4} textAnchor="middle" fontSize={Math.min(11,w/6)} fill="rgba(255,255,255,0.7)" fontWeight="600" style={{pointerEvents:'none'}}>{def.name}</text>}
            </g>
          );
        })}

        {/* Wall preview while drawing */}
        {activeTool === 'wall' && wallStart && mouseWorld && (() => {
          const p1 = worldToScreen(wallStart.x, wallStart.z);
          const p2 = worldToScreen(mouseWorld.x, mouseWorld.z);
          const len = Math.hypot(mouseWorld.x-wallStart.x, mouseWorld.z-wallStart.z);
          return (
            <>
              <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="#00e5ff" strokeWidth={2} strokeDasharray="6 3" strokeLinecap="round"/>
              <circle cx={p1.x} cy={p1.y} r={5} fill="#00e5ff" stroke="#0d0f18" strokeWidth={1.5}/>
              <circle cx={p2.x} cy={p2.y} r={4} fill="#00e5ff" opacity={0.6}/>
              <text x={(p1.x+p2.x)/2} y={(p1.y+p2.y)/2-8} textAnchor="middle" fontSize={11} fill="#00e5ff" fontWeight="700">
                {fmt(metersTo(len, unit))}{UNITS[unit].label}
              </text>
            </>
          );
        })()}

        {/* Column drag preview */}
        {activeTool === 'column' && columnDrag && (() => {
          const p1 = worldToScreen(columnDrag.start.x, columnDrag.start.z);
          const p2 = worldToScreen(columnDrag.end.x, columnDrag.end.z);
          const x = Math.min(p1.x,p2.x), y = Math.min(p1.y,p2.y);
          const w = Math.abs(p2.x-p1.x), h = Math.abs(p2.y-p1.y);
          return <rect x={x} y={y} width={w} height={h} fill="rgba(0,229,255,0.1)" stroke="#00e5ff" strokeWidth={2} strokeDasharray="5 3" style={{pointerEvents:'none'}}/>;
        })()}

        {/* Cursor dot */}
        {(activeTool === 'wall' || (activeTool === 'column' && !columnDrag)) && mouseWorld && (() => {
          const p = worldToScreen(mouseWorld.x, mouseWorld.z);
          return <circle cx={p.x} cy={p.y} r={4} fill="#00e5ff" opacity={0.7} style={{pointerEvents:'none'}}/>;
        })()}
      </svg>

      {/* Tool hint */}
      <div style={{ position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)', background: 'rgba(13,17,23,0.85)', border: '1px solid #1e2035', borderRadius: 8, padding: '5px 12px', fontSize: 10, color: '#64748b', backdropFilter: 'blur(8px)', pointerEvents: 'none' }}>
        {activeTool === 'wall' && !wallStart && 'Click to start wall'}
        {activeTool === 'wall' && wallStart && 'Click to place · Right-click or Esc to stop'}
        {activeTool === 'select' && 'Click to select · Drag to move · Shift+click = multi-select'}
        {activeTool === 'column' && 'Click to place column'}
      </div>
    </div>
  );
}

function FloorPlanModal({ modal, onConfirmCalibrate, onConfirmOutline, onConfirmDimensions, onCancel, unit, UNITS, toMeters, fmt, metersTo }) {
  const canvasRef = React.useRef(null);
  const [localUnit, setLocalUnit] = React.useState(unit);
  const [zoom, setZoom] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const [points, setPoints] = React.useState([]); // calibration points [{x,y}] in image coords
  const [outlinePoints, setOutlinePoints] = React.useState([]);
  const [rectDrag, setRectDrag] = React.useState(null); // { start: {x,y}, end: {x,y} } for outline rect drag
  const [distance, setDistance] = React.useState("3");
  const [img, setImg] = React.useState(null);
  const isPanning = React.useRef(false);
  const lastPan = React.useRef({ x: 0, y: 0 });

  React.useEffect(() => {
    if (!modal?.dataUrl) return;
    const image = new Image();
    image.onload = () => {
      setImg(image);
      const iW = image.naturalWidth, iH = image.naturalHeight;
      const scaleToFit = Math.min(iW / iW, iH / iH) * 0.9; // start at 90% zoom
      setZoom(0.9);
      setPan({ x: iW * 0.05, y: iH * 0.05 });
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
    // marker size fixed at ~10 screen pixels regardless of image resolution or zoom
    const canvas = el;
    const rect = canvas.getBoundingClientRect();
    const screenToCanvas = canvas.width / rect.width; // image pixels per screen pixel
    const markerR = 10 * screenToCanvas / zoom;
    const lineW = 2 * screenToCanvas / zoom;
    const pts = modal.step === 'calibrate' ? points : outlinePoints;
    ctx.strokeStyle = "#00e5ff"; ctx.fillStyle = "#00e5ff"; ctx.lineWidth = lineW;
    pts.forEach((p, i) => {
      ctx.beginPath(); ctx.arc(p.x, p.y, markerR, 0, Math.PI * 2); ctx.fill();
      // white border around dot for visibility on any background
      ctx.strokeStyle = "#fff"; ctx.lineWidth = lineW * 0.8;
      ctx.beginPath(); ctx.arc(p.x, p.y, markerR, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = "#00e5ff"; ctx.lineWidth = lineW;
      if (i > 0) { ctx.beginPath(); ctx.moveTo(pts[i-1].x, pts[i-1].y); ctx.lineTo(p.x, p.y); ctx.stroke(); }
    });
    if (modal.step === 'calibrate' && points.length === 2) {
      ctx.fillStyle = "#fff"; ctx.font = `bold ${16/zoom}px sans-serif`;
      ctx.fillText(`${distance} ${UNITS[unit].label}`, (points[0].x + points[1].x)/2, (points[0].y + points[1].y)/2 - markerR * 1.5);
    }
    if (modal.step === 'outline' && outlinePoints.length > 2) {
      ctx.strokeStyle = "#c4622d"; ctx.lineWidth = lineW;
      ctx.beginPath();
      ctx.moveTo(outlinePoints[0].x, outlinePoints[0].y);
      outlinePoints.forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.closePath(); ctx.stroke();
      ctx.fillStyle = "rgba(196,98,45,0.15)"; ctx.fill();
    }
    // Rect drag preview
    if (modal.step === 'outline' && rectDrag) {
      const { start, end } = rectDrag;
      const x = Math.min(start.x, end.x), y = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x), h = Math.abs(end.y - start.y);
      ctx.strokeStyle = "#00e5ff"; ctx.lineWidth = lineW;
      ctx.setLineDash([8 / zoom, 4 / zoom]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(0,229,255,0.08)";
      ctx.fillRect(x, y, w, h);
      // corner dots
      [[x,y],[x+w,y],[x+w,y+h],[x,y+h]].forEach(([cx2,cy2]) => {
        ctx.fillStyle = "#00e5ff";
        ctx.beginPath(); ctx.arc(cx2, cy2, markerR, 0, Math.PI*2); ctx.fill();
      });
    }
    ctx.restore();
  }, [img, zoom, pan, points, outlinePoints, modal.step, distance, unit, rectDrag]);

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
    }
    // outline step handled by mousedown/mousemove/mouseup
  };

  const handleMouseDown = (e) => {
    if (e.button === 1 || e.button === 2) { isPanning.current = true; lastPan.current = { x: e.clientX, y: e.clientY }; return; }
    if (e.button === 0 && modal.step === 'outline') {
      const pt = getCanvasPoint(e);
      setRectDrag({ start: pt, end: pt });
      setOutlinePoints([]); // reset previous
    }
  };

  const handleMouseMove = (e) => {
    if (isPanning.current) {
      const dx = e.clientX - lastPan.current.x, dy = e.clientY - lastPan.current.y;
      lastPan.current = { x: e.clientX, y: e.clientY };
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
      return;
    }
    if (rectDrag) {
      const pt = getCanvasPoint(e);
      setRectDrag((prev) => prev ? { ...prev, end: pt } : null);
    }
  };

  const handleMouseUp = (e) => {
    isPanning.current = false;
    if (rectDrag && modal.step === 'outline') {
      const { start, end } = rectDrag;
      if (Math.hypot(end.x - start.x, end.y - start.y) > 5) {
        // Build 4 corners clockwise from top-left
        const x1 = Math.min(start.x, end.x), y1 = Math.min(start.y, end.y);
        const x2 = Math.max(start.x, end.x), y2 = Math.max(start.y, end.y);
        setOutlinePoints([{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }]);
      }
      setRectDrag(null);
    }
  };

  const handleWheel = (e) => {
    e.preventDefault();
    const normY = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const normX = e.deltaMode === 1 ? e.deltaX * 20 : e.deltaMode === 2 ? e.deltaX * 400 : e.deltaX;
    // dos dedos con componente horizontal = pan
    if (Math.abs(normX) > Math.abs(normY) * 0.3 && !e.ctrlKey) {
      setPan((p) => ({ x: p.x - normX * 0.5, y: p.y - normY * 0.5 }));
      return;
    }
    // zoom toward cursor
    const factor = normY > 0 ? 0.92 : 1.09;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;
    setZoom((z) => {
      const newZ = Math.min(Math.max(z * factor, 0.1), 10);
      setPan((p) => ({
        x: mouseX - (mouseX - p.x) * (newZ / z),
        y: mouseY - (mouseY - p.y) * (newZ / z),
      }));
      return newZ;
    });
  };


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
  const H = img ? img.naturalHeight : 500;
  // fit canvas visually to container while keeping exact pixel ratio
  const MAX_W = 860, MAX_H = 520;
  const scale = Math.min(MAX_W / W, MAX_H / H);
  const displayW = Math.round(W * scale);
  const displayH = Math.round(H * scale);

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
            : "Click and drag to draw the floor rectangle. Scroll to zoom, middle-click to pan."}
        </p>

        {/* Canvas */}
        <div style={{ overflow: "hidden", border: "1px solid #33363d", borderRadius: 8, cursor: modal.step === 'outline' ? "crosshair" : "crosshair", position: "relative", alignSelf: "center" }}
          onWheel={handleWheel}
          onMouseDown={(e) => {
            if (modal.step === 'calibrate') { handleCanvasClick(e); }
            handleMouseDown(e);
          }}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          <canvas ref={canvasRef} width={W} height={H} style={{ width: displayW, height: displayH, display: "block" }} />
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
            <span style={{ fontSize: 12, color: outlinePoints.length === 4 ? "#4ade80" : "#999" }}>
              {outlinePoints.length === 4 ? "✓ Rectangle ready" : "Drag to draw rectangle"}
            </span>
            <button onClick={() => setOutlinePoints([])} style={{ background: "#33363d", border: "none", color: "#fff", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>Reset</button>
            <button onClick={() => onConfirmOutline(null)} style={{ background: "#33363d", border: "none", color: "#fff", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>Skip (use image size)</button>
            <div style={{ flex: 1 }} />
            <button
              onClick={handleConfirmOutline}
              disabled={!canConfirmOutline}
              style={{ background: canConfirmOutline ? "#2d6a4f" : "#33363d", border: "none", color: "#fff", borderRadius: 6, padding: "8px 20px", cursor: canConfirmOutline ? "pointer" : "default", fontSize: 13, fontWeight: 600 }}
            >
              Confirm ✓
            </button>
          </div>
        )}
        {modal.step === 'confirm' && <ConfirmDimensionsStep modal={modal} onConfirm={onConfirmDimensions} unit={unit} UNITS={UNITS} fmt={fmt} metersTo={metersTo} toMeters={toMeters} />}
      </div>
    </div>
  );
}

function ConfirmDimensionsStep({ modal, onConfirm, unit, UNITS, fmt, metersTo, toMeters }) {
  const [w, setW] = React.useState(modal.calcW);
  const [d, setD] = React.useState(modal.calcD);
  const [localUnit, setLocalUnit] = React.useState(unit);
  const [zoom, setZoom] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const isPanning = React.useRef(false);
  const lastPan = React.useRef({ x: 0, y: 0 });
  const imgRef = React.useRef(null);
  const containerRef = React.useRef(null);
  const unitLabel = UNITS[localUnit]?.label || "m";

  // fit image on load
  React.useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const cw = 496, ch = 280;
      const scale = Math.min(cw / img.naturalWidth, ch / img.naturalHeight) * 0.9;
      setZoom(scale);
      setPan({ x: (cw - img.naturalWidth * scale) / 2, y: (ch - img.naturalHeight * scale) / 2 });
    };
    img.src = modal.dataUrl;
  }, [modal.dataUrl]);

  const handleWheel = (e) => {
    e.preventDefault();
    const normY = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const normX = e.deltaMode === 1 ? e.deltaX * 20 : e.deltaMode === 2 ? e.deltaX * 400 : e.deltaX;
    if (Math.abs(normX) > Math.abs(normY) * 0.3 && !e.ctrlKey) {
      setPan((p) => ({ x: p.x - normX * 0.5, y: p.y - normY * 0.5 }));
      return;
    }
    const factor = normY > 0 ? 0.92 : 1.09;
    setZoom((z) => Math.min(Math.max(z * factor, 0.1), 10));
  };

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  const handleMouseDown = (e) => { isPanning.current = true; lastPan.current = { x: e.clientX, y: e.clientY }; };
  const handleMouseMove = (e) => {
    if (!isPanning.current) return;
    const dx = e.clientX - lastPan.current.x, dy = e.clientY - lastPan.current.y;
    lastPan.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  };
  const handleMouseUp = () => { isPanning.current = false; };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 3000, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#13162a", border: "1px solid #1e2035", borderRadius: 16, padding: 28, width: 560, maxWidth: "90vw" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <div style={{ width: 3, height: 24, background: "#5b4bff", borderRadius: 2 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#e2e8f0" }}>Confirm floor size</div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>Check the plan for dimensions and adjust if needed</div>
          </div>
          {/* Unit selector */}
          <div style={{ display: "flex", gap: 4 }}>
            {Object.keys(UNITS).map((u) => (
              <button key={u} onClick={() => setLocalUnit(u)} style={{
                padding: "4px 10px", fontSize: 11, fontWeight: 600, borderRadius: 6,
                border: `1px solid ${localUnit === u ? "#5b4bff" : "#1e2035"}`,
                background: localUnit === u ? "#5b4bff" : "#0d0f18",
                color: localUnit === u ? "#fff" : "#64748b", cursor: "pointer",
              }}>{UNITS[u].label}</button>
            ))}
          </div>
        </div>

        {/* Floor plan image with zoom/pan */}
        <div ref={containerRef}
          onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}
          style={{ background: "#0d0f18", border: "1px solid #1e2035", borderRadius: 10, overflow: "hidden", marginBottom: 16, height: 280, position: "relative", cursor: "grab" }}>
          <div style={{ position: "absolute", top: 0, left: 0, transformOrigin: "0 0", transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
            <img ref={imgRef} src={modal.dataUrl} alt="Floor plan" style={{ display: "block", maxWidth: "none" }} />
          </div>
          <div style={{ position: "absolute", bottom: 8, right: 8, display: "flex", gap: 4 }}>
            <button onMouseDown={(e) => e.stopPropagation()} onClick={() => setZoom(z => Math.min(z * 1.3, 10))}
              style={{ width: 26, height: 26, background: "rgba(13,15,24,0.8)", border: "1px solid #1e2035", borderRadius: 6, color: "#e2e8f0", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
            <button onMouseDown={(e) => e.stopPropagation()} onClick={() => setZoom(z => Math.max(z * 0.77, 0.1))}
              style={{ width: 26, height: 26, background: "rgba(13,15,24,0.8)", border: "1px solid #1e2035", borderRadius: 6, color: "#e2e8f0", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
          </div>
        </div>

        {/* Dimension inputs */}
        <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, color: "#64748b", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>Width ({unitLabel})</div>
            <input type="number" min="0.01" step="0.1"
              value={fmt(metersTo(w, localUnit))}
              onChange={(e) => setW(toMeters(parseFloat(e.target.value) || 0, localUnit))}
              style={{ width: "100%", background: "#0d0f18", border: "1px solid #5b4bff", borderRadius: 8, color: "#e2e8f0", padding: "10px 12px", fontSize: 16, fontWeight: 600, textAlign: "center", boxSizing: "border-box" }} />
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: 10, color: "#475569", fontSize: 20 }}>×</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, color: "#64748b", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>Depth ({unitLabel})</div>
            <input type="number" min="0.01" step="0.1"
              value={fmt(metersTo(d, localUnit))}
              onChange={(e) => setD(toMeters(parseFloat(e.target.value) || 0, localUnit))}
              style={{ width: "100%", background: "#0d0f18", border: "1px solid #5b4bff", borderRadius: 8, color: "#e2e8f0", padding: "10px 12px", fontSize: 16, fontWeight: 600, textAlign: "center", boxSizing: "border-box" }} />
          </div>
        </div>

        {/* Confirm */}
        <button onClick={() => onConfirm(w, d)}
          style={{ width: "100%", background: "#5b4bff", border: "none", borderRadius: 8, color: "#fff", padding: "12px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
          ✓ Confirm — {fmt(metersTo(w, localUnit))} × {fmt(metersTo(d, localUnit))} {unitLabel}
        </button>
      </div>
    </div>
  );
}

function SceneListPanel({ sceneListData, items, walls, itemCounts, selectedUids, projectName, unit, UNITS, fmt, metersTo, threeRef, setRightPanelTab }) {
  const [copiedText, setCopiedText] = React.useState(false);
  const [expandedModels, setExpandedModels] = React.useState({});

  const allCats = React.useMemo(() => {
    const cats = Object.keys(sceneListData).filter((c) => c !== "Walls & Structure");
    const hasAccs = Object.values(sceneListData).flat().some(({ accessories }) => Object.keys(accessories).length > 0);
    if (hasAccs) cats.push("Accessories");
    cats.push("Walls & Structure");
    return cats;
  }, [sceneListData]);

  const [activeFilters, setActiveFilters] = React.useState(() => {
    const f = {};
    Object.keys(sceneListData).forEach((c) => { f[c] = c !== "Walls & Structure"; });
    f["Accessories"] = true;
    f["Walls & Structure"] = false;
    return f;
  });

  React.useEffect(() => {
    setActiveFilters((prev) => {
      const next = { ...prev };
      allCats.forEach((c) => { if (!(c in next)) next[c] = c !== "Walls & Structure"; });
      return next;
    });
  }, [allCats]);

  const toggleModel = (catalogId) => setExpandedModels((prev) => ({ ...prev, [catalogId]: !prev[catalogId] }));
  const toggleFilter = (cat) => setActiveFilters((prev) => ({ ...prev, [cat]: !prev[cat] }));

  const allAccs = React.useMemo(() => {
    const acc = {};
    Object.values(sceneListData).flat().forEach(({ accessories }) => {
      Object.entries(accessories).forEach(([a, n]) => { acc[a] = (acc[a] || 0) + n; });
    });
    return acc;
  }, [sceneListData]);

  const copyText = () => {
    let text = `Scene List — ${projectName}\n${"─".repeat(36)}\n`;
    Object.entries(sceneListData).forEach(([cat, rows]) => {
      if (cat === "Walls & Structure" || !activeFilters[cat]) return;
      text += `\n${cat}\n`;
      rows.forEach(({ name, count }) => { text += `  ${name} × ${count}\n`; });
    });
    if (activeFilters["Accessories"] && Object.keys(allAccs).length) {
      text += `\nAccessories\n`;
      Object.entries(allAccs).forEach(([a, n]) => { text += `  ${a} × ${n}\n`; });
    }
    if (activeFilters["Walls & Structure"] && walls.length) text += `\nWalls × ${walls.length}\n`;
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
    setCopiedText(true); setTimeout(() => setCopiedText(false), 2000);
  };

  const downloadCSV = () => {
    let csv = "Category,Model,Qty\n";
    Object.entries(sceneListData).forEach(([cat, rows]) => {
      if (cat === "Walls & Structure" || !activeFilters[cat]) return;
      rows.forEach(({ name, count }) => { csv += `${cat},${name},${count}\n`; });
    });
    if (activeFilters["Accessories"]) Object.entries(allAccs).forEach(([a, n]) => { csv += `Accessories,${a},${n}\n`; });
    if (activeFilters["Walls & Structure"] && walls.length) csv += `Walls & Structure,Walls,${walls.length}\n`;
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = `${projectName.replace(/\s+/g, "_")}_scene.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
      {/* Category filter toggles */}
      <div style={{ padding: "8px 12px", borderBottom: "1px solid #1e2035", flexShrink: 0 }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: "#334155", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Show in export</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {allCats.map((cat) => (
            <div key={cat} onClick={() => toggleFilter(cat)} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "2px 0" }}>
              <div style={{ width: 28, height: 16, background: activeFilters[cat] ? "#5b4bff" : "#1e2035", border: activeFilters[cat] ? "none" : "1px solid #2a2f4a", borderRadius: 8, position: "relative", flexShrink: 0, transition: "background 0.15s" }}>
                <div style={{ width: 12, height: 12, background: activeFilters[cat] ? "#fff" : "#475569", borderRadius: "50%", position: "absolute", top: 2, left: activeFilters[cat] ? 14 : 2, transition: "left 0.15s" }} />
              </div>
              <span style={{ fontSize: 11, color: activeFilters[cat] ? "#94a3b8" : "#334155" }}>{cat}</span>
            </div>
          ))}
        </div>
      </div>
      {/* Buttons */}
      <div style={{ display: "flex", gap: 6, padding: "8px 12px", borderBottom: "1px solid #1e2035", flexShrink: 0 }}>
        <button onClick={copyText} style={{ flex: 1, background: copiedText ? "#1a3a28" : "#1e2035", border: `1px solid ${copiedText ? "#4ade80" : "#2a2f4a"}`, borderRadius: 6, color: copiedText ? "#4ade80" : "#94a3b8", fontSize: 10, padding: "5px 0", cursor: "pointer", fontWeight: 600, transition: "all 0.2s" }}>
          {copiedText ? "✓ Copied!" : "Copy text"}
        </button>
        <button onClick={downloadCSV} style={{ flex: 1, background: "#1e2035", border: "1px solid #2a2f4a", borderRadius: 6, color: "#94a3b8", fontSize: 10, padding: "5px 0", cursor: "pointer", fontWeight: 600 }}>Download CSV</button>
      </div>
      {/* Outliner */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
        {Object.keys(sceneListData).length === 0 && walls.length === 0 ? (
          <div style={{ padding: "24px 16px", textAlign: "center", color: "#334155", fontSize: 11 }}>No objects placed yet</div>
        ) : (
          <>
            {Object.entries(sceneListData).filter(([cat]) => cat !== "Walls & Structure").map(([cat, catRows]) => (
              <div key={cat} style={{ opacity: activeFilters[cat] ? 1 : 0.35 }}>
                <div style={{ display: "flex", alignItems: "center", padding: "8px 12px 4px", gap: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.06em", flex: 1 }}>{cat}</span>
                  <span style={{ background: "#1e2035", color: "#64748b", fontSize: 9, fontWeight: 700, borderRadius: 8, padding: "1px 6px" }}>{catRows.reduce((s, r) => s + r.count, 0)}</span>
                </div>
                {catRows.map(({ catalogId, name, count }) => {
                  const modelUids = items.filter((it) => it.catalogId === catalogId).map((it) => it.uid);
                  const allSelected = modelUids.length > 0 && modelUids.every((uid) => selectedUids.includes(uid));
                  const isExpanded = expandedModels[catalogId];
                  return (
                    <div key={catalogId}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px 5px 16px", background: allSelected ? "#13162a" : "transparent", borderLeft: allSelected ? "2px solid #5b4bff" : "2px solid transparent" }}>
                        <div onClick={() => toggleModel(catalogId)} style={{ flexShrink: 0, width: 16, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2.5" style={{ transform: isExpanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }}><polyline points="6,9 12,15 18,9"/></svg>
                        </div>
                        <div onClick={() => threeRef.current.setSelectedGroup(modelUids)} style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, cursor: "pointer" }}>
                          <div style={{ width: 7, height: 7, borderRadius: 2, background: "#5b4bff", flexShrink: 0 }} />
                          <span style={{ fontSize: 12, color: allSelected ? "#e2e8f0" : "#94a3b8", flex: 1, fontWeight: allSelected ? 600 : 400 }}>{name}</span>
                          <span style={{ background: "#5b4bff", color: "#fff", fontSize: 9, fontWeight: 700, borderRadius: 8, padding: "1px 6px" }}>{count}</span>
                        </div>
                      </div>
                      {isExpanded && items.filter((it) => it.catalogId === catalogId).map((it, idx) => {
                        const isSel = selectedUids.includes(it.uid) && selectedUids.length === 1;
                        return (
                          <div key={it.uid} onClick={() => threeRef.current.setSelectedGroup([it.uid])}
                            style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 12px 4px 40px", cursor: "pointer", background: isSel ? "#13162a" : "transparent", borderLeft: isSel ? "2px solid #00e5ff" : "2px solid transparent" }}>
                            <span style={{ fontSize: 10, color: "#334155" }}>#{idx + 1}</span>
                            <span style={{ fontSize: 11, color: isSel ? "#00e5ff" : "#475569", flex: 1 }}>{name}</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ))}
            {Object.keys(allAccs).length > 0 && (
              <div style={{ opacity: activeFilters["Accessories"] ? 1 : 0.35 }}>
                <div style={{ display: "flex", alignItems: "center", padding: "8px 12px 4px", gap: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.06em", flex: 1 }}>Accessories</span>
                  <span style={{ background: "#1e2035", color: "#64748b", fontSize: 9, fontWeight: 700, borderRadius: 8, padding: "1px 6px" }}>{Object.values(allAccs).reduce((s, v) => s + v, 0)}</span>
                </div>
                {Object.entries(allAccs).map(([acc, n]) => (
                  <div key={acc} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 12px 5px 28px" }}>
                    <div style={{ width: 7, height: 7, borderRadius: 2, background: acc === "Lamp" ? "#f59e0b" : "#818cf8", flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: "#94a3b8", flex: 1 }}>{acc}</span>
                    <span style={{ background: acc === "Lamp" ? "#f59e0b" : "#818cf8", color: "#fff", fontSize: 9, fontWeight: 700, borderRadius: 8, padding: "1px 6px" }}>{n}</span>
                  </div>
                ))}
              </div>
            )}
            {walls.length > 0 && (
              <div style={{ opacity: activeFilters["Walls & Structure"] ? 1 : 0.35 }}>
                <div style={{ display: "flex", alignItems: "center", padding: "8px 12px 4px", gap: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.06em", flex: 1 }}>Walls & Structure</span>
                  <span style={{ background: "#1e2035", color: "#64748b", fontSize: 9, fontWeight: 700, borderRadius: 8, padding: "1px 6px" }}>{walls.length}</span>
                </div>
                {walls.map((w, idx) => (
                  <div key={w.uid} onClick={() => { threeRef.current.setSelectedWall && threeRef.current.setSelectedWall(w.uid); threeRef.current.setSelected && threeRef.current.setSelected(null); setRightPanelTab("properties"); }}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 12px 5px 28px", cursor: "pointer" }}
                    onMouseEnter={e => e.currentTarget.style.background = "#0d0f18"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <div style={{ width: 7, height: 7, borderRadius: 2, background: "#c4622d", flexShrink: 0 }} />
                    <span style={{ fontSize: 11, color: "#94a3b8", flex: 1 }}>Wall #{idx + 1}</span>
                    <span style={{ fontSize: 10, color: "#475569" }}>{fmt(metersTo(Math.hypot(w.x2 - w.x1, w.z2 - w.z1), unit))}{UNITS[unit].label}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ borderTop: "1px solid #1e2035", margin: "8px 12px 0", padding: "8px 0", display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 10, color: "#475569" }}>Total objects</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0" }}>{Object.values(itemCounts).reduce((s, v) => s + v, 0) + walls.length}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}


function Section({ title, children, badge, defaultOpen = true, visible, onVisibilityToggle, locked, onLockToggle }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const hasVisibility = visible !== undefined;
  const hasLock = locked !== undefined;
  return (
    <div style={{ borderBottom: "1px solid #1e2035" }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", background: "none", border: "none", color: "#e2e8f0", cursor: "pointer" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em", color: hasVisibility && !visible ? "#475569" : "#e2e8f0" }}>{title}</span>
            {badge != null && (
              <span style={{ background: "#5b4bff", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 10, padding: "1px 7px", minWidth: 18, textAlign: "center" }}>{badge}</span>
            )}
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            style={{ transition: "transform 0.2s", transform: open ? "rotate(0deg)" : "rotate(-90deg)", opacity: 0.5 }}>
            <polyline points="6,9 12,15 18,9"/>
          </svg>
        </button>
        {hasLock && (
          <button onClick={(e) => { e.stopPropagation(); onLockToggle(); }}
            title={locked ? "Unlock" : "Lock"}
            style={{ flexShrink: 0, width: 28, height: 28, background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: locked ? "#f59e0b" : "#334155" }}>
            {locked
              ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
            }
          </button>
        )}
        {hasVisibility && (
          <div onClick={(e) => { e.stopPropagation(); onVisibilityToggle(); }}
            style={{ flexShrink: 0, marginRight: 12, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <span style={{ fontSize: 10, color: visible ? "#64748b" : "#475569", fontWeight: 500 }}>{visible ? "Hide" : "Show"}</span>
            <div style={{ width: 36, height: 20, background: visible ? "#5b4bff" : "#1e2035", border: visible ? "none" : "1px solid #2a2f4a", borderRadius: 10, position: "relative", flexShrink: 0 }}>
              <div style={{ width: 16, height: 16, background: visible ? "#fff" : "#475569", borderRadius: "50%", position: "absolute", top: 2, left: visible ? 18 : 2, transition: "left 0.15s" }} />
            </div>
          </div>
        )}
      </div>
      {open && (
        <div style={{ padding: "0 16px 16px 16px", opacity: hasVisibility && !visible ? 0.4 : 1 }}>{children}</div>
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
