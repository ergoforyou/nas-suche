"""Minimaler GLB-/VRM-Writer (VRM 0.x und VRM 1.0), ohne externe Abhängigkeiten."""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass, field

import numpy as np

from .rig import BONES

FLOAT, USHORT, UINT = 5126, 5123, 5125
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963

VRM0_PRESETS = [
    "neutral", "a", "i", "u", "e", "o", "blink", "joy", "angry", "sorrow", "fun",
    "lookup", "lookdown", "lookleft", "lookright", "blink_l", "blink_r",
]
# VRM 1.0 expression preset -> VRM 0.x blend shape preset
VRM1_TO_VRM0 = {
    "neutral": "neutral", "aa": "a", "ih": "i", "ou": "u", "ee": "e", "oh": "o",
    "blink": "blink", "blinkLeft": "blink_l", "blinkRight": "blink_r",
    "happy": "joy", "angry": "angry", "sad": "sorrow", "relaxed": "fun",
}
BINARY_EXPRESSIONS = set()


@dataclass
class Primitive:
    positions: np.ndarray        # (N, 3), VRM-1.0 orientation (facing +Z)
    normals: np.ndarray          # (N, 3)
    uvs: np.ndarray              # (N, 2)
    indices: np.ndarray          # (M, 3)
    joints: np.ndarray           # (N, 4)
    weights: np.ndarray          # (N, 4)
    material: int
    targets: list[np.ndarray] = field(default_factory=list)  # morph position deltas (N, 3)


@dataclass
class MeshSpec:
    name: str
    primitives: list[Primitive]
    target_names: list[str] = field(default_factory=list)


@dataclass
class MaterialSpec:
    name: str
    texture_png: bytes


