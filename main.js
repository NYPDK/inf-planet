import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { initInput, SmoothPointerLockControls } from './input.js';
import { initResources, waterMesh } from './resources.js';
import { initClouds, updateClouds } from './clouds.js';
import { updateChunks, getTerrainHeight, activeChunks } from './world.js';
import { updatePhysics, playerPos } from './physics.js';
import { initUI, updateUI } from './ui.js';
import { isLargeMapVisible } from './LargeMap.js';
import { CHUNK_SIZE, RENDER_DISTANCE, CURVATURE_STRENGTH, DEFAULTS, GRAPHICS_SETTINGS } from './config.js';

const scene = new THREE.Scene();
const skyColor = 0x6fa8dc;
scene.background = new THREE.Color(skyColor);
scene.fog = new THREE.Fog(skyColor, 20, (CHUNK_SIZE * RENDER_DISTANCE) - 10);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ 
    antialias: true,
    powerPreference: "high-performance",
    desynchronized: true 
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true; // ensure first frame renders shadows
document.body.appendChild(renderer.domElement);
const TARGET_ANISOTROPY = Math.min(4, renderer.capabilities.getMaxAnisotropy());

let currentPixelRatio = 1;
const MIN_PIXEL_RATIO = 0.25;
const MAX_PIXEL_RATIO = 1;
const FPS_CHECK_INTERVAL = 500; // ms
let fpsCheckTimer = 0;
let framesSinceLastCheck = 0;
let slowRecoverTimer = 0;
const RECOVER_INTERVAL = 2000; // ms
const UPSCALE_STEP = 0.05;
const DYNRES_MIN_INTERVAL = 1500; // ms
let lastDynResChange = 0;
const MAX_FRAME_DELTA = 0.05; // clamp large frame gaps to avoid jittery input/physics
const DEFAULT_TARGET_FPS = 240;
const MAP_RESUME_DELAY_MS = 1000;

const globalShaderUniforms = {
    uCurvature: { value: CURVATURE_STRENGTH },
    uBendCenter: { value: new THREE.Vector3() }
};

const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
scene.add(hemiLight);
const SHADOW_FRUSTUM = CHUNK_SIZE * (RENDER_DISTANCE * 2.0);
const SHADOW_MAP_RES = 4096;
const SHADOW_TEXEL_SIZE = (SHADOW_FRUSTUM * 2) / SHADOW_MAP_RES;
const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
const lightDir = new THREE.Vector3(-0.6, -0.5, -0.6).normalize();
const lightDistance = 120;
const lightOffset = new THREE.Vector3().copy(lightDir).multiplyScalar(-lightDistance);
dirLight.position.copy(lightOffset);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = SHADOW_MAP_RES;
dirLight.shadow.mapSize.height = SHADOW_MAP_RES;
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 500;
dirLight.shadow.camera.left = -SHADOW_FRUSTUM;
dirLight.shadow.camera.right = SHADOW_FRUSTUM;
dirLight.shadow.camera.top = SHADOW_FRUSTUM;
dirLight.shadow.camera.bottom = -SHADOW_FRUSTUM;
dirLight.shadow.bias = -0.0001;
dirLight.shadow.normalBias = 0.02;
dirLight.shadow.camera.updateProjectionMatrix(); // apply the enlarged shadow frustum so terrain is included
scene.add(dirLight);
scene.add(dirLight.target);

const _tmpVec = new THREE.Vector3();
const _tmpVel = new THREE.Vector3();
const _tmpOffset = new THREE.Vector3();
const _shadowAnchor = new THREE.Vector3();
const _boidCenter = new THREE.Vector3();
const _boidAlign = new THREE.Vector3();
const _boidSeparate = new THREE.Vector3();
const _boidNeighbor = new THREE.Vector3();
const _boidNeighborVel = new THREE.Vector3();
const _lastShadowAnchor = new THREE.Vector3(Infinity, Infinity, Infinity);
const _camDir = new THREE.Vector3();
const _groundNormal = new THREE.Vector3();
const _swirlVec = new THREE.Vector3();

