import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Fullscreen pastel 3D-scen för login-sidan: kromsfär som svävar över en
// glansig ringpodium på kaklat golv, snurrande mynt och mjuka tygvågor.
// Ren presentation — ingen data, inga API-anrop, pointer-events avstängda.

function makeFloorTexture() {
  const size = 2048;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const base = ctx.createLinearGradient(0, 0, size, size);
  base.addColorStop(0, '#cfe3f4');
  base.addColorStop(0.5, '#c2dbf0');
  base.addColorStop(1, '#c9d7f2');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // Kakelplattor med svagt varierad ton + ljusa fogar
  const tile = 256;
  for (let y = 0; y < size; y += tile) {
    for (let x = 0; x < size; x += tile) {
      const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const n = (v - Math.floor(v)) * 0.05 - 0.025;
      ctx.fillStyle = `rgba(255,255,255,${Math.max(0, n)})`;
      ctx.fillRect(x, y, tile, tile);
      ctx.fillStyle = `rgba(120,150,200,${Math.max(0, -n)})`;
      ctx.fillRect(x, y, tile, tile);
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 3;
  for (let p = 0; p <= size; p += tile) {
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  texture.anisotropy = 4;
  return texture;
}

function makeGrooveTextures() {
  // Vertikala spår (meridianer) på kromsfären
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1024, 512);
  const grooves = 5;
  for (let i = 0; i < grooves; i += 1) {
    const x = (i + 0.5) * (1024 / grooves);
    const grad = ctx.createLinearGradient(x - 14, 0, x + 14, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.35, 'rgba(40,45,60,0.85)');
    grad.addColorStop(0.5, 'rgba(20,22,32,0.95)');
    grad.addColorStop(0.65, 'rgba(40,45,60,0.85)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - 14, 0, 28, 512);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.wrapS = THREE.RepeatWrapping;
  return map;
}

function makeBlobShadowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(128, 128, 10, 128, 128, 120);
  grad.addColorStop(0, 'rgba(40,60,110,0.4)');
  grad.addColorStop(0.6, 'rgba(40,60,110,0.16)');
  grad.addColorStop(1, 'rgba(40,60,110,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}

function makeWaveTexture() {
  // Fina konturlinjer som ger tyg-/dynkänslan
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#cfe0f5';
  ctx.fillRect(0, 0, 1024, 1024);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.4;
  for (let y = 0; y < 1024; y += 7) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(1024, y);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 3);
  return texture;
}

function buildTrackCurve() {
  // Bana från övre vänstra hörnet som viker av och lindar sig runt ringen
  const points = [];
  points.push(new THREE.Vector3(-16, 0, -14));
  points.push(new THREE.Vector3(-9, 0, -8.5));
  points.push(new THREE.Vector3(-6.2, 0, -4.2));
  const radius = 3.35;
  for (let a = 205; a >= -75; a -= 14) {
    const rad = (a * Math.PI) / 180;
    points.push(new THREE.Vector3(Math.cos(rad) * radius, 0, Math.sin(rad) * radius));
  }
  return new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.12);
}

export default function LoginBackground3D() {
  const mountRef = useRef(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
    } catch (err) {
      return undefined; // WebGL saknas — CSS-gradienten bakom får ligga kvar
    }

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#bdd7ec');
    scene.fog = new THREE.Fog('#c3dcf0', 16, 34);

    const camera = new THREE.PerspectiveCamera(36, mount.clientWidth / mount.clientHeight, 0.1, 60);
    camera.position.set(0.8, 6.4, 9.6);
    camera.lookAt(0.2, 0.4, -0.4);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTexture;

    // Ljus: mjukt kallt huvudljus + rosa och cyan accenter (iridiscens-känslan)
    scene.add(new THREE.AmbientLight('#dfeaff', 0.7));
    const keyLight = new THREE.DirectionalLight('#ffffff', 1.15);
    keyLight.position.set(-4, 9, 6);
    scene.add(keyLight);
    const pinkLight = new THREE.PointLight('#ff9ad5', 22, 14);
    pinkLight.position.set(3.4, 1.4, 2.6);
    scene.add(pinkLight);
    const cyanLight = new THREE.PointLight('#8fe4ff', 16, 14);
    cyanLight.position.set(-3.6, 1.8, 1.2);
    scene.add(cyanLight);

    const disposables = [];
    const track = (resource) => { disposables.push(resource); return resource; };

    // Golv
    const floorTexture = track(makeFloorTexture());
    const floorMaterial = track(new THREE.MeshStandardMaterial({
      map: floorTexture, roughness: 0.32, metalness: 0.05, envMapIntensity: 0.8,
    }));
    const floor = new THREE.Mesh(track(new THREE.PlaneGeometry(80, 80)), floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    // Glansigt banmaterial (delas av ring och bana)
    const glossMaterial = track(new THREE.MeshPhysicalMaterial({
      color: '#dcebfa', roughness: 0.18, metalness: 0.1,
      clearcoat: 1, clearcoatRoughness: 0.25, envMapIntensity: 1.1,
    }));

    // Ringpodium: platt donut med rundade kanter
    const ringShape = new THREE.Shape();
    ringShape.absarc(0, 0, 2.65, 0, Math.PI * 2, false);
    const ringHole = new THREE.Path();
    ringHole.absarc(0, 0, 1.75, 0, Math.PI * 2, true);
    ringShape.holes.push(ringHole);
    const ringGeometry = track(new THREE.ExtrudeGeometry(ringShape, {
      depth: 0.14, bevelEnabled: true, bevelThickness: 0.09, bevelSize: 0.09, bevelSegments: 5, curveSegments: 72,
    }));
    const ring = new THREE.Mesh(ringGeometry, glossMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    scene.add(ring);

    // Nedsänkt innercirkel med rosa/blå skimmer
    const recessMaterial = track(new THREE.MeshPhysicalMaterial({
      color: '#b9cdf0', roughness: 0.12, metalness: 0.25,
      clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 1.4,
    }));
    const recess = new THREE.Mesh(track(new THREE.CircleGeometry(1.75, 64)), recessMaterial);
    recess.rotation.x = -Math.PI / 2;
    recess.position.y = 0.035;
    scene.add(recess);

    // Bana som lindar sig runt ringen
    const trackGeometry = track(new THREE.TubeGeometry(buildTrackCurve(), 220, 0.62, 24, false));
    const trackMesh = new THREE.Mesh(trackGeometry, glossMaterial);
    trackMesh.scale.y = 0.32;
    trackMesh.position.y = 0.1;
    scene.add(trackMesh);

    // Kromsfär med vertikala spår
    const grooveMap = track(makeGrooveTextures());
    const sphereMaterial = track(new THREE.MeshStandardMaterial({
      color: '#ffffff', map: grooveMap, metalness: 1, roughness: 0.08, envMapIntensity: 1.5,
    }));
    const sphere = new THREE.Mesh(track(new THREE.SphereGeometry(1.05, 96, 64)), sphereMaterial);
    scene.add(sphere);

    // Mynt som flippar ovanför sfären
    const coinGroup = new THREE.Group();
    const coinMaterial = track(new THREE.MeshStandardMaterial({
      color: '#f4f6fb', metalness: 1, roughness: 0.14, envMapIntensity: 1.4,
    }));
    const coin = new THREE.Mesh(track(new THREE.CylinderGeometry(0.52, 0.52, 0.09, 56)), coinMaterial);
    const coinRim = new THREE.Mesh(track(new THREE.TorusGeometry(0.52, 0.045, 12, 56)), coinMaterial);
    coinRim.rotation.x = Math.PI / 2;
    const coinInset = new THREE.Mesh(track(new THREE.CylinderGeometry(0.4, 0.4, 0.095, 48)), track(new THREE.MeshStandardMaterial({
      color: '#dfe5f0', metalness: 1, roughness: 0.25, envMapIntensity: 1.2,
    })));
    coinGroup.add(coin, coinRim, coinInset);
    scene.add(coinGroup);

    // Mjuk skugga under sfären
    const shadowTexture = track(makeBlobShadowTexture());
    const shadowMaterial = track(new THREE.MeshBasicMaterial({
      map: shadowTexture, transparent: true, depthWrite: false,
    }));
    const blobShadow = new THREE.Mesh(track(new THREE.PlaneGeometry(3.2, 3.2)), shadowMaterial);
    blobShadow.rotation.x = -Math.PI / 2;
    blobShadow.position.y = 0.045;
    scene.add(blobShadow);

    // Tygvågor i bakgrunden (höger sida, som i förlagan)
    const waveTexture = track(makeWaveTexture());
    const waveMaterial = track(new THREE.MeshStandardMaterial({
      map: waveTexture, roughness: 0.55, metalness: 0, envMapIntensity: 0.6,
    }));
    const makeWave = (width, height, segments) => {
      const geometry = track(new THREE.PlaneGeometry(width, height, segments, segments));
      const mesh = new THREE.Mesh(geometry, waveMaterial);
      mesh.rotation.x = -Math.PI / 2;
      return mesh;
    };
    const waveBack = makeWave(26, 18, 90);
    waveBack.position.set(10, 0.05, -9);
    scene.add(waveBack);
    const waveFront = makeWave(20, 12, 80);
    waveFront.position.set(9, 0.04, 8.5);
    scene.add(waveFront);

    const displaceWave = (mesh, time, amp, freq, phase) => {
      const position = mesh.geometry.attributes.position;
      for (let i = 0; i < position.count; i += 1) {
        const x = position.getX(i);
        const y = position.getY(i);
        const d = Math.sqrt(x * x + y * y);
        position.setZ(i, Math.sin(d * freq - time * 0.4 + phase) * amp * Math.min(1, d / 6));
      }
      position.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
    };

    let rafId = 0;
    let running = true;
    const clock = new THREE.Clock();

    const renderFrame = () => {
      const t = clock.getElapsedTime();

      // Sfär: mjuk studs + långsam rotation
      const bounce = Math.abs(Math.sin(t * 1.05));
      sphere.position.y = 1.45 + bounce * 0.75;
      sphere.rotation.y = t * 0.35;

      // Mynt: flippar och svävar ovanför sfären
      coinGroup.position.set(-0.15, sphere.position.y + 1.9 + Math.sin(t * 0.9 + 1.2) * 0.18, -0.1);
      coinGroup.rotation.x = t * 1.1;
      coinGroup.rotation.z = 0.35;

      // Skuggan följer studsen
      const shadowScale = 1.15 - bounce * 0.3;
      blobShadow.scale.setScalar(shadowScale);
      shadowMaterial.opacity = 0.95 - bounce * 0.45;

      displaceWave(waveBack, t, 0.5, 0.9, 0);
      displaceWave(waveFront, t, 0.35, 1.1, 2.1);

      renderer.render(scene, camera);
    };

    const animate = () => {
      if (!running) return;
      renderFrame();
      rafId = window.requestAnimationFrame(animate);
    };

    const onResize = () => {
      const { clientWidth, clientHeight } = mount;
      if (!clientWidth || !clientHeight) return;
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(clientWidth, clientHeight);
      if (reducedMotion) renderFrame();
    };
    window.addEventListener('resize', onResize);

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        window.cancelAnimationFrame(rafId);
      } else if (!reducedMotion && !running) {
        running = true;
        clock.getDelta();
        animate();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    if (reducedMotion) {
      running = false;
      renderFrame();
    } else {
      animate();
    }

    return () => {
      running = false;
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      disposables.forEach((resource) => resource.dispose?.());
      envTexture.dispose();
      pmrem.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div
      ref={mountRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
        background: 'linear-gradient(135deg, #c8e0f2 0%, #bdd7ec 55%, #cdd6f4 100%)',
      }}
    />
  );
}
