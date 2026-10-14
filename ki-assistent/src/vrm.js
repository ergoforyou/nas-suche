// 3D-Figur im VRM-Format (z. B. kostenlos erstellt mit VRoid Studio).
// Die Figur wird in eine eigene WebGL-Leinwand gezeichnet; der normale Avatar legt diese Leinwand dann
// wie ein Bild in seine Darstellung – Rahmen, Verschieben, Größe und Klick-Erkennung funktionieren dadurch
// genauso wie bei Bildern.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const smooth = (cur, target, k) => cur + (target - cur) * k;

/**
 * @param {Document} doc Dokument des Fensters, in dem gezeichnet wird
 * @param {string} url Adresse der .vrm-Datei
 * @param {{width?: number, height?: number}} size Größe der Zeichenfläche
 */
export async function createVrmFigure(doc, url, { width = 820, height = 900 } = {}) {
  const canvas = doc.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(0.6, 1.2, 1.5);
  scene.add(key, new THREE.AmbientLight(0xffffff, 1.1));

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error('Die Datei ist keine VRM-Figur.');
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm); // ältere VRM-0-Figuren schauen sonst nach hinten
  vrm.scene.traverse((o) => (o.frustumCulled = false));
  scene.add(vrm.scene);

  const bone = (name) => vrm.humanoid?.getNormalizedBoneNode(name) ?? null;
  const B = {
    head: bone('head'),
    neck: bone('neck'),
    spine: bone('spine'),
    chest: bone('chest') ?? bone('upperChest'),
    hips: bone('hips'),
    lUpper: bone('leftUpperArm'),
    rUpper: bone('rightUpperArm'),
    lLower: bone('leftLowerArm'),
    rLower: bone('rightLowerArm'),
  };
  // Aus der T-Pose: Arme locker nach unten, Ellbogen leicht gebeugt
  const restArms = () => {
    if (B.lUpper) B.lUpper.rotation.z = -1.15;
    if (B.rUpper) B.rUpper.rotation.z = 1.15;
    if (B.lLower) B.lLower.rotation.z = -0.15;
    if (B.rLower) B.rLower.rotation.z = 0.15;
  };
  restArms();
  vrm.update(0);

  // Kamera: Brustbild (Hüfte bis etwas über den Kopf)
  vrm.scene.updateMatrixWorld(true);
  const pos = (o, fallback) => (o ? o.getWorldPosition(new THREE.Vector3()) : fallback);
  const headPos = pos(B.head, new THREE.Vector3(0, 1.4, 0));
  const hipsPos = pos(B.hips, new THREE.Vector3(0, headPos.y * 0.6, 0));
  const top = headPos.y + 0.22;
  const bottom = hipsPos.y + (headPos.y - hipsPos.y) * 0.05;
  const fov = 22;
  const camera = new THREE.PerspectiveCamera(fov, width / height, 0.1, 50);
  const span = top - bottom;
  const dist = span / 2 / Math.tan(THREE.MathUtils.degToRad(fov / 2)) * 1.04;
  const centerY = (top + bottom) / 2;
  camera.position.set(0, centerY, headPos.z + dist);
  camera.lookAt(0, centerY, headPos.z);

  // Blick folgt leicht der Kamera
  if (vrm.lookAt) {
    vrm.lookAt.target = camera;
    vrm.lookAt.autoUpdate = true;
  }

  const S = { t: 0, look: 0, nod: 0, tilt: 0, lookT: 0, nodT: 0, tiltT: 0, next: 0, aa: 0, oh: 0, smile: 0 };
  let last = performance.now();
  const has = (name) => !!vrm.expressionManager?.getExpression(name);
  const setExpr = (name, v) => has(name) && vrm.expressionManager.setValue(name, v);

  /**
   * Ein Bild zeichnen.
   * st: { speaking, thinking, listening, open (0..1 Mundöffnung), blink (0..1), motion, idleHead }
   */
  function render(st) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    S.t += dt;
    const m = st.motion ?? 1;
    const idle = st.idleHead ?? 0.25;

    // Kopf: Ziele je nach Zustand, weich angefahren
    if (st.thinking) {
      S.lookT = 0.12;
      S.nodT = -0.12;
      S.tiltT = 0.12;
    } else if (st.listening) {
      S.lookT = 0;
      S.nodT = 0.06;
      S.tiltT = -0.08;
    } else if (now > S.next) {
      const g = st.speaking ? 1 : idle;
      S.lookT = (Math.random() - 0.5) * 0.35 * g;
      S.nodT = (Math.random() - 0.5) * 0.12 * g;
      S.tiltT = (Math.random() - 0.5) * 0.12 * g;
      S.next = now + (st.speaking ? 900 + Math.random() * 1300 : 2500 + Math.random() * 3500);
    }
    const k = Math.min(1, dt * (st.speaking ? 4 : 1.6));
    S.look = smooth(S.look, S.lookT, k);
    S.nod = smooth(S.nod, S.nodT, k);
    S.tilt = smooth(S.tilt, S.tiltT, k);
    const talkBob = st.speaking ? Math.sin(S.t * 7) * 0.025 * st.open : 0;
    if (B.head) {
      B.head.rotation.y = S.look * 0.6 * m;
      B.head.rotation.x = (S.nod + talkBob) * 0.6 * m;
      B.head.rotation.z = S.tilt * 0.6 * m;
    }
    if (B.neck) {
      B.neck.rotation.y = S.look * 0.4 * m;
      B.neck.rotation.x = S.nod * 0.4 * m;
      B.neck.rotation.z = S.tilt * 0.4 * m;
    }
    // Atmen und leichtes Wiegen
    const breathe = Math.sin(S.t * 1.6) * 0.018 * m;
    if (B.chest) B.chest.rotation.x = breathe;
    if (B.spine) {
      B.spine.rotation.x = (st.listening ? 0.05 : 0) * m;
      B.spine.rotation.z = Math.sin(S.t * 0.5) * 0.015 * m;
    }
    if (B.hips) B.hips.rotation.y = Math.sin(S.t * 0.35) * 0.02 * m;
    restArms();
    if (B.lUpper) B.lUpper.rotation.z += Math.sin(S.t * 1.6) * 0.012 * m;
    if (B.rUpper) B.rUpper.rotation.z -= Math.sin(S.t * 1.6 + 0.4) * 0.012 * m;

    // Mund: „aa“ folgt der Lautstärke, dazu etwas „oh“ für Abwechslung
    const open = st.speaking ? st.open : 0;
    S.aa = smooth(S.aa, open, 0.5);
    S.oh = smooth(S.oh, st.speaking ? open * (0.5 + 0.5 * Math.sin(S.t * 5.3)) * 0.4 : 0, 0.3);
    setExpr('aa', Math.min(1, S.aa * 1.1));
    setExpr('oh', S.oh);
    // freundlicher Grundausdruck, beim Sprechen etwas mehr
    S.smile = smooth(S.smile, st.speaking ? 0.25 : st.thinking ? 0 : 0.12, 0.05);
    setExpr('relaxed', S.smile);
    setExpr('blink', st.blink ?? 0);

    vrm.update(dt);
    renderer.render(scene, camera);
    return canvas;
  }

  function dispose() {
    scene.remove(vrm.scene);
    VRMUtils.deepDispose(vrm.scene);
    renderer.dispose();
    renderer.forceContextLoss?.();
  }

  return { canvas, width, height, render, dispose, url };
}