const PARTICLE_COUNT = 500;
// Tether radius tightened so particles recycle sooner when far/out of view
const PARTICLE_RADIUS = CHUNK_SIZE * (RENDER_DISTANCE - 1.0);
const PARTICLE_REPEL_RADIUS = 5.0;
const PARTICLE_REPEL_STRENGTH = 32.0;
const PARTICLE_WIND_MAX = 0.9;
const PARTICLE_WIND_CHANGE_INTERVAL = 6.0;
const PARTICLE_SWIRL_BASE = 1.2;
const PARTICLE_MAX_UPDATES_PER_FRAME = 2000;
const PARTICLE_MAX_HEIGHT_ABOVE_GROUND = 20.0;
const PARTICLE_MIN_CLEARANCE = 0.5;
const PARTICLE_GROUND_SOFT_CLEAR = 1.0;
const PARTICLE_GROUND_PUSH = 8.0;
const PARTICLE_WATER_MIN_Y = -4.5;
const PARTICLE_SOFT_CEILING = 0.8; // fraction of max height to begin easing
const PARTICLE_CEILING_PUSH = 6.0;
const PARTICLE_CLUSTER_COUNT = 12;
const PARTICLE_CLUSTER_RADIUS = 4.5;
const PARTICLE_CLUSTER_SPREAD = 1.5;
const PARTICLE_CLUSTER_DRIFT_SPEED = 2.0;
const PARTICLE_CLUSTER_DRIFT_CHANGE_INTERVAL = 4.0;
const PARTICLE_FRONT_CONE_COS = 0.766; // ~40 degrees
const PARTICLE_FRONT_AVOID_DISTANCE = 12.0;
const BOID_NEIGHBOR_RADIUS = 3.5;
const BOID_SAMPLE_COUNT = 12;
const BOID_ALIGN_WEIGHT = 3.0;
const BOID_COHESION_WEIGHT = 2.0;
const BOID_SEPARATION_WEIGHT = 6.0;
const BOID_MAX_SPEED = 12.0;
const particleGeometry = new THREE.BufferGeometry();
const particlePositions = new Float32Array(PARTICLE_COUNT * 3);
const particleVelocities = new Float32Array(PARTICLE_COUNT * 3);
let particlePoints;
let particleTexture;
let particleMaterialUniforms;
let particleAspect = 1.0;
let particleUpdateOffset = 0;
const particleClusterOffsets = [];
const particleClusterDrift = [];
const particleClusterDriftTimer = [];
const particleClusterSwirl = [];
const particleClusterIds = new Uint16Array(PARTICLE_COUNT);
const _globalWind = new THREE.Vector3(0.25, 0.02, 0.25);
const _windTarget = new THREE.Vector3(0.25, 0.02, 0.25);
let windTimer = PARTICLE_WIND_CHANGE_INTERVAL;

const controls = new SmoothPointerLockControls(camera, document.body);
controls.addEventListener('lock', () => scheduleRefreshDetect(200));

initInput();
initResources(scene, globalShaderUniforms, TARGET_ANISOTROPY);
initClouds(scene, globalShaderUniforms);
initUI(controls);
initAirParticles();

const TIME_STEP = 1 / 120; // run sim at high tick rate for smooth motion on high refresh
const MAX_PHYSICS_STEPS = 4; // avoid spiraling when frame time spikes
let physicsAccumulator = 0;
const simClock = new THREE.Clock();
const prevPlayerPos = new THREE.Vector3().copy(playerPos);
const underwaterOverlay = document.getElementById('underwater-overlay');
const stats = new Stats();
stats.showPanel(0); // force FPS panel visible
stats.dom.style.top = '';
stats.dom.style.left = '10px';
stats.dom.style.bottom = '10px';
document.body.appendChild(stats.dom);
const tickStats = new Stats();
const tickPanel = new Stats.Panel('TPS', '#0f0', '#021');
tickStats.addPanel(tickPanel);
tickStats.showPanel(tickStats.dom.children.length - 1);
tickStats.dom.style.top = '';
tickStats.dom.style.bottom = '10px';
tickStats.dom.style.left = '100px';
document.body.appendChild(tickStats.dom);
const fpsPanel = new Stats.Panel('RFPS', '#0ff', '#002');
stats.addPanel(fpsPanel);
fpsPanel.dom = stats.dom; // ensure same container for layout

let tickCounter = 0;
let tickTimer = 0;
let lastRenderTime = performance.now();
let smoothedRfps = 0;
let bestDetectedHz = 0;
let detectInProgress = false;
let detectTimer = null;
const MIN_FPS_CAP = 30;
const RFPS_SMOOTH = 0.25;
let mapCooldownMs = 0;
let lastMapVisible = false;
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();

