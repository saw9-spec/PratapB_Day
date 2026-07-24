/* ================================================================
   HAPPY BIRTHDAY — INTERACTIVE 3D EXPERIENCE
   ================================================================
   File map:
     1. CONFIG          — edit names/roles/messages here
     2. STATE & FLAGS
     3. UTILITIES
     4. SHADERS
     5. THREE.JS SCENE  — hero object, particle burst, ambient dust
     6. EXPLOSION SEQUENCE / KINETIC TYPE REVEAL
     7. MESSAGE CARDS   — render + tilt + scroll reveal
     8. CUSTOM CURSOR
     9. MAGNETIC BUTTONS
    10. SCROLL EFFECTS (safe, scrub-based — see note near the bottom)
    11. INIT

   Note on module loading: this file is loaded as
   <script type="module">, because three.js has been ES-module-only
   since r161 (the old global build was removed upstream). That means
   this file must be served over http(s), not opened directly via
   file:// — see the comment in index.html for a one-line local
   server command.
   ================================================================ */

import * as THREE from 'three';

/* ================================================================
   1. CONFIG — the only section you should need to touch to make
      this your own.
   ================================================================ */
const CONFIG = {
  // The person celebrating their birthday. Drives the page title
  // and the big kinetic reveal text.
  name: 'Pratap',

  // Messages from the team. Add, remove, or edit freely — the grid
  // automatically lays out however many entries you provide.
  messages: [
    {
      name: 'Team INTL',
      role: '& Saurabh',
      message: "生日快乐, Pratap! (🏮The Maratha Mandarin!🏮) It takes a true expert to handle complex Chinese language testing without breaking a sweat. We love that you are as 'RICH' in heart as you are in talent, yet never feel the need to flex your superpowers. Hope you have an amazing birthday (and maybe a winning game of table tennis)!",
    },
  ],
};

/* ================================================================
   2. STATE & FLAGS
   ================================================================ */
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isFinePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

const CAMERA_REST_Z = 5.2;
const CAMERA_CLOSE_Z = 2.4;
const CAMERA_SETTLE_Z = 4.2;

let scene, camera, renderer, canvas, clock, raycaster;
let heroMesh, heroMaterial;
let fragmentMesh, fragmentData, fragmentsElapsed = 0;
let dustPoints;

let hasExploded = false;
let hoverIntensity = 0;
let idleRotation = 0;
let pointerNormX = 0;
let pointerNormY = 0;
const pointerNDC = new THREE.Vector2();

let heroChars = null;
let fontsReady = false;

let unwrapCta, eyebrowEl, scrollCueEl;

let customCursorEnabled = false;
let cursorDot, cursorRing;
let cursorTargetX = window.innerWidth / 2;
let cursorTargetY = window.innerHeight / 2;
let cursorRingX = cursorTargetX;
let cursorRingY = cursorTargetY;

/* ================================================================
   3. UTILITIES
   ================================================================ */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// A cheap "spring toward target" integrator — smoother and a little
// more organic than a plain lerp for the mouse-follow motion.
class Spring {
  constructor(stiffness = 0.08, damping = 0.82) {
    this.value = 0;
    this.target = 0;
    this.velocity = 0;
    this.stiffness = stiffness;
    this.damping = damping;
  }
  update() {
    const force = (this.target - this.value) * this.stiffness;
    this.velocity = (this.velocity + force) * this.damping;
    this.value += this.velocity;
    return this.value;
  }
}

const tiltX = new Spring(0.06, 0.85);
const tiltY = new Spring(0.06, 0.85);
const parallaxX = new Spring(0.05, 0.85);
const parallaxY = new Spring(0.05, 0.85);

// Generates a soft radial-gradient sprite on the fly, so the dust
// particles render as soft glows instead of harsh squares — no
// external image asset needed.
function createCircleTexture() {
  const size = 64;
  const canvasEl = document.createElement('canvas');
  canvasEl.width = size;
  canvasEl.height = size;
  const ctx = canvasEl.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvasEl);
}

/* ================================================================
   4. SHADERS
   The hero object uses a hand-rolled value-noise displacement
   (deliberately simple trilinear value noise rather than a dense
   simplex-noise implementation, since it's easy to verify by eye
   and plenty organic for this use) plus a view-space fresnel rim
   glow. Both are standard, generic small-scale techniques.
   ================================================================ */
