import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import Stats from 'three/addons/libs/stats.module.js';
import { initInput } from './input.js';
import { initResources, waterMesh } from './resources.js';
import { initClouds, updateClouds } from './clouds.js';
import { updateChunks, getTerrainHeight } from './world.js';
import { updatePhysics, playerPos } from './physics.js';
import { initUI, updateUI } from './ui.js';
import { CHUNK_SIZE, RENDER_DISTANCE, CURVATURE_STRENGTH } from './config.js';

const scene = new THREE.Scene();
const skyColor = 0x6fa8dc;
scene.background = new THREE.Color(skyColor);
scene.fog = new THREE.Fog(skyColor, 20, (CHUNK_SIZE * RENDER_DISTANCE) - 10);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);

const globalShaderUniforms = {
    uCurvature: { value: CURVATURE_STRENGTH },
    uBendCenter: { value: new THREE.Vector3() }
};

const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
scene.add(hemiLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
const lightDir = new THREE.Vector3(-0.6, -1.0, -0.6).normalize();
const lightDistance = 120;
const lightOffset = new THREE.Vector3().copy(lightDir).multiplyScalar(-lightDistance);
dirLight.position.copy(lightOffset);
scene.add(dirLight);
scene.add(dirLight.target);

const _tmpVec = new THREE.Vector3();
const _tmpVel = new THREE.Vector3();
const _tmpOffset = new THREE.Vector3();
const _boidCenter = new THREE.Vector3();
const _boidAlign = new THREE.Vector3();
const _boidSeparate = new THREE.Vector3();
const _boidNeighbor = new THREE.Vector3();
const _boidNeighborVel = new THREE.Vector3();

const PARTICLE_COUNT = 500;
const PARTICLE_RADIUS = CHUNK_SIZE * (RENDER_DISTANCE - 0.5);
const PARTICLE_REPEL_RADIUS = 5.0;
const PARTICLE_REPEL_STRENGTH = 32.0;
const PARTICLE_WIND = new THREE.Vector3(0.3, 0.05, 0.35);
const PARTICLE_MAX_UPDATES_PER_FRAME = 2000;
const PARTICLE_MAX_HEIGHT_ABOVE_GROUND = 20.0;
const PARTICLE_MIN_CLEARANCE = 0.5;
const PARTICLE_WATER_MIN_Y = -4.5;
const PARTICLE_CLUSTER_COUNT = 12;
const PARTICLE_CLUSTER_RADIUS = 4.5;
const PARTICLE_CLUSTER_SPREAD = 1.5;
const BOID_NEIGHBOR_RADIUS = 3.5;
const BOID_SAMPLE_COUNT = 12;
const BOID_ALIGN_WEIGHT = 0.6;
const BOID_COHESION_WEIGHT = 0.5;
const BOID_SEPARATION_WEIGHT = 1.2;
const BOID_MAX_SPEED = 6.5;
const particleGeometry = new THREE.BufferGeometry();
const particlePositions = new Float32Array(PARTICLE_COUNT * 3);
const particleVelocities = new Float32Array(PARTICLE_COUNT * 3);
let particlePoints;
let particleTexture;
let particleMaterialUniforms;
let particleAspect = 1.0;
let particleUpdateOffset = 0;
const particleClusterOffsets = [];
const particleClusterIds = new Uint16Array(PARTICLE_COUNT);

const controls = new PointerLockControls(camera, document.body);

initInput();
initResources(scene, globalShaderUniforms);
initClouds(scene, globalShaderUniforms);
initUI(controls);
initAirParticles();

const clock = new THREE.Clock();
const TIME_STEP = 1 / 120; // run sim at high tick rate for smooth motion on high refresh
const MAX_PHYSICS_STEPS = 4; // avoid spiraling when frame time spikes
let physicsAccumulator = 0;
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
let lastFrameTime = performance.now();
let smoothFps = 0;

function clampParticleHeight(pos) {
    const groundY = getTerrainHeight(pos.x, pos.z);
    const minY = groundY + PARTICLE_MIN_CLEARANCE;
    const maxY = groundY + PARTICLE_MAX_HEIGHT_ABOVE_GROUND;
    const waterMin = Math.max(minY, PARTICLE_WATER_MIN_Y);
    if (pos.y < waterMin) pos.y = waterMin;
    if (pos.y > maxY) pos.y = maxY;
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

function getClusterCenter(idx, out) {
    const offset = particleClusterOffsets[idx % PARTICLE_CLUSTER_COUNT];
    return out.copy(camera.position).add(offset);
}

function initAirParticles() {
    particleClusterOffsets.length = 0;
    for (let c = 0; c < PARTICLE_CLUSTER_COUNT; c++) {
        const offset = randomInSphere(PARTICLE_RADIUS * 0.6);
        particleClusterOffsets.push(offset);
    }

    for (let i = 0; i < PARTICLE_COUNT; i++) {
        const base = i * 3;
        const clusterId = i % PARTICLE_CLUSTER_COUNT;
        particleClusterIds[i] = clusterId;
        const cluster = getClusterCenter(clusterId, _tmpVec);
        const p = randomInSphere(PARTICLE_CLUSTER_SPREAD).add(cluster);
        clampParticleHeight(p);
        particlePositions[base] = p.x;
        particlePositions[base + 1] = p.y;
        particlePositions[base + 2] = p.z;
        particleVelocities[base] = (Math.random() - 0.5) * 0.2;
        particleVelocities[base + 1] = (Math.random() - 0.5) * 0.2;
        particleVelocities[base + 2] = (Math.random() - 0.5) * 0.2;
    }

    particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    particleTexture = new THREE.TextureLoader().load('textures/slime.png', (tex) => {
        if (tex && tex.image && tex.image.width && tex.image.height) {
            particleAspect = tex.image.width / tex.image.height;
        }
    });
    particleTexture.colorSpace = THREE.SRGBColorSpace;
    particleTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
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

        // Repel near player
        _tmpOffset.subVectors(_tmpVec, camera.position);
        const dist = _tmpOffset.length();
        if (dist < PARTICLE_REPEL_RADIUS && dist > 0.0001) {
            _tmpOffset.normalize();
            const strength = (PARTICLE_REPEL_RADIUS - dist) / PARTICLE_REPEL_RADIUS;
            _tmpVel.addScaledVector(_tmpOffset, strength * PARTICLE_REPEL_STRENGTH * dt);
        } else {
            _tmpVel.multiplyScalar(1 - Math.min(1, dt * 0.5)); // light damping
        }

        _tmpVel.addScaledVector(PARTICLE_WIND, dt);

        const speed = _tmpVel.length();
        if (speed > BOID_MAX_SPEED) {
            _tmpVel.multiplyScalar(BOID_MAX_SPEED / speed);
        }

        _tmpVec.addScaledVector(_tmpVel, dt);

        // Keep particles around the player
        _tmpOffset.subVectors(_tmpVec, camera.position);
        if (_tmpOffset.length() > PARTICLE_RADIUS) {
            const newPos = randomInSphere(PARTICLE_CLUSTER_SPREAD).add(clusterCenter);
            clampParticleHeight(newPos);
            _tmpVec.copy(newPos);
            _tmpVel.set((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3);
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
function animate() {
    requestAnimationFrame(animate);
    
    stats.begin();

    const dt = clock.getDelta();
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

    const alpha = physicsAccumulator / TIME_STEP;
    camera.position.lerpVectors(prevPlayerPos, playerPos, alpha);

    globalShaderUniforms.uBendCenter.value.copy(camera.position);

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

    updateChunks(playerPos, scene);
    updateClouds(dt, playerPos);
    updateUI(dt, clock, camera);
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

    const nowFrame = performance.now();
    const frameDtMs = nowFrame - lastFrameTime;
    lastFrameTime = nowFrame;
    const instFps = 1000 / Math.max(frameDtMs, 0.0001);
    smoothFps = smoothFps * 0.9 + instFps * 0.1;
    fpsPanel.update(smoothFps, 200);

    if (waterMesh) {
        const totalWidth = CHUNK_SIZE * (RENDER_DISTANCE * 2 + 2);
        const gridSpacing = totalWidth / 256;

        waterMesh.position.x = Math.floor(camera.position.x / gridSpacing) * gridSpacing;
        waterMesh.position.z = Math.floor(camera.position.z / gridSpacing) * gridSpacing;
        
        waterMesh.material.uniforms.uTime.value = clock.getElapsedTime();
    }

    renderer.render(scene, camera);

    stats.end();
}

animate();

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