function updateChunkVisibility(cam) {
    if (!cam) return;
    _projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    for (const [, chunk] of activeChunks) {
        const bounds = chunk.userData?.bounds;
        chunk.visible = bounds ? _frustum.intersectsBox(bounds) : true;
    }
}

function detectDisplayRefreshRate(samples = 180, warmup = 30) {
    if (detectInProgress) return Promise.resolve(bestDetectedHz || GRAPHICS_SETTINGS.TARGET_FPS || DEFAULT_TARGET_FPS);
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return Promise.resolve(GRAPHICS_SETTINGS.TARGET_FPS || DEFAULT_TARGET_FPS);
    detectInProgress = true;
    return new Promise((resolve) => {
        let lastTime;
        let minDelta = Infinity;
        let collected = 0;
        function sample(t) {
            if (lastTime !== undefined) {
                const delta = t - lastTime;
                if (collected >= warmup) {
                    minDelta = Math.min(minDelta, delta);
                    collected++;
                    if (collected >= warmup + samples) {
                        detectInProgress = false;
                        const hz = Math.max(MIN_FPS_CAP, Math.min(360, Math.round(1000 / Math.max(minDelta, 0.0001))));
                        bestDetectedHz = Math.max(bestDetectedHz, hz);
                        GRAPHICS_SETTINGS.TARGET_FPS = bestDetectedHz;
                        const label = document.getElementById('val-targetfps');
                        if (label) label.innerText = `${bestDetectedHz} (auto)`;
                        resolve(bestDetectedHz);
                        return;
                    }
                } else {
                    collected++;
                }
            }
            lastTime = t;
            requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
    });
}

function scheduleRefreshDetect(delay = 0) {
    if (detectTimer) clearTimeout(detectTimer);
    detectTimer = setTimeout(() => {
        detectTimer = null;
        detectDisplayRefreshRate();
    }, delay);
}

// Initial detect and re-detect after focus/lock/visibility to catch cases where the tab was throttled.
scheduleRefreshDetect(200);
window.addEventListener('focus', () => scheduleRefreshDetect(200));
window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleRefreshDetect(200);
});

function getEffectiveTargetFps() {
    return GRAPHICS_SETTINGS.TARGET_FPS || DEFAULT_TARGET_FPS;
}

function clampParticleHeight(pos) {
    const groundY = getTerrainHeight(pos.x, pos.z);
    const minY = groundY + PARTICLE_MIN_CLEARANCE;
    const maxY = groundY + PARTICLE_MAX_HEIGHT_ABOVE_GROUND;
    const waterMin = Math.max(minY, PARTICLE_WATER_MIN_Y);
    if (pos.y < waterMin) pos.y = waterMin;
    if (pos.y > maxY) pos.y = maxY;
}

function getGroundNormal(x, z) {
    const eps = 0.6;
    const hL = getTerrainHeight(x - eps, z);
    const hR = getTerrainHeight(x + eps, z);
    const hD = getTerrainHeight(x, z - eps);
    const hU = getTerrainHeight(x, z + eps);
    _groundNormal.set(-(hR - hL), 2 * eps, -(hU - hD)).normalize();
    return _groundNormal;
}

function updateClusterOffsets(dt) {
    for (let i = 0; i < PARTICLE_CLUSTER_COUNT; i++) {
        particleClusterDriftTimer[i] -= dt;
        if (particleClusterDriftTimer[i] <= 0) {
            particleClusterDrift[i].copy(randomInSphere(PARTICLE_CLUSTER_DRIFT_SPEED));
            particleClusterDriftTimer[i] = PARTICLE_CLUSTER_DRIFT_CHANGE_INTERVAL;
        }
        particleClusterOffsets[i].addScaledVector(particleClusterDrift[i], dt);
        if (particleClusterOffsets[i].length() > PARTICLE_RADIUS * 0.75) {
            particleClusterOffsets[i].multiplyScalar(0.8);
        }
    }
}

