// Minimaler GLB-/VRM-Writer (VRM 0.x und VRM 1.0), ohne Abhängigkeiten.
import { BONES } from './rig.js';

const FLOAT = 5126, USHORT = 5123, UINT = 5125, ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;
const VRM0_PRESETS = ['neutral', 'a', 'i', 'u', 'e', 'o', 'blink', 'joy', 'angry', 'sorrow', 'fun',
  'lookup', 'lookdown', 'lookleft', 'lookright', 'blink_l', 'blink_r'];
const VRM1_TO_VRM0 = { neutral: 'neutral', aa: 'a', ih: 'i', ou: 'u', ee: 'e', oh: 'o', blink: 'blink', blinkLeft: 'blink_l',
  blinkRight: 'blink_r', happy: 'joy', angry: 'angry', sad: 'sorrow', relaxed: 'fun',
  lookUp: 'lookup', lookDown: 'lookdown', lookLeft: 'lookleft', lookRight: 'lookright' };
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

class GLBBuilder {
  constructor() {
    this.chunks = [];
    this.length = 0;
    this.gltf = { asset: { version: '2.0', generator: 'bild2vrm' }, buffers: [], bufferViews: [], accessors: [] };
  }

  view(bytes, target) {
    const padding = (4 - (this.length % 4)) % 4;
    if (padding) { this.chunks.push(new Uint8Array(padding)); this.length += padding; }
    const v = { buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength };
    if (target) v.target = target;
    this.chunks.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    this.length += bytes.byteLength;
    this.gltf.bufferViews.push(v);
    return this.gltf.bufferViews.length - 1;
  }

  accessor(values, ctype, type, target, minmax = false) {
    const Arr = { [FLOAT]: Float32Array, [USHORT]: Uint16Array, [UINT]: Uint32Array }[ctype];
    const a = values instanceof Arr ? values : Arr.from(values);
    const nc = COMPONENTS[type], count = a.length / nc;
    const acc = { bufferView: this.view(a, target), componentType: ctype, count, type };
    if (minmax) {
      const mn = new Array(nc).fill(Infinity), mx = new Array(nc).fill(-Infinity);
      for (let i = 0; i < a.length; i++) { const k = i % nc; if (a[i] < mn[k]) mn[k] = a[i]; if (a[i] > mx[k]) mx[k] = a[i]; }
      acc.min = mn; acc.max = mx;
    }
    this.gltf.accessors.push(acc);
    return this.gltf.accessors.length - 1;
  }

  /** Morph-Target (VEC3-Deltas): sparse gespeichert, wenn nur ein Teil der Punkte sich bewegt. */
  morphAccessor(values) {
    const count = values.length / 3, idx = [];
    for (let i = 0; i < count; i++) if (values[3 * i] || values[3 * i + 1] || values[3 * i + 2]) idx.push(i);
    if (idx.length > count / 3) return this.accessor(values, FLOAT, 'VEC3', undefined, true);
    const mn = [0, 0, 0], mx = [0, 0, 0], vals = new Float32Array(Math.max(1, idx.length) * 3);
    idx.forEach((i, k) => {
      for (let c = 0; c < 3; c++) {
        const v = values[3 * i + c];
        vals[3 * k + c] = v;
        if (v < mn[c]) mn[c] = v;
        if (v > mx[c]) mx[c] = v;
      }
    });
    const acc = { componentType: FLOAT, count, type: 'VEC3', min: Array.from(Float32Array.from(mn)), max: Array.from(Float32Array.from(mx)) };
    if (idx.length) {
      acc.sparse = {
        count: idx.length,
        indices: { bufferView: this.view(Uint32Array.from(idx)), componentType: UINT },
        values: { bufferView: this.view(vals) },
      };
    }
    this.gltf.accessors.push(acc);
    return this.gltf.accessors.length - 1;
  }

  image(png, name) {
    (this.gltf.images ??= []).push({ name, bufferView: this.view(png), mimeType: 'image/png' });
    return this.gltf.images.length - 1;
  }

