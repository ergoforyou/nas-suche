"""Tests: python -m unittest discover -s tests"""

import io
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from bild2vrm import Options, generate  # noqa: E402
from bild2vrm.__main__ import main  # noqa: E402
from bild2vrm.rig import BONES  # noqa: E402
from make_test_figure import make_figure  # noqa: E402

REQUIRED_BONES = {"hips", "spine", "chest", "neck", "head", "leftUpperArm", "leftLowerArm", "leftHand",
                  "rightUpperArm", "rightLowerArm", "rightHand", "leftUpperLeg", "leftLowerLeg", "leftFoot",
                  "rightUpperLeg", "rightLowerLeg", "rightFoot"}


def parse_glb(data: bytes):
    magic, version, total = struct.unpack_from("<4sII", data, 0)
    assert magic == b"glTF" and version == 2 and total == len(data)
    jlen, jtype = struct.unpack_from("<I4s", data, 12)
    assert jtype == b"JSON"
    gltf = json.loads(data[20:20 + jlen])
    blen, btype = struct.unpack_from("<I4s", data, 20 + jlen)
    assert btype == b"BIN\x00"
    return gltf, data[28 + jlen:28 + jlen + blen]


def read_accessor(gltf, binary, idx):
    acc = gltf["accessors"][idx]
    view = gltf["bufferViews"][acc["bufferView"]]
    dtype = {5126: "<f4", 5123: "<u2", 5125: "<u4"}[acc["componentType"]]
    n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[acc["type"]]
    arr = np.frombuffer(binary, dtype=dtype, count=acc["count"] * n, offset=view["byteOffset"])
    return arr.reshape(acc["count"], n)


class PipelineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        make_figure(str(cls.dir / "a.png"))
        make_figure(str(cls.dir / "t.png"), tpose=True)
        make_figure(str(cls.dir / "w.png"), bg=(255, 255, 255, 255))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _check(self, path, version):
        res = generate(Image.open(path), Options(vrm_version=version, name="Test"))
        gltf, binary = parse_glb(res.vrm)
        prim = gltf["meshes"][0]["primitives"][0]
        pos = read_accessor(gltf, binary, prim["attributes"]["POSITION"])
        weights = read_accessor(gltf, binary, prim["attributes"]["WEIGHTS_0"])
        joints = read_accessor(gltf, binary, prim["attributes"]["JOINTS_0"])
        idx = read_accessor(gltf, binary, prim["indices"])

        self.assertTrue(np.allclose(weights.sum(1), 1.0, atol=1e-4))
        self.assertLess(joints.max(), len(BONES))
        self.assertLess(idx.max(), len(pos))
        self.assertAlmostEqual(float(pos[:, 1].min()), 0.0, places=4)  # feet on the ground
        self.assertGreater(float(pos[:, 1].max()), 1.4)

        nodes = gltf["nodes"]
        if version == "0":
            ext = gltf["extensions"]["VRM"]
            human = {b["bone"]: b["node"] for b in ext["humanoid"]["humanBones"]}
            self.assertEqual(ext["meta"]["title"], "Test")
        else:
            ext = gltf["extensions"]["VRMC_vrm"]
            human = {k: v["node"] for k, v in ext["humanoid"]["humanBones"].items()}
            self.assertEqual(ext["specVersion"], "1.0")
        self.assertTrue(REQUIRED_BONES <= set(human))

        def world(node_idx):
            # bones only carry translations
            parents = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
            p, i = np.zeros(3), node_idx
            while i is not None:
                p += nodes[i].get("translation", [0, 0, 0])
                i = parents.get(i)
            return p

        lh, rh = world(human["leftHand"]), world(human["rightHand"])
        lu = world(human["leftUpperArm"])
        # T-pose: hands at shoulder height, VRM 0.x faces -Z (left = -X), VRM 1.0 faces +Z (left = +X)
        self.assertAlmostEqual(lh[1], lu[1], delta=0.02)
        self.assertTrue(lh[0] < 0 < rh[0] if version == "0" else rh[0] < 0 < lh[0])
        return res

    def test_apose_vrm0(self):
        self._check(self.dir / "a.png", "0")

    def test_apose_vrm1(self):
        self._check(self.dir / "a.png", "1")

    def test_tpose_input(self):
        self._check(self.dir / "t.png", "1")

    def test_white_background(self):
        res = self._check(self.dir / "w.png", "0")
        kp = res.keypoints
        self.assertGreater(kp["left_wrist"][0], kp["right_wrist"][0])

    def test_cli_and_keypoints_roundtrip(self):
        out, kp = self.dir / "cli.vrm", self.dir / "kp.json"
        self.assertEqual(main([str(self.dir / "a.png"), "-o", str(out), "--save-keypoints", str(kp)]), 0)
        parse_glb(out.read_bytes())
        out2 = self.dir / "cli2.vrm"
        self.assertEqual(main([str(self.dir / "a.png"), "-o", str(out2), "--keypoints", str(kp), "--vrm", "1"]), 0)
        parse_glb(out2.read_bytes())

    def test_swapped_sides_rejected(self):
        res = generate(Image.open(self.dir / "a.png"), Options())
        kp = dict(res.keypoints)
        for j in ("shoulder", "elbow", "wrist", "hip", "knee", "ankle"):
            kp[f"left_{j}"], kp[f"right_{j}"] = kp[f"right_{j}"], kp[f"left_{j}"]
        with self.assertRaises(ValueError):
            generate(Image.open(self.dir / "a.png"), Options(), kp)

    def test_empty_image_rejected(self):
        buf = io.BytesIO()
        Image.new("RGBA", (64, 64), (0, 0, 0, 0)).save(buf, "PNG")
        with self.assertRaises(RuntimeError):
            generate(Image.open(io.BytesIO(buf.getvalue())), Options())


if __name__ == "__main__":
    unittest.main()