function obstacleAvoidance(pos, vel, dt) {
    // Ground avoidance
    const groundY = getTerrainHeight(pos.x, pos.z);
    const groundNormal = getGroundNormal(pos.x, pos.z);
    const clearance = pos.y - groundY;
    const desiredY = groundY + PARTICLE_MIN_CLEARANCE + 0.6;
    if (clearance < PARTICLE_GROUND_SOFT_CLEAR) {
        const push = Math.min((PARTICLE_GROUND_SOFT_CLEAR - clearance) * PARTICLE_GROUND_PUSH * dt, PARTICLE_GROUND_PUSH * dt);
        vel.addScaledVector(groundNormal, push);
    }
    if (pos.y < desiredY) {
        vel.y += (desiredY - pos.y) * PARTICLE_GROUND_PUSH * 0.35 * dt;
    }

    // Soft ceiling to avoid flattening at the hard clamp
    const ceilingY = groundY + PARTICLE_MAX_HEIGHT_ABOVE_GROUND * PARTICLE_SOFT_CEILING;
    if (pos.y > ceilingY) {
        const over = pos.y - ceilingY;
        vel.y -= over * PARTICLE_CEILING_PUSH * dt;
    }

    // Tree avoidance (sample nearby chunks)
    const cx = Math.floor(pos.x / CHUNK_SIZE);
    const cz = Math.floor(pos.z / CHUNK_SIZE);
    const maxDist2 = 6 * 6;
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            const key = `${cx + dx},${cz + dz}`;
            const chunk = activeChunks.get(key);
            if (!chunk || !chunk.userData || !chunk.userData.trees) continue;
            const trees = chunk.userData.trees;
            for (let t = 0; t < trees.length; t++) {
                const tree = trees[t];
                const dxp = pos.x - tree.x;
                const dzp = pos.z - tree.z;
                const dist2 = dxp * dxp + dzp * dzp;
                if (dist2 < maxDist2 && dist2 > 0.0001) {
                    const dist = Math.sqrt(dist2);
                    const push = (maxDist2 - dist2) / maxDist2;
                    vel.x += (dxp / dist) * push * 10.0 * dt;
                    vel.z += (dzp / dist) * push * 10.0 * dt;
                }
            }
        }
    }
}

function randomInSphere(radius) {
    const u = Math.random();
    const v = Math.random();
    const theta = u * 2.0 * Math.PI;
    const phi = Math.acos(2.0 * v - 1.0);
    const r = radius * Math.cbrt(Math.random());
    const sinPhi = Math.sin(phi);
    return new THREE.Vector3(
        r * sinPhi * Math.cos(theta),
        r * Math.cos(phi),
        r * sinPhi * Math.sin(theta)
    );
}

function updateWind(dt) {
    windTimer -= dt;
    if (windTimer <= 0) {
        _windTarget.copy(randomInSphere(PARTICLE_WIND_MAX));
        _windTarget.y *= 0.2; // keep mostly horizontal
        windTimer = PARTICLE_WIND_CHANGE_INTERVAL;
    }
    _globalWind.lerp(_windTarget, Math.min(1, dt * 0.5));
}

function isInFrontCone(pos) {
    camera.getWorldDirection(_camDir);
    _tmpOffset.subVectors(pos, camera.position);
    const dist = _tmpOffset.length();
    if (dist < 0.0001) return true;
    _tmpOffset.normalize();
    return dist < PARTICLE_FRONT_AVOID_DISTANCE && _tmpOffset.dot(_camDir) > PARTICLE_FRONT_CONE_COS;
}

function findSpawnNear(clusterCenter) {
    let candidate = null;
    for (let tries = 0; tries < 6; tries++) {
        const c = randomInSphere(PARTICLE_CLUSTER_SPREAD).add(clusterCenter);
        if (!isInFrontCone(c)) {
            candidate = c;
            break;
        }
        if (!candidate) candidate = c;
    }
    return candidate;
}

function getClusterCenter(idx, out) {
    const offset = particleClusterOffsets[idx % PARTICLE_CLUSTER_COUNT];
    return out.copy(camera.position).add(offset);
}

