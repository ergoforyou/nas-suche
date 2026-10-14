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

from bild2vrm import Options, Views, generate  # noqa: E402
from bild2vrm.__main__ import main  # noqa: E402
from bild2vrm.rig import BONES  # noqa: E402
from bild2vrm.views import side_profile, split_sheet  # noqa: E402
from make_test_figure import make_figure, make_sheet  # noqa: E402

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
        make_figure(str(cls.dir / "side.png"), view="side")
        make_figure(str(cls.dir / "back.png"), view="back")
        make_sheet(str(cls.dir / "sheet.png"))

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

    def test_expressions(self):
        for version in ("0", "1"):
            res = generate(Image.open(self.dir / "a.png"), Options(vrm_version=version))
            gltf, binary = parse_glb(res.vrm)
            face = next(m for m in gltf["meshes"] if m["name"] == "Face")
            prim = face["primitives"][0]
            self.assertEqual(len(prim["targets"]), 9)
            self.assertEqual(face["extras"]["targetNames"][:2], ["blinkLeft", "blinkRight"])
            # folded at rest: the closed-eye overlay has (almost) no height until its morph target opens it
            pos = read_accessor(gltf, binary, prim["attributes"]["POSITION"])
            delta = read_accessor(gltf, binary, prim["targets"][0]["POSITION"])
            moved = np.abs(delta).sum(1) > 0
            self.assertLess(np.ptp(pos[moved, 1]), 1e-6)
            self.assertGreater(np.ptp((pos + delta)[moved, 1]), 0.005)
            if version == "0":
                groups = {g["presetName"]: g for g in gltf["extensions"]["VRM"]["blendShapeMaster"]["blendShapeGroups"]}
                self.assertEqual(len(groups["blink"]["binds"]), 2)
                self.assertEqual(groups["a"]["binds"][0]["weight"], 100)
            else:
                presets = gltf["extensions"]["VRMC_vrm"]["expressions"]["preset"]
                self.assertTrue({"blink", "aa", "ih", "ou", "ee", "oh", "happy"} <= set(presets))
        res = generate(Image.open(self.dir / "a.png"), Options(expressions=False))
        gltf, _ = parse_glb(res.vrm)
        self.assertEqual([m["name"] for m in gltf["meshes"]], ["Body"])

    def test_face_boxes_found(self):
        res = generate(Image.open(self.dir / "a.png"), Options())
        lx0, ly0, lx1, ly1 = res.keypoints["left_eye_box"]
        self.assertTrue(lx0 < 330 < lx1 and ly0 < 97 < ly1)  # drawn eye: x 320-340, y 85-110
        rx0, _, rx1, _ = res.keypoints["right_eye_box"]
        self.assertTrue(rx0 < 270 < rx1)
        mx0, my0, mx1, my1 = res.keypoints["mouth_box"]
        self.assertTrue(mx0 < 300 < mx1 and my0 < 140 < my1)

    def test_back_and_side_views(self):
        img = Image.open(self.dir / "a.png")
        plain = parse_glb(generate(img, Options(vrm_version="1")).vrm)
        views = Views(back=Image.open(self.dir / "back.png"), sides=[(Image.open(self.dir / "side.png"), "auto")])
        res = generate(img, Options(vrm_version="1"), views=views)
        self.assertTrue(res.stats["back_view"])
        gltf, binary = parse_glb(res.vrm)
        self.assertEqual([m["name"] for m in gltf["materials"]], ["Front", "Back", "Face"])
        body = gltf["meshes"][0]["primitives"]
        self.assertEqual(body[1]["material"], 1)

        def depth_at(g, b, y):
            pos = read_accessor(g, b, g["meshes"][0]["primitives"][0]["attributes"]["POSITION"])
            sel = np.abs(pos[:, 1] - y) < 0.02
            return pos[sel, 2].max()
        # the drawn side view has a belly: the body gets deeper at belly height than without it
        self.assertGreater(depth_at(gltf, binary, 0.95), depth_at(*plain, 0.95) * 1.5)

    def test_side_profile_facing(self):
        side = Image.open(self.dir / "side.png")
        prof = side_profile(side, 1.6)
        front, back = prof.at(np.array([0.95]))
        self.assertGreater(front[0], back[0])  # belly in front
        flipped = side.transpose(Image.FLIP_LEFT_RIGHT)
        prof2 = side_profile(flipped, 1.6)
        self.assertAlmostEqual(float(prof2.at(np.array([0.95]))[0][0]), float(front[0]), delta=0.01)

    def test_sheet_split(self):
        figs = split_sheet(Image.open(self.dir / "sheet.png"))
        self.assertEqual([f["role"] for f in figs], ["front", "side", "back"])
        for f in figs:
            a = np.asarray(f["image"])
            figure = a[:, :, 3] > 127
            # no light background rim left on the figure (the white "7" on the back is ~1000 px)
            self.assertLess(((a[:, :, :3] >= 250).all(-1) & figure).sum(), 1100)
        out = self.dir / "sheet.vrm"
        self.assertEqual(main(["--sheet", str(self.dir / "sheet.png"), "-o", str(out)]), 0)
        gltf, _ = parse_glb(out.read_bytes())
        self.assertEqual(len(gltf["materials"]), 3)

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
