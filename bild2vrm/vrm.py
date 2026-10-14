"""Minimaler GLB-/VRM-Writer (VRM 0.x und VRM 1.0), ohne externe Abhängigkeiten."""

from __future__ import annotations

import json
import struct

import numpy as np

from .rig import BONES

FLOAT, USHORT, UINT = 5126, 5123, 5125
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963

VRM0_PRESETS = [
    "neutral", "a", "i", "u", "e", "o", "blink", "joy", "angry", "sorrow", "fun",
    "lookup", "lookdown", "lookleft", "lookright", "blink_l", "blink_r",
]


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


def write_vrm(*, positions, normals, uvs, indices, joints, weights, bone_positions,
              texture_png: bytes, thumbnail_png: bytes | None, version: str,
              name: str, author: str) -> bytes:
    """positions/normals/bone_positions in VRM-1.0 orientation (facing +Z).

    For VRM 0.x everything is rotated 180° around Y (VRM 0.x faces -Z)."""
    positions = np.asarray(positions, dtype=np.float64)
    normals = np.asarray(normals, dtype=np.float64)
    bone_positions = np.asarray(bone_positions, dtype=np.float64)
    if version == "0":
        flip = np.array([-1.0, 1.0, -1.0])
        positions, normals, bone_positions = positions * flip, normals * flip, bone_positions * flip

    g = _GLBBuilder()
    gl = g.gltf

    # --- mesh data
    pos_acc = g.accessor(positions, FLOAT, "VEC3", ARRAY_BUFFER, minmax=True)
    nrm_acc = g.accessor(normals, FLOAT, "VEC3", ARRAY_BUFFER)
    uv_acc = g.accessor(uvs, FLOAT, "VEC2", ARRAY_BUFFER)
    jnt_acc = g.accessor(joints, USHORT, "VEC4", ARRAY_BUFFER)
    wgt_acc = g.accessor(weights, FLOAT, "VEC4", ARRAY_BUFFER)
    idx_acc = g.accessor(np.asarray(indices).reshape(-1), UINT, "SCALAR", ELEMENT_ARRAY_BUFFER)

    # --- nodes: 0 = Root, 1 = Body (skinned mesh), 2.. = bones
    nb = len(BONES)
    bone_node = {bn: 2 + i for i, (bn, _) in enumerate(BONES)}
    nodes = [{"name": "Root", "children": [bone_node["hips"]]},
             {"name": "Body", "mesh": 0, "skin": 0}]
    for i, (bn, parent) in enumerate(BONES):
        parent_pos = bone_positions[[b for b, _ in BONES].index(parent)] if parent else np.zeros(3)
        nodes.append({"name": bn, "translation": (bone_positions[i] - parent_pos).tolist()})
    for i, (bn, parent) in enumerate(BONES):
        if parent:
            nodes[bone_node[parent]].setdefault("children", []).append(bone_node[bn])
    gl["nodes"] = nodes
    gl["scenes"] = [{"nodes": [0, 1]}]
    gl["scene"] = 0

    ibm = np.tile(np.eye(4), (nb, 1, 1))
    ibm[:, :3, 3] = -bone_positions
    ibm_cm = ibm.transpose(0, 2, 1).reshape(nb, 16)  # glTF matrices are column-major
    gl["skins"] = [{
        "inverseBindMatrices": g.accessor(ibm_cm, FLOAT, "MAT4"),
        "joints": [bone_node[bn] for bn, _ in BONES],
        "skeleton": bone_node["hips"],
    }]

    # --- textures & material
    tex_img = g.image(texture_png, "texture")
    gl["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}]
    gl["textures"] = [{"sampler": 0, "source": tex_img}]
    thumb_img = None
    if thumbnail_png:
        thumb_img = g.image(thumbnail_png, "thumbnail")
        gl["textures"].append({"sampler": 0, "source": thumb_img})
    gl["materials"] = [{
        "name": "Body",
        "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0.0, "roughnessFactor": 1.0},
        "alphaMode": "MASK", "alphaCutoff": 0.5, "doubleSided": False,
        "extensions": {"KHR_materials_unlit": {}},
    }]
    gl["meshes"] = [{"name": "Body", "primitives": [{
        "attributes": {"POSITION": pos_acc, "NORMAL": nrm_acc, "TEXCOORD_0": uv_acc,
                       "JOINTS_0": jnt_acc, "WEIGHTS_0": wgt_acc},
        "indices": idx_acc, "material": 0, "mode": 4,
    }]}]

    head_node = bone_node["head"]
    if version == "0":
        gl["extensionsUsed"] = ["KHR_materials_unlit", "VRM"]
        gl["extensions"] = {"VRM": _vrm0_extension(bone_node, head_node, thumb_img, name, author)}
    else:
        gl["extensionsUsed"] = ["KHR_materials_unlit", "VRMC_vrm"]
        gl["extensions"] = {"VRMC_vrm": _vrm1_extension(bone_node, thumb_img, name, author)}
    return g.to_bytes()


def _vrm0_extension(bone_node, head_node, thumb_tex, name, author) -> dict:
    curve = {"curve": [0, 0, 0, 1, 1, 1, 1, 0], "xRange": 90, "yRange": 10}
    return {
        "exporterVersion": "bild2vrm-1.0",
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
            "firstPersonBone": head_node,
            "firstPersonBoneOffset": {"x": 0, "y": 0.06, "z": 0},
            "meshAnnotations": [{"mesh": 0, "firstPersonFlag": "Auto"}],
            "lookAtTypeName": "BlendShape",
            "lookAtHorizontalInner": curve, "lookAtHorizontalOuter": curve,
            "lookAtVerticalDown": curve, "lookAtVerticalUp": curve,
        },
        "blendShapeMaster": {"blendShapeGroups": [
            {"name": p.capitalize(), "presetName": p, "binds": [], "materialValues": [], "isBinary": False}
            for p in VRM0_PRESETS
        ]},
        "secondaryAnimation": {"boneGroups": [], "colliderGroups": []},
        "materialProperties": [{
            "name": "Body",
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
            "textureProperties": {"_MainTex": 0, "_ShadeTexture": 0},
            "keywordMap": {"_ALPHATEST_ON": True},
            "tagMap": {"RenderType": "TransparentCutout"},
        }],
    }


def _vrm1_extension(bone_node, thumb_tex, name, author) -> dict:
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
        meta["thumbnailImage"] = thumb_tex  # image index == texture index here
    range_map = {"inputMaxValue": 90.0, "outputScale": 1.0}
    return {
        "specVersion": "1.0",
        "meta": meta,
        "humanoid": {"humanBones": {bn: {"node": node} for bn, node in bone_node.items()}},
        "firstPerson": {"meshAnnotations": [{"node": 1, "type": "auto"}]},
        "lookAt": {
            "offsetFromHeadBone": [0.0, 0.06, 0.0], "type": "expression",
            "rangeMapHorizontalInner": range_map, "rangeMapHorizontalOuter": range_map,
            "rangeMapVerticalDown": range_map, "rangeMapVerticalUp": range_map,
        },
    }