  toBytes() {
    const binLen = this.length + ((4 - (this.length % 4)) % 4);
    this.gltf.buffers = [{ byteLength: binLen }];
    let json = new TextEncoder().encode(JSON.stringify(this.gltf));
    const jl = json.length + ((4 - (json.length % 4)) % 4);
    const out = new Uint8Array(12 + 8 + jl + 8 + binLen), dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
    dv.setUint32(12, jl, true); dv.setUint32(16, 0x4e4f534a, true);
    out.set(json, 20); out.fill(0x20, 20 + json.length, 20 + jl);
    dv.setUint32(20 + jl, binLen, true); dv.setUint32(24 + jl, 0x004e4942, true);
    let o = 28 + jl;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

const flipArr = (arr, flip) => (flip ? Float32Array.from(arr, (v, i) => (i % 3 === 1 ? v : -v)) : Float32Array.from(arr));

/**
 * meshes: [{ name, primitives: [{ positions, normals, uvs, indices, joints, weights, material, targets? }], targetNames? }]
 *   (Geometrie in VRM-1.0-Ausrichtung, Figur schaut nach +Z; bei VRM 0.x wird um 180° gedreht)
 * materials: [{ name, png }], bonePositions: [[x, y, z], …] in BONES-Reihenfolge
 * expressions: { vrm1Preset: [[meshIndex, targetIndex, weight 0..1], …] }
 */
export function writeVrm({ meshes, materials, bonePositions, thumbnailPng, version, name, author, expressions = {} }) {
  const flip = version === '0';
  const bones = bonePositions.map((p) => (flip ? [-p[0], p[1], -p[2]] : [...p]));
  const g = new GLBBuilder(), gl = g.gltf;
  const firstBone = 1 + meshes.length;
  const boneNode = Object.fromEntries(BONES.map(([n], i) => [n, firstBone + i]));
  const names = BONES.map(([n]) => n);
  const nodes = [{ name: 'Root', children: [boneNode.hips] }, ...meshes.map((m, i) => ({ name: m.name, mesh: i, skin: 0 }))];
  BONES.forEach(([bn, parent], i) => {
    const pp = parent ? bones[names.indexOf(parent)] : [0, 0, 0];
    nodes.push({ name: bn, translation: [bones[i][0] - pp[0], bones[i][1] - pp[1], bones[i][2] - pp[2]] });
  });
  for (const [bn, parent] of BONES) if (parent) (nodes[boneNode[parent]].children ??= []).push(boneNode[bn]);
  gl.nodes = nodes;
  gl.scenes = [{ nodes: [...Array(1 + meshes.length).keys()] }];
  gl.scene = 0;
  const ibm = new Float32Array(BONES.length * 16);
  bones.forEach((p, i) => { ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1], i * 16); });
  gl.skins = [{ inverseBindMatrices: g.accessor(ibm, FLOAT, 'MAT4'), joints: BONES.map(([n]) => boneNode[n]), skeleton: boneNode.hips }];

  gl.meshes = meshes.map((m) => {
    const prims = m.primitives.map((p) => {
      const prim = {
        attributes: {
          POSITION: g.accessor(flipArr(p.positions, flip), FLOAT, 'VEC3', ARRAY_BUFFER, true),
          NORMAL: g.accessor(flipArr(p.normals, flip), FLOAT, 'VEC3', ARRAY_BUFFER),
          TEXCOORD_0: g.accessor(p.uvs, FLOAT, 'VEC2', ARRAY_BUFFER),
          JOINTS_0: g.accessor(p.joints, USHORT, 'VEC4', ARRAY_BUFFER),
          WEIGHTS_0: g.accessor(p.weights, FLOAT, 'VEC4', ARRAY_BUFFER),
        },
        indices: g.accessor(p.indices, UINT, 'SCALAR', ELEMENT_ARRAY_BUFFER),
        material: p.material, mode: 4,
      };
      if (p.targets?.length) {
        prim.targets = p.targets.map((t) => ({ POSITION: g.morphAccessor(flipArr(t, flip)) }));
        prim.extras = { targetNames: m.targetNames };
      }
      return prim;
    });
    const mesh = { name: m.name, primitives: prims };
    if (m.targetNames?.length) { mesh.weights = m.targetNames.map(() => 0); mesh.extras = { targetNames: m.targetNames }; }
    return mesh;
  });

  gl.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }];
  gl.textures = []; gl.materials = [];
  for (const mat of materials) {
    gl.textures.push({ sampler: 0, source: g.image(mat.png, mat.name) });
    gl.materials.push({
      name: mat.name,
      pbrMetallicRoughness: { baseColorTexture: { index: gl.textures.length - 1 }, metallicFactor: 0, roughnessFactor: 1 },
      alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: false, extensions: { KHR_materials_unlit: {} },
    });
  }
  let thumbTex = null;
  if (thumbnailPng) { gl.textures.push({ sampler: 0, source: g.image(thumbnailPng, 'thumbnail') }); thumbTex = gl.textures.length - 1; }
  const meshNodes = meshes.map((_, i) => 1 + i);

  if (version === '0') {
    gl.extensionsUsed = ['KHR_materials_unlit', 'VRM'];
    gl.extensions = { VRM: vrm0Extension(boneNode, meshes.length, materials, thumbTex, name, author, expressions) };
  } else {
    gl.extensionsUsed = ['KHR_materials_unlit', 'VRMC_vrm'];
    gl.extensions = { VRMC_vrm: vrm1Extension(boneNode, meshNodes, thumbTex, name, author, expressions) };
  }
  return g.toBytes();
}