function initAirParticles() {
    particleClusterOffsets.length = 0;
    particleClusterDrift.length = 0;
    particleClusterDriftTimer.length = 0;
    particleClusterSwirl.length = 0;
    for (let c = 0; c < PARTICLE_CLUSTER_COUNT; c++) {
        const offset = randomInSphere(PARTICLE_RADIUS * 0.6);
        particleClusterOffsets.push(offset);
        particleClusterDrift.push(randomInSphere(PARTICLE_CLUSTER_DRIFT_SPEED));
        particleClusterDriftTimer.push(Math.random() * PARTICLE_CLUSTER_DRIFT_CHANGE_INTERVAL);
        const swirlDir = Math.random() < 0.5 ? -1 : 1;
        const swirlSpeed = PARTICLE_SWIRL_BASE * (0.6 + Math.random() * 0.9);
        particleClusterSwirl.push(swirlDir * swirlSpeed);
    }

    for (let i = 0; i < PARTICLE_COUNT; i++) {
        const base = i * 3;
        const clusterId = i % PARTICLE_CLUSTER_COUNT;
        particleClusterIds[i] = clusterId;
        const cluster = getClusterCenter(clusterId, _tmpVec);
        const p = findSpawnNear(cluster);
        clampParticleHeight(p);
        particlePositions[base] = p.x;
        particlePositions[base + 1] = p.y;
        particlePositions[base + 2] = p.z;
        particleVelocities[base] = (Math.random() - 0.5) * 4.0;
        particleVelocities[base + 1] = (Math.random() - 0.5) * 4.0;
        particleVelocities[base + 2] = (Math.random() - 0.5) * 4.0;
    }

    particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    particleTexture = new THREE.TextureLoader().load('textures/slime.png', (tex) => {
        if (tex && tex.image && tex.image.width && tex.image.height) {
            particleAspect = tex.image.width / tex.image.height;
        }
    });
    particleTexture.colorSpace = THREE.SRGBColorSpace;
    particleTexture.anisotropy = TARGET_ANISOTROPY;
    particleTexture.minFilter = THREE.LinearFilter;
    particleTexture.magFilter = THREE.LinearFilter;
    particleTexture.generateMipmaps = false;
    particleTexture.wrapS = THREE.ClampToEdgeWrapping;
    particleTexture.wrapT = THREE.ClampToEdgeWrapping;

    particleMaterialUniforms = {
        uCurvature: globalShaderUniforms.uCurvature,
        uBendCenter: globalShaderUniforms.uBendCenter,
        uWaterLevel: { value: waterMesh ? waterMesh.position.y : -5.0 },
        uWaterColor: { value: new THREE.Color(0x3b7d9c) }
    };

    const particleMaterial = new THREE.PointsMaterial({
        map: particleTexture,
        color: 0xffffff,
        size: 0.4,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        depthTest: true,
        alphaTest: 0.1
    });
    particleMaterial.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, particleMaterialUniforms);
        shader.uniforms.uAspect = { value: particleAspect };

        shader.vertexShader = shader.vertexShader.replace(
            '#include <common>',
            `
            uniform float uCurvature;
            uniform vec3 uBendCenter;
            varying vec3 vWorldPos;
            #include <common>
            `
        );

        shader.vertexShader = shader.vertexShader.replace(
            '#include <project_vertex>',
            `
            vec4 bentWorldPosition = modelMatrix * vec4( position, 1.0 );
            float dist = distance(bentWorldPosition.xz, uBendCenter.xz);
            float bendFactor = dist * dist * uCurvature;
            bentWorldPosition.y -= bendFactor;

            vWorldPos = bentWorldPosition.xyz;

            vec4 mvPosition = viewMatrix * bentWorldPosition;
            gl_Position = projectionMatrix * mvPosition;
            `
        );

        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <common>',
            `
            uniform float uWaterLevel;
            uniform vec3 uWaterColor;
            varying vec3 vWorldPos;
            uniform float uAspect;
            #include <common>
            `
        );

        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <map_fragment>',
            `
            #ifdef USE_MAP
                vec2 uv = vUv;
                if (uAspect > 1.0) {
                    uv.x = (uv.x - 0.5) * uAspect + 0.5;
                } else {
                    uv.y = (uv.y - 0.5) / uAspect + 0.5;
                }
                if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
                vec4 sampledDiffuseColor = texture2D( map, uv );
                diffuseColor *= sampledDiffuseColor;
                float waterMask = step(vWorldPos.y, uWaterLevel);
                float depthFactor = clamp((uWaterLevel - vWorldPos.y) * 0.2, 0.0, 1.0);
                vec3 waterTint = mix(uWaterColor, vec3(0.1, 0.35, 0.7), 0.5);
                diffuseColor.rgb = mix(diffuseColor.rgb, waterTint, waterMask * depthFactor);
                diffuseColor.a *= mix(1.0, 0.5, waterMask * depthFactor);
            #endif
            `
        );
    };
    particlePoints = new THREE.Points(particleGeometry, particleMaterial);
    particlePoints.frustumCulled = false;
    particlePoints.renderOrder = 2; // draw after translucent water so particles stay visible when above
    scene.add(particlePoints);
}