const HERO_VERTEX_SHADER = `
  uniform float uTime;
  uniform float uHoverIntensity;
  uniform float uDisplacementStrength;

  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying float vDisplacement;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float valueNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float n000 = hash(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash(i + vec3(1.0, 1.0, 1.0));

    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);

    float nxy0 = mix(nx00, nx10, f.y);
    float nxy1 = mix(nx01, nx11, f.y);

    return mix(nxy0, nxy1, f.z);
  }

  float fbm(vec3 p) {
    float value = 0.0;
    float amplitude = 0.6;
    float freq = 1.0;
    for (int i = 0; i < 3; i++) {
      value += amplitude * valueNoise(p * freq);
      freq *= 2.0;
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    vNormal = normalize(normalMatrix * normal);

    float n = fbm(position * 1.4 + vec3(0.0, 0.0, uTime * 0.25));
    float displacement = (n - 0.5) * uDisplacementStrength * (1.0 + uHoverIntensity * 1.8);
    vDisplacement = displacement;

    vec3 displaced = position + normal * displacement;

    vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
    vViewPosition = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const HERO_FRAGMENT_SHADER = `
  uniform vec3 uColor;
  uniform vec3 uGlowColor;
  uniform float uHoverIntensity;

  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying float vDisplacement;

  void main() {
    vec3 viewDir = normalize(vViewPosition);
    vec3 normal = normalize(vNormal);
    float fresnel = pow(1.0 - max(dot(viewDir, normal), 0.0), 2.2);

    vec3 base = uColor + vDisplacement * 0.6;
    vec3 glow = uGlowColor * fresnel * (1.1 + uHoverIntensity * 1.6);

    gl_FragColor = vec4(base + glow, 1.0);
  }