function vrm0Extension(boneNode, nMeshes, materials, thumbTex, name, author, expressions) {
  // Blick über Ausdrücke: volle Augenbewegung bei 30° (waagerecht) bzw. 25° (senkrecht), Gewicht max. 1
  const curveH = { curve: [0, 0, 0, 1, 1, 1, 1, 0], xRange: 30, yRange: 1 };
  const curveV = { curve: [0, 0, 0, 1, 1, 1, 1, 0], xRange: 25, yRange: 1 };
  const byPreset = {};
  for (const [k, v] of Object.entries(expressions)) if (VRM1_TO_VRM0[k]) byPreset[VRM1_TO_VRM0[k]] = v;
  return {
    exporterVersion: 'bild2vrm-js-1.1',
    specVersion: '0.0',
    meta: {
      title: name, version: '1.0', author, contactInformation: '', reference: '', texture: thumbTex ?? -1,
      allowedUserName: 'OnlyAuthor', violentUssageName: 'Disallow', sexualUssageName: 'Disallow', commercialUssageName: 'Disallow',
      otherPermissionUrl: '', licenseName: 'Redistribution_Prohibited', otherLicenseUrl: '',
    },
    humanoid: {
      humanBones: Object.entries(boneNode).map(([bone, node]) => ({ bone, node, useDefaultValues: true })),
      armStretch: 0.05, legStretch: 0.05, upperArmTwist: 0.5, lowerArmTwist: 0.5, upperLegTwist: 0.5, lowerLegTwist: 0.5,
      feetSpacing: 0, hasTranslationDoF: false,
    },
    firstPerson: {
      firstPersonBone: boneNode.head, firstPersonBoneOffset: { x: 0, y: 0.06, z: 0 },
      meshAnnotations: [...Array(nMeshes).keys()].map((mesh) => ({ mesh, firstPersonFlag: 'Auto' })),
      lookAtTypeName: 'BlendShape', lookAtHorizontalInner: curveH, lookAtHorizontalOuter: curveH, lookAtVerticalDown: curveV, lookAtVerticalUp: curveV,
    },
    blendShapeMaster: {
      blendShapeGroups: VRM0_PRESETS.map((p) => ({
        name: p[0].toUpperCase() + p.slice(1), presetName: p,
        binds: (byPreset[p] ?? []).map(([mesh, index, weight]) => ({ mesh, index, weight: Math.round(weight * 100000) / 1000 })),
        materialValues: [], isBinary: false,
      })),
    },
    secondaryAnimation: { boneGroups: [], colliderGroups: [] },
    materialProperties: materials.map((m, i) => ({
      name: m.name, shader: 'VRM/MToon', renderQueue: 2450,
      floatProperties: { _Cutoff: 0.5, _BlendMode: 1, _CullMode: 2, _ShadeShift: 0, _ShadeToony: 0.9, _LightColorAttenuation: 0,
        _IndirectLightIntensity: 0.1, _OutlineWidthMode: 0, _SrcBlend: 1, _DstBlend: 0, _ZWrite: 1 },
      vectorProperties: { _Color: [1, 1, 1, 1], _ShadeColor: [0.92, 0.92, 0.92, 1], _MainTex: [0, 0, 1, 1], _ShadeTexture: [0, 0, 1, 1] },
      textureProperties: { _MainTex: i, _ShadeTexture: i },
      keywordMap: { _ALPHATEST_ON: true }, tagMap: { RenderType: 'TransparentCutout' },
    })),
  };
}

function vrm1Extension(boneNode, meshNodes, thumbTex, name, author, expressions) {
  const meta = {
    name, version: '1.0', authors: [author || 'unknown'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'onlyAuthor',
    allowExcessivelyViolentUsage: false, allowExcessivelySexualUsage: false, commercialUsage: 'personalNonProfit',
    allowPoliticalOrReligiousUsage: false, allowAntisocialOrHateUsage: false, creditNotation: 'required',
    allowRedistribution: false, modification: 'prohibited',
  };
  if (thumbTex != null) meta.thumbnailImage = thumbTex;
  const rangeH = { inputMaxValue: 30, outputScale: 1 }, rangeV = { inputMaxValue: 25, outputScale: 1 };
  const ext = {
    specVersion: '1.0', meta,
    humanoid: { humanBones: Object.fromEntries(Object.entries(boneNode).map(([bn, node]) => [bn, { node }])) },
    firstPerson: { meshAnnotations: meshNodes.map((node) => ({ node, type: 'auto' })) },
    lookAt: { offsetFromHeadBone: [0, 0.06, 0], type: 'expression', rangeMapHorizontalInner: rangeH, rangeMapHorizontalOuter: rangeH,
      rangeMapVerticalDown: rangeV, rangeMapVerticalUp: rangeV },
  };
  if (Object.keys(expressions).length) {
    ext.expressions = { preset: Object.fromEntries(Object.entries(expressions).map(([preset, binds]) => [preset, {
      morphTargetBinds: binds.map(([mesh, index, weight]) => ({ node: meshNodes[mesh], index, weight })),
      isBinary: false, overrideBlink: 'none', overrideLookAt: 'none', overrideMouth: 'none',
    }])) };
  }
  return ext;
}