function updateAirParticles(dt) {
    if (!particlePoints) return;
    updateWind(dt);
    updateClusterOffsets(dt);
    const positions = particleGeometry.attributes.position.array;
    const velocities = particleVelocities;
    let needsUpdate = false;

    const updatesThisFrame = Math.min(PARTICLE_MAX_UPDATES_PER_FRAME, PARTICLE_COUNT);
    const stride = Math.max(1, Math.ceil(PARTICLE_COUNT / updatesThisFrame));
    particleUpdateOffset = (particleUpdateOffset + 1) % stride;

    for (let i = particleUpdateOffset; i < PARTICLE_COUNT; i += stride) {
        const base = i * 3;
        _tmpVec.set(positions[base], positions[base + 1], positions[base + 2]);
        _tmpVel.set(velocities[base], velocities[base + 1], velocities[base + 2]);
        const clusterId = particleClusterIds[i];
        const clusterCenter = getClusterCenter(clusterId, _boidNeighbor);
        const swirlStrength = particleClusterSwirl[clusterId] || PARTICLE_SWIRL_BASE;

        // Boid neighbors (sampled)
        _boidCenter.set(0, 0, 0);
        _boidAlign.set(0, 0, 0);
        _boidSeparate.set(0, 0, 0);
        let neighborCount = 0;

        for (let n = 0; n < BOID_SAMPLE_COUNT; n++) {
            const idx = Math.floor(Math.random() * PARTICLE_COUNT);
            if (idx === i) continue;
            const nBase = idx * 3;
            const nx = positions[nBase];
            const ny = positions[nBase + 1];
            const nz = positions[nBase + 2];
            _tmpOffset.set(nx - _tmpVec.x, ny - _tmpVec.y, nz - _tmpVec.z);
            const d = _tmpOffset.length();
            if (d > 0 && d < BOID_NEIGHBOR_RADIUS) {
                neighborCount++;
            _boidNeighbor.set(nx, ny, nz);
            _boidCenter.add(_boidNeighbor);
            _boidNeighborVel.set(
                velocities[nBase],
                velocities[nBase + 1],
                velocities[nBase + 2]
            );
            _boidAlign.add(_boidNeighborVel);
                const sepStrength = (BOID_NEIGHBOR_RADIUS - d) / BOID_NEIGHBOR_RADIUS;
                _boidSeparate.addScaledVector(_tmpOffset, -sepStrength / Math.max(d, 0.001));
            }
        }

        if (neighborCount > 0) {
            _boidCenter.multiplyScalar(1 / neighborCount);
            _boidAlign.multiplyScalar(1 / neighborCount);

            _boidCenter.sub(_tmpVec).multiplyScalar(BOID_COHESION_WEIGHT);
            _boidAlign.sub(_tmpVel).multiplyScalar(BOID_ALIGN_WEIGHT);
            _boidSeparate.multiplyScalar(BOID_SEPARATION_WEIGHT);

            _tmpVel.addScaledVector(_boidCenter, dt);
            _tmpVel.addScaledVector(_boidAlign, dt);
            _tmpVel.addScaledVector(_boidSeparate, dt);
        }

        // Swirl around cluster center for more organic motion
        _swirlVec.set(_tmpVec.x - clusterCenter.x, 0, _tmpVec.z - clusterCenter.z);
        const swirlLen2 = _swirlVec.lengthSq();
        if (swirlLen2 > 0.0001) {
            const swirlLen = Math.sqrt(swirlLen2);
            _swirlVec.set(-_swirlVec.z / swirlLen, 0, _swirlVec.x / swirlLen);
            _tmpVel.addScaledVector(_swirlVec, swirlStrength * dt);
        }

        // Repel near player
        _tmpOffset.subVectors(_tmpVec, camera.position);
        const dist = _tmpOffset.length();
        if (dist < PARTICLE_REPEL_RADIUS && dist > 0.0001) {
            _tmpOffset.normalize();
            const strength = (PARTICLE_REPEL_RADIUS - dist) / PARTICLE_REPEL_RADIUS;
            _tmpVel.addScaledVector(_tmpOffset, strength * PARTICLE_REPEL_STRENGTH * dt);
        } else {
            _tmpVel.multiplyScalar(1 - Math.min(1, dt * 0.05)); // very light damping
            // Add random noise
            _tmpVel.x += (Math.random() - 0.5) * 8.0 * dt;
            _tmpVel.y += (Math.random() - 0.5) * 3.0 * dt;
            _tmpVel.z += (Math.random() - 0.5) * 8.0 * dt;
        }

        // Apply mild wind, scaled down slightly to keep speeds reasonable
        _tmpVel.addScaledVector(_globalWind, dt * 0.65);

        const speed = _tmpVel.length();
        if (speed > BOID_MAX_SPEED) {
            _tmpVel.multiplyScalar(BOID_MAX_SPEED / speed);
        }

        _tmpVec.addScaledVector(_tmpVel, dt);
        obstacleAvoidance(_tmpVec, _tmpVel, dt);
        // Mild vertical damping to reduce ceiling presses
        _tmpVel.y *= 0.98;

        // Keep particles around the player
        _tmpOffset.subVectors(_tmpVec, camera.position);
        const distToPlayer = _tmpOffset.length();
        const behindCam = _tmpOffset.normalize().dot(_camDir) < -0.2;
        if (distToPlayer > PARTICLE_RADIUS || (behindCam && distToPlayer > PARTICLE_RADIUS * 0.8)) {
            const newPos = findSpawnNear(clusterCenter);
            clampParticleHeight(newPos);
            _tmpVec.copy(newPos);
            _tmpVel.set((Math.random() - 0.5) * 4.0, (Math.random() - 0.5) * 4.0, (Math.random() - 0.5) * 4.0);
        }
        clampParticleHeight(_tmpVec);

        positions[base] = _tmpVec.x;
        positions[base + 1] = _tmpVec.y;
        positions[base + 2] = _tmpVec.z;
        velocities[base] = _tmpVel.x;
        velocities[base + 1] = _tmpVel.y;
        velocities[base + 2] = _tmpVel.z;
        needsUpdate = true;
    }
    if (needsUpdate) particleGeometry.attributes.position.needsUpdate = true;
}