class _GLBBuilder:
    def __init__(self) -> None:
        self.bin = bytearray()
        self.gltf: dict = {
            "asset": {"version": "2.0", "generator": "bild2vrm"},
            "buffers": [], "bufferViews": [], "accessors": [],
        }

    def _view(self, data: bytes, target: int | None = None) -> int:
        while len(self.bin) % 4:
            self.bin.append(0)
        view = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target:
            view["target"] = target
        self.bin.extend(data)
        self.gltf["bufferViews"].append(view)
        return len(self.gltf["bufferViews"]) - 1

    def accessor(self, arr: np.ndarray, ctype: int, atype: str, target: int | None = None, minmax: bool = False) -> int:
        dtype = {FLOAT: "<f4", USHORT: "<u2", UINT: "<u4"}[ctype]
        a = np.ascontiguousarray(arr, dtype=dtype)
        acc = {
            "bufferView": self._view(a.tobytes(), target),
            "componentType": ctype,
            "count": int(a.shape[0]),
            "type": atype,
        }
        if minmax:
            flat = a.reshape(a.shape[0], -1)
            acc["min"] = flat.min(0).astype(float).tolist()
            acc["max"] = flat.max(0).astype(float).tolist()
        self.gltf["accessors"].append(acc)
        return len(self.gltf["accessors"]) - 1

    def image(self, png: bytes, name: str) -> int:
        self.gltf.setdefault("images", []).append(
            {"name": name, "bufferView": self._view(png), "mimeType": "image/png"})
        return len(self.gltf["images"]) - 1

    def to_bytes(self) -> bytes:
        while len(self.bin) % 4:
            self.bin.append(0)
        self.gltf["buffers"] = [{"byteLength": len(self.bin)}]
        js = json.dumps(self.gltf, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        js += b" " * ((4 - len(js) % 4) % 4)
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        out = bytearray(struct.pack("<4sII", b"glTF", 2, total))
        out += struct.pack("<I4s", len(js), b"JSON") + js
        out += struct.pack("<I4s", len(self.bin), b"BIN\x00") + self.bin
        return bytes(out)


def write_vrm(*, meshes: list[MeshSpec], materials: list[MaterialSpec], bone_positions,
              thumbnail_png: bytes | None, version: str, name: str, author: str,
              expressions: dict[str, list[tuple[int, int, float]]] | None = None) -> bytes:
    """Write a skinned VRM.

    expressions: VRM 1.0 preset name -> [(mesh index, morph target index, weight 0..1)].
    All geometry is given in VRM-1.0 orientation (facing +Z); for VRM 0.x it is
    rotated 180° around Y (VRM 0.x faces -Z)."""
    flip = np.array([-1.0, 1.0, -1.0]) if version == "0" else np.ones(3)
    bone_positions = np.asarray(bone_positions, dtype=np.float64) * flip
    expressions = expressions or {}

    g = _GLBBuilder()
    gl = g.gltf

    # --- nodes: 0 = Root, 1..len(meshes) = skinned meshes, then bones
    nb = len(BONES)
    first_bone = 1 + len(meshes)
    bone_node = {bn: first_bone + i for i, (bn, _) in enumerate(BONES)}
    nodes = [{"name": "Root", "children": [bone_node["hips"]]}]
    nodes += [{"name": m.name, "mesh": i, "skin": 0} for i, m in enumerate(meshes)]
    names = [b for b, _ in BONES]
    for i, (bn, parent) in enumerate(BONES):
        parent_pos = bone_positions[names.index(parent)] if parent else np.zeros(3)
        nodes.append({"name": bn, "translation": (bone_positions[i] - parent_pos).tolist()})
    for bn, parent in BONES:
        if parent:
            nodes[bone_node[parent]].setdefault("children", []).append(bone_node[bn])
    gl["nodes"] = nodes
    gl["scenes"] = [{"nodes": list(range(0, 1 + len(meshes)))}]
    gl["scene"] = 0

    ibm = np.tile(np.eye(4), (nb, 1, 1))
    ibm[:, :3, 3] = -bone_positions
    gl["skins"] = [{
        "inverseBindMatrices": g.accessor(ibm.transpose(0, 2, 1).reshape(nb, 16), FLOAT, "MAT4"),
        "joints": [bone_node[bn] for bn, _ in BONES],
        "skeleton": bone_node["hips"],
    }]

    # --- meshes
    gl["meshes"] = []
    for m in meshes:
        prims = []
        for p in m.primitives:
            prim = {
                "attributes": {
                    "POSITION": g.accessor(np.asarray(p.positions) * flip, FLOAT, "VEC3", ARRAY_BUFFER, minmax=True),
                    "NORMAL": g.accessor(np.asarray(p.normals) * flip, FLOAT, "VEC3", ARRAY_BUFFER),
                    "TEXCOORD_0": g.accessor(p.uvs, FLOAT, "VEC2", ARRAY_BUFFER),
                    "JOINTS_0": g.accessor(p.joints, USHORT, "VEC4", ARRAY_BUFFER),
                    "WEIGHTS_0": g.accessor(p.weights, FLOAT, "VEC4", ARRAY_BUFFER),
                },
                "indices": g.accessor(np.asarray(p.indices).reshape(-1), UINT, "SCALAR", ELEMENT_ARRAY_BUFFER),
                "material": p.material, "mode": 4,
            }
            if p.targets:
                prim["targets"] = [{"POSITION": g.accessor(np.asarray(t) * flip, FLOAT, "VEC3", minmax=True)}
                                   for t in p.targets]
                prim["extras"] = {"targetNames": m.target_names}
            prims.append(prim)
        mesh = {"name": m.name, "primitives": prims}
        if m.target_names:
            mesh["weights"] = [0.0] * len(m.target_names)
            mesh["extras"] = {"targetNames": m.target_names}
        gl["meshes"].append(mesh)

    # --- textures & materials
    gl["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}]
    gl["textures"], gl["materials"] = [], []
    for mat in materials:
        img = g.image(mat.texture_png, mat.name)
        gl["textures"].append({"sampler": 0, "source": img})
        gl["materials"].append({
            "name": mat.name,
            "pbrMetallicRoughness": {"baseColorTexture": {"index": len(gl["textures"]) - 1},
                                     "metallicFactor": 0.0, "roughnessFactor": 1.0},
            "alphaMode": "MASK", "alphaCutoff": 0.5, "doubleSided": False,
            "extensions": {"KHR_materials_unlit": {}},
        })
    thumb_tex = None
    if thumbnail_png:
        img = g.image(thumbnail_png, "thumbnail")
        gl["textures"].append({"sampler": 0, "source": img})
        thumb_tex = len(gl["textures"]) - 1  # == image index (one texture per image)

    mesh_nodes = [1 + i for i in range(len(meshes))]
    if version == "0":
        gl["extensionsUsed"] = ["KHR_materials_unlit", "VRM"]
        gl["extensions"] = {"VRM": _vrm0_extension(bone_node, len(meshes), materials, thumb_tex,
                                                   name, author, expressions)}
    else:
        gl["extensionsUsed"] = ["KHR_materials_unlit", "VRMC_vrm"]
        gl["extensions"] = {"VRMC_vrm": _vrm1_extension(bone_node, mesh_nodes, thumb_tex, name, author,
                                                        expressions)}
    return g.to_bytes()


def _vrm0_extension(bone_node, n_meshes, materials, thumb_tex, name, author, expressions) -> dict:
    curve = {"curve": [0, 0, 0, 1, 1, 1, 1, 0], "xRange": 90, "yRange": 10}
    by_preset = {VRM1_TO_VRM0[k]: v for k, v in expressions.items() if k in VRM1_TO_VRM0}
    groups = []
    for p in VRM0_PRESETS:
        binds = [{"mesh": mesh, "index": idx, "weight": round(100 * w, 3)} for mesh, idx, w in by_preset.get(p, [])]
        groups.append({"name": p.capitalize(), "presetName": p, "binds": binds, "materialValues": [],
                       "isBinary": p in BINARY_EXPRESSIONS})
    return {
        "exporterVersion": "bild2vrm-1.1",
        "specVersion": "0.0",
        "meta": {
            "title": name, "version": "1.0", "author": author,
            "contactInformation": "", "reference": "",
            "texture": thumb_tex if thumb_tex is not None else -1,
            "allowedUserName": "OnlyAuthor",
            "violentUssageName": "Disallow", "sexualUssageName": "Disallow",
            "commercialUssageName": "Disallow", "otherPermissionUrl": "",
            "licenseName": "Redistribution_Prohibited", "otherLicenseUrl": "",
        },
        "humanoid": {
            "humanBones": [{"bone": bn, "node": node, "useDefaultValues": True} for bn, node in bone_node.items()],
            "armStretch": 0.05, "legStretch": 0.05,
            "upperArmTwist": 0.5, "lowerArmTwist": 0.5, "upperLegTwist": 0.5, "lowerLegTwist": 0.5,
            "feetSpacing": 0, "hasTranslationDoF": False,
        },
        "firstPerson": {
            "firstPersonBone": bone_node["head"],
            "firstPersonBoneOffset": {"x": 0, "y": 0.06, "z": 0},
            "meshAnnotations": [{"mesh": i, "firstPersonFlag": "Auto"} for i in range(n_meshes)],
            "lookAtTypeName": "BlendShape",
            "lookAtHorizontalInner": curve, "lookAtHorizontalOuter": curve,
            "lookAtVerticalDown": curve, "lookAtVerticalUp": curve,
        },
        "blendShapeMaster": {"blendShapeGroups": groups},
        "secondaryAnimation": {"boneGroups": [], "colliderGroups": []},
        "materialProperties": [_mtoon0(i, m.name) for i, m in enumerate(materials)],
    }


def _mtoon0(texture: int, name: str) -> dict:
    return {
        "name": name,
        "shader": "VRM/MToon",
        "renderQueue": 2450,
        "floatProperties": {
            "_Cutoff": 0.5, "_BlendMode": 1, "_CullMode": 2, "_ShadeShift": 0, "_ShadeToony": 0.9,
            "_LightColorAttenuation": 0, "_IndirectLightIntensity": 0.1, "_OutlineWidthMode": 0,
            "_SrcBlend": 1, "_DstBlend": 0, "_ZWrite": 1,
        },
        "vectorProperties": {
            "_Color": [1, 1, 1, 1], "_ShadeColor": [0.92, 0.92, 0.92, 1],
            "_MainTex": [0, 0, 1, 1], "_ShadeTexture": [0, 0, 1, 1],
        },
        "textureProperties": {"_MainTex": texture, "_ShadeTexture": texture},
        "keywordMap": {"_ALPHATEST_ON": True},
        "tagMap": {"RenderType": "TransparentCutout"},
    }


def _vrm1_extension(bone_node, mesh_nodes, thumb_tex, name, author, expressions) -> dict:
    meta = {
        "name": name, "version": "1.0", "authors": [author or "unknown"],
        "licenseUrl": "https://vrm.dev/licenses/1.0/",
        "avatarPermission": "onlyAuthor",
        "allowExcessivelyViolentUsage": False, "allowExcessivelySexualUsage": False,
        "commercialUsage": "personalNonProfit",
        "allowPoliticalOrReligiousUsage": False, "allowAntisocialOrHateUsage": False,
        "creditNotation": "required", "allowRedistribution": False, "modification": "prohibited",
    }
    if thumb_tex is not None:
        meta["thumbnailImage"] = thumb_tex
    range_map = {"inputMaxValue": 90.0, "outputScale": 1.0}
    ext = {
        "specVersion": "1.0",
        "meta": meta,
        "humanoid": {"humanBones": {bn: {"node": node} for bn, node in bone_node.items()}},
        "firstPerson": {"meshAnnotations": [{"node": n, "type": "auto"} for n in mesh_nodes]},
        "lookAt": {
            "offsetFromHeadBone": [0.0, 0.06, 0.0], "type": "expression",
            "rangeMapHorizontalInner": range_map, "rangeMapHorizontalOuter": range_map,
            "rangeMapVerticalDown": range_map, "rangeMapVerticalUp": range_map,
        },
    }
    if expressions:
        ext["expressions"] = {"preset": {
            preset: {
                "morphTargetBinds": [{"node": mesh_nodes[mesh], "index": idx, "weight": float(w)}
                                     for mesh, idx, w in binds],
                "isBinary": preset in BINARY_EXPRESSIONS,
                "overrideBlink": "none", "overrideLookAt": "none", "overrideMouth": "none",
            }
            for preset, binds in expressions.items()
        }}
    return ext