`;

/* ================================================================
   5. THREE.JS SCENE
   ================================================================ */
function initThree() {
  canvas = document.getElementById('hero-canvas');

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, CAMERA_REST_Z);

  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  raycaster = new THREE.Raycaster();
  clock = new THREE.Clock();

  // --- Hero object: a faceted gem/energy-core, the thing you "unwrap" ---
  const geometry = new THREE.IcosahedronGeometry(1.15, 2);
  heroMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uHoverIntensity: { value: 0 },
      uDisplacementStrength: { value: 0.22 },
      uColor: { value: new THREE.Color(0x14131c) },
      uGlowColor: { value: new THREE.Color(0xe8c27a) },
    },
    vertexShader: HERO_VERTEX_SHADER,
    fragmentShader: HERO_FRAGMENT_SHADER,
  });
  heroMesh = new THREE.Mesh(geometry, heroMaterial);
  scene.add(heroMesh);

  initFragments();
  initDust();
}

// --- Explosion fragments: an InstancedMesh, set up once and re-armed
//     each time the hero object is clicked. Cheap (CPU-updated matrices
//     for ~90 instances is trivial for any modern device). ---
const FRAGMENT_COUNT = 90;
const dummyObject = new THREE.Object3D();
const fragmentColorA = new THREE.Color(0xe8c27a);
const fragmentColorB = new THREE.Color(0xd1665c);

function initFragments() {
  const geometry = new THREE.OctahedronGeometry(0.085, 0);
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  fragmentMesh = new THREE.InstancedMesh(geometry, material, FRAGMENT_COUNT);
  fragmentMesh.visible = false;
  // Fragments travel well outside the geometry's rest-pose bounding
  // sphere, so disable frustum culling to avoid them popping out early.
  fragmentMesh.frustumCulled = false;
  scene.add(fragmentMesh);

  fragmentData = Array.from({ length: FRAGMENT_COUNT }, () => ({
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    rotation: new THREE.Euler(),
    rotationSpeed: new THREE.Vector3(),
    scale: 1,
  }));
}

function spawnFragments() {
  fragmentMesh.visible = true;
  fragmentsElapsed = 0;

  for (let i = 0; i < FRAGMENT_COUNT; i++) {
    const d = fragmentData[i];
    const dir = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();

    d.position.copy(dir).multiplyScalar(1.05);
    const speed = 1.4 + Math.random() * 2.6;
    d.velocity.copy(dir).multiplyScalar(speed);
    d.velocity.y += 0.7; // slight upward bias for a nicer "burst" arc

    d.rotationSpeed.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6);
    d.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    d.scale = 0.5 + Math.random() * 1.1;

    const mixedColor = fragmentColorA.clone().lerp(fragmentColorB, Math.random());
    fragmentMesh.setColorAt(i, mixedColor);
  }
  if (fragmentMesh.instanceColor) fragmentMesh.instanceColor.needsUpdate = true;
}

function updateFragments(delta) {
  if (!fragmentMesh.visible) return;

  fragmentsElapsed += delta;
  const fadeStart = 1.1;
  const fadeEnd = 1.9;

  for (let i = 0; i < FRAGMENT_COUNT; i++) {
    const d = fragmentData[i];
    d.velocity.y -= 1.3 * delta; // gravity
    d.velocity.multiplyScalar(0.985); // drag
    d.position.addScaledVector(d.velocity, delta);

    d.rotation.x += d.rotationSpeed.x * delta;
    d.rotation.y += d.rotationSpeed.y * delta;
    d.rotation.z += d.rotationSpeed.z * delta;

    dummyObject.position.copy(d.position);
    dummyObject.rotation.copy(d.rotation);
    const fade = 1 - clamp((fragmentsElapsed - fadeStart) / (fadeEnd - fadeStart), 0, 1);
    dummyObject.scale.setScalar(d.scale * fade);
    dummyObject.updateMatrix();
    fragmentMesh.setMatrixAt(i, dummyObject.matrix);
  }
  fragmentMesh.instanceMatrix.needsUpdate = true;

  if (fragmentsElapsed > fadeEnd) {
    fragmentMesh.visible = false;
  }
}

// --- Ambient dust: a small, cheap Points cloud for depth ---
function initDust() {
  const count = 240;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const radius = 3.5 + Math.random() * 5.5;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    size: 0.045,
    map: createCircleTexture(),
    transparent: true,
    opacity: 0.3,
    color: 0xd9c9a8,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });

  dustPoints = new THREE.Points(geometry, material);
  scene.add(dustPoints);
}

function onPointerMove(e) {
  const point = e.touches ? e.touches[0] : e;
  if (!point) return;
  pointerNormX = (point.clientX / window.innerWidth) * 2 - 1;
  pointerNormY = (point.clientY / window.innerHeight) * 2 - 1;
  pointerNDC.x = pointerNormX;
  pointerNDC.y = -pointerNormY;

  cursorTargetX = point.clientX;
  cursorTargetY = point.clientY;
}

function onCanvasClick() {
  if (hasExploded) return;
  raycaster.setFromCamera(pointerNDC, camera);
  const intersects = raycaster.intersectObject(heroMesh);
  if (intersects.length > 0) {
    startExplosionSequence();
  }
}

function onResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05); // clamp so a backgrounded tab can't cause a huge jump

  if (heroMesh.visible) {
    raycaster.setFromCamera(pointerNDC, camera);
    const isHovering = raycaster.intersectObject(heroMesh).length > 0;
    hoverIntensity = lerp(hoverIntensity, isHovering ? 1 : 0, 0.08);

    heroMaterial.uniforms.uTime.value += delta;
    heroMaterial.uniforms.uHoverIntensity.value = hoverIntensity;

    const spinMultiplier = 1 + hoverIntensity * 2.2;
    idleRotation += delta * 0.18 * spinMultiplier;

    tiltX.target = pointerNormY * 0.35;
    tiltY.target = pointerNormX * 0.5;
    tiltX.update();
    tiltY.update();

    heroMesh.rotation.x = tiltX.value;
    heroMesh.rotation.y = idleRotation + tiltY.value;
  }

  parallaxX.target = pointerNormX * 0.25;
  parallaxY.target = -pointerNormY * 0.15;
  parallaxX.update();
  parallaxY.update();
  camera.position.x = parallaxX.value;
  camera.position.y = parallaxY.value;
  camera.lookAt(0, 0, 0);

  updateFragments(delta);
  if (dustPoints) dustPoints.rotation.y += delta * 0.015;

  updateCustomCursor();

  renderer.render(scene, camera);
}

/* ================================================================
   6. EXPLOSION SEQUENCE / KINETIC TYPE REVEAL
   ================================================================ */
function startExplosionSequence() {
  if (prefersReducedMotion) triggerExplosionReduced();
  else triggerExplosion();
}

function triggerExplosion() {
  if (hasExploded) return;
  hasExploded = true;
  unwrapCta.disabled = true;

  const tl = gsap.timeline();

  tl.to(unwrapCta, { opacity: 0, y: 16, duration: 0.4, ease: 'power2.in' }, 0)
    .to(eyebrowEl, { opacity: 0, y: 16, duration: 0.4, ease: 'power2.in' }, 0)
    .to(heroMaterial.uniforms.uHoverIntensity, { value: 3, duration: 0.5, ease: 'power2.in' }, 0)
    .to(heroMesh.scale, { x: 0.001, y: 0.001, z: 0.001, duration: 0.45, ease: 'power3.in' }, 0.05)
    .call(() => {
      spawnFragments();
      heroMesh.visible = false;
    }, null, 0.5)
    .to(camera.position, { z: CAMERA_CLOSE_Z, duration: 1.0, ease: 'power3.inOut' }, 0.35)
    .to(camera.position, { z: CAMERA_SETTLE_Z, duration: 1.1, ease: 'power2.out' }, 1.35)
    .call(() => revealBirthdayMessage(), null, 1.15)
    .to(scrollCueEl, { opacity: 1, duration: 0.8, ease: 'power2.out' }, 2.6);
}

// A calmer fallback for prefers-reduced-motion: no particle burst,
// no camera dolly, just a quick cross-fade into the message.
function triggerExplosionReduced() {
  if (hasExploded) return;
  hasExploded = true;
  unwrapCta.disabled = true;

  gsap.to(unwrapCta, { opacity: 0, duration: 0.3 });
  gsap.to(eyebrowEl, { opacity: 0, duration: 0.3 });
  gsap.to(heroMesh.scale, { x: 0.001, y: 0.001, z: 0.001, duration: 0.3 });
  gsap.delayedCall(0.3, () => {
    heroMesh.visible = false;
    revealBirthdayMessage(true);
  });
  gsap.to(scrollCueEl, { opacity: 1, duration: 0.4, delay: 0.9 });
}

function prepareHeroText() {
  document.fonts.ready.then(() => {
    const headingEl = document.getElementById('birthday-heading');
    const split = SplitText.create(headingEl, {
      type: 'words, chars',
      mask: 'chars',
      charsClass: 'char',
    });
    heroChars = split.chars;
    gsap.set(heroChars, { yPercent: 130 });
    gsap.set(headingEl, { opacity: 1 }); // safe to reveal now — chars are masked off-screen
    fontsReady = true;
  });
}

function revealBirthdayMessage(instant = false) {
  const runReveal = () => {
    gsap.to(heroChars, {
      yPercent: 0,
      duration: instant ? 0.5 : 1.15,
      ease: instant ? 'power2.out' : 'power4.out',
      stagger: instant ? 0 : 0.025,
    });
  };

  if (fontsReady && heroChars) {
    runReveal();
  } else {
    // Extremely unlikely in practice (fonts.ready resolves well before
    // a user can read the hero and click), but keeps this correct.
    document.fonts.ready.then(() => {
      if (heroChars) runReveal();
    });
  }
}

/* ================================================================
   7. MESSAGE CARDS
   ================================================================ */
function renderMessageCards() {
  const grid = document.getElementById('wishes-grid');
  if (!grid) return;

  CONFIG.messages.forEach((entry) => {
    const card = document.createElement('article');
    card.className = 'glass-card';
    card.setAttribute('data-tilt', '');

    const initials = entry.name
      .split(' ')
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();

    card.innerHTML = `
      <div class="glass-card__avatar" aria-hidden="true">${initials}</div>
      <p class="glass-card__message">${entry.message}</p>
      <div class="glass-card__meta">
        <p class="glass-card__name">${entry.name}</p>
        <p class="glass-card__role">${entry.role}</p>
      </div>
    `;
    grid.appendChild(card);
  });
}

function initCardTilt() {
  if (prefersReducedMotion) return;
  const cards = document.querySelectorAll('[data-tilt]');
  if (!cards.length || typeof VanillaTilt === 'undefined') return;

  VanillaTilt.init(cards, {
    max: 10,
    speed: 500,
    glare: true,
    'max-glare': 0.25,
    perspective: 900,
    scale: 1.02,
    gyroscope: true,
  });
}

function initCardScrollReveal() {
  const cards = gsap.utils.toArray('.glass-card');
  cards.forEach((card, i) => {
    gsap.from(card, {
      opacity: 0,
      y: 40,
      duration: 0.9,
      ease: 'power3.out',
      delay: (i % 3) * 0.08,
      scrollTrigger: {
        trigger: card,
        start: 'top 88%',
        toggleActions: 'play none none reverse',
      },
    });
  });
}

/* ================================================================
   8. CUSTOM CURSOR
   Position updates happen inside the main animate() loop (see
   updateCustomCursor below) rather than a second requestAnimationFrame
   loop, to keep everything on a single render tick.
   ================================================================ */
function initCustomCursor() {
  cursorDot = document.querySelector('.cursor-dot');
  cursorRing = document.querySelector('.cursor-ring');
  if (!cursorDot || !cursorRing) return;

  customCursorEnabled = true;
  document.body.classList.add('custom-cursor-active');

  const hoverTargets = document.querySelectorAll('[data-cursor], .glass-card');
  hoverTargets.forEach((el) => {
    el.addEventListener('mouseenter', () => {
      cursorDot.classList.add('is-active');
      cursorRing.classList.add('is-active');
    });
    el.addEventListener('mouseleave', () => {
      cursorDot.classList.remove('is-active');
      cursorRing.classList.remove('is-active');
    });
  });
}

function updateCustomCursor() {
  if (!customCursorEnabled) return;
  cursorRingX = lerp(cursorRingX, cursorTargetX, 0.18);
  cursorRingY = lerp(cursorRingY, cursorTargetY, 0.18);
  cursorDot.style.transform = `translate3d(${cursorTargetX}px, ${cursorTargetY}px, 0) translate(-50%, -50%)`;
  cursorRing.style.transform = `translate3d(${cursorRingX}px, ${cursorRingY}px, 0) translate(-50%, -50%)`;
}

/* ================================================================
   9. MAGNETIC BUTTONS
   ================================================================ */
function applyMagnetic(el, strength = 0.35) {
  if (!el || prefersReducedMotion || !isFinePointer) return;

  const xTo = gsap.quickTo(el, 'x', { duration: 0.5, ease: 'power3.out' });
  const yTo = gsap.quickTo(el, 'y', { duration: 0.5, ease: 'power3.out' });

  el.addEventListener('mousemove', (e) => {
    const rect = el.getBoundingClientRect();
    const relX = e.clientX - (rect.left + rect.width / 2);
    const relY = e.clientY - (rect.top + rect.height / 2);
    xTo(relX * strength);
    yTo(relY * strength);
  });

  el.addEventListener('mouseleave', () => {
    xTo(0);
    yTo(0);
  });
}

/* ================================================================
   10. SCROLL EFFECTS
   Deliberately NOT a fully hijacked "fake scroll" (overflow:hidden +
   transform + ScrollTrigger.scrollerProxy). That pattern is powerful
   but easy to get subtly wrong (pin desync, double-scroll, trapped
   scroll on failure) — a bad tradeoff for a piece of chrome. Native
   scroll stays the source of truth; GSAP's own `scrub` option gives
   a genuinely smooth, weighty lag on the ambient glows, which is
   where the "fluid scroll" feeling actually reads the most anyway.
   Want literal momentum-scroll hijacking on top of this? Layering in
   Lenis (https://lenis.darkroom.engineering/) is the standard way.
   ================================================================ */
function initScrollEffects() {
  if (prefersReducedMotion) return;

  // Target the wrapper layer, not the glow element itself — the glow
  // element already owns its `transform` via a CSS keyframe animation
  // (the idle drift), and a CSS animation always wins the cascade over
  // an inline style on the same property/element, which would have
  // silently swallowed this scrub tween if applied directly to it.
  const glowGold = document.querySelector('.ambient-glow--gold')?.parentElement;
  const glowEmber = document.querySelector('.ambient-glow--ember')?.parentElement;

  if (glowGold) {
    gsap.to(glowGold, {
      yPercent: 18,
      ease: 'none',
      scrollTrigger: { trigger: '#hero', start: 'top top', end: 'bottom top', scrub: 1.2 },
    });
  }
  if (glowEmber) {
    gsap.to(glowEmber, {
      yPercent: -14,
      ease: 'none',
      scrollTrigger: { trigger: '#hero', start: 'top top', end: 'bottom top', scrub: 1.2 },
    });
  }
}

/* ================================================================
   11. INIT
   ================================================================ */
function applyConfigToDOM() {
  document.title = `Happy Birthday, ${CONFIG.name}`;
  const nameEl = document.getElementById('birthday-name');
  if (nameEl) nameEl.textContent = `${CONFIG.name}.`;
}

function init() {
  gsap.registerPlugin(ScrollTrigger, SplitText);

  unwrapCta = document.getElementById('unwrap-cta');
  eyebrowEl = document.querySelector('#hero .eyebrow');
  scrollCueEl = document.getElementById('scroll-cue');

  applyConfigToDOM();
  renderMessageCards();
  initThree();
  prepareHeroText();
  initCardTilt();
  initCardScrollReveal();
  initScrollEffects();

  if (isFinePointer && !prefersReducedMotion) {
    initCustomCursor();
  }
  applyMagnetic(unwrapCta, 0.4);

  unwrapCta.addEventListener('click', startExplosionSequence);
  canvas.addEventListener('click', onCanvasClick);
  window.addEventListener('mousemove', onPointerMove, { passive: true });
  window.addEventListener('touchmove', onPointerMove, { passive: true });
  window.addEventListener('resize', onResize);

  animate();
}

document.addEventListener('DOMContentLoaded', init);