function simulationLoop() {
    const dt = Math.min(simClock.getDelta(), MAX_FRAME_DELTA);
    physicsAccumulator += dt;
    let stepsThisFrame = 0;

    while (physicsAccumulator >= TIME_STEP) {
        prevPlayerPos.copy(playerPos); 
        updatePhysics(TIME_STEP, camera, controls);
        physicsAccumulator -= TIME_STEP;
        stepsThisFrame++;
        if (stepsThisFrame >= MAX_PHYSICS_STEPS) {
            physicsAccumulator = 0; // drop excess to prevent slowmo spiral
            break;
        }
    }

    const chunksUpdated = updateChunks(playerPos, scene);

    _shadowAnchor.set(
        Math.round(playerPos.x / SHADOW_TEXEL_SIZE) * SHADOW_TEXEL_SIZE,
        Math.round(playerPos.y / SHADOW_TEXEL_SIZE) * SHADOW_TEXEL_SIZE,
        Math.round(playerPos.z / SHADOW_TEXEL_SIZE) * SHADOW_TEXEL_SIZE
    );
    const shadowAnchorChanged = _shadowAnchor.distanceToSquared(_lastShadowAnchor) > (SHADOW_TEXEL_SIZE * SHADOW_TEXEL_SIZE * 0.25);

    if (shadowAnchorChanged || chunksUpdated) {
        dirLight.position.copy(_shadowAnchor).add(lightOffset);
        dirLight.target.position.copy(_shadowAnchor);
        dirLight.target.updateMatrixWorld();
        _lastShadowAnchor.copy(_shadowAnchor);
        dirLight.shadow.needsUpdate = true;
        renderer.shadowMap.needsUpdate = true;
    }

    updateClouds(dt, playerPos);
    updateUI(dt, simClock, camera);
    controls.update(dt);
    updateAirParticles(dt);
    if (particleMaterialUniforms) {
        particleMaterialUniforms.uWaterLevel.value = waterMesh ? waterMesh.position.y : -5.0;
    }

    tickCounter += stepsThisFrame;
    tickTimer += dt;
    if (tickTimer >= 1.0) {
        const tickRate = tickCounter / tickTimer;
        tickPanel.update(tickRate, 180); // show headroom above 144
        tickCounter = 0;
        tickTimer = 0;
    }

    requestAnimationFrame(simulationLoop);
}

function renderLoop(now) {
    if (now === undefined) now = performance.now();

    const targetFps = Math.max(MIN_FPS_CAP, getEffectiveTargetFps());
    const displayTarget = targetFps; // desired performance target only
    stats.begin();

    const alpha = physicsAccumulator / TIME_STEP;
    camera.position.lerpVectors(prevPlayerPos, playerPos, Math.min(1, alpha));

    globalShaderUniforms.uBendCenter.value.copy(camera.position);
    updateChunkVisibility(camera);

    if (underwaterOverlay) {
        if (camera.position.y < -5.05) { 
            underwaterOverlay.style.display = 'block';
            scene.fog.color.setHex(0x001e32); 
            scene.fog.near = 1;
            scene.fog.far = 30;
        } else {
            underwaterOverlay.style.display = 'none';
            scene.fog.color.setHex(skyColor); 
            scene.fog.near = 20;
            scene.fog.far = (CHUNK_SIZE * RENDER_DISTANCE) - 10;
        }
    }

    const nowFrame = performance.now();
    const frameDtMs = nowFrame - lastRenderTime;
    lastRenderTime = nowFrame;
    const mapVisible = isLargeMapVisible ? isLargeMapVisible() : false;
    const mapJustClosed = lastMapVisible && !mapVisible;

    if (mapJustClosed) {
        currentPixelRatio = MAX_PIXEL_RATIO;
        renderer.setPixelRatio(currentPixelRatio);
        lastDynResChange = nowFrame;
        mapCooldownMs = MAP_RESUME_DELAY_MS;
        fpsCheckTimer = 0;
        framesSinceLastCheck = 0;
    }

    if (mapVisible) {
        mapCooldownMs = MAP_RESUME_DELAY_MS;
        fpsCheckTimer = 0;
        framesSinceLastCheck = 0;
    } else if (mapCooldownMs > 0) {
        mapCooldownMs = Math.max(0, mapCooldownMs - frameDtMs);
    }

    // Smooth the RFPS readout to avoid the high/low bounce from fractional frame pacing against the monitor refresh.
    const rawRfps = 1000 / Math.max(frameDtMs, 0.0001);
    if (smoothedRfps === 0) smoothedRfps = rawRfps;
    smoothedRfps += (rawRfps - smoothedRfps) * RFPS_SMOOTH;
    const rfpsGaugeMax = Math.max(displayTarget * 2, rawRfps * 1.2);
    fpsPanel.update(smoothedRfps, rfpsGaugeMax);

    // Dynamic Resolution Logic (downscale only; no upscaling)
    if (!mapVisible && mapCooldownMs === 0) {
        fpsCheckTimer += frameDtMs;
        framesSinceLastCheck++;

        if (fpsCheckTimer > FPS_CHECK_INTERVAL) {
            const avgFps = (framesSinceLastCheck / fpsCheckTimer) * 1000;
            const dynResTarget = displayTarget;
            
            const canAdjust = (nowFrame - lastDynResChange) > DYNRES_MIN_INTERVAL;
            if (canAdjust && avgFps < dynResTarget - 10 && currentPixelRatio > MIN_PIXEL_RATIO) {
                const nextRatio = Math.max(MIN_PIXEL_RATIO, currentPixelRatio - 0.05);
                if (Math.abs(nextRatio - currentPixelRatio) > 0.001) {
                    currentPixelRatio = nextRatio;
                    renderer.setPixelRatio(currentPixelRatio);
                    lastDynResChange = nowFrame;
                }
            }
            
            fpsCheckTimer = 0;
            framesSinceLastCheck = 0;
        }
    } else {
        // Avoid using map performance samples to drive resolution changes
        fpsCheckTimer = 0;
        framesSinceLastCheck = 0;
    }

    if (waterMesh) {
        const totalWidth = CHUNK_SIZE * (RENDER_DISTANCE * 2 + 2);
        const gridSpacing = totalWidth / 256;

        waterMesh.position.x = Math.floor(camera.position.x / gridSpacing) * gridSpacing;
        waterMesh.position.z = Math.floor(camera.position.z / gridSpacing) * gridSpacing;
        
        waterMesh.material.uniforms.uTime.value = simClock.getElapsedTime();
    }

    renderer.render(scene, camera);

    stats.end();

    lastMapVisible = mapVisible;
    requestAnimationFrame(renderLoop);
}

simulationLoop();
requestAnimationFrame(renderLoop);

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
