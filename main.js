import * as THREE from 'three';
import { initInput, SmoothPointerLockControls } from './input.js';
import { initResources, waterMesh } from './resources.js';
import { initClouds, updateClouds } from './clouds.js';
import { updateChunks, activeChunks } from './world.js';
import { updatePhysics, playerPos } from './physics.js';
import { initUI, updateUI } from './ui.js';
import { isLargeMapVisible } from './LargeMap.js';
import { CHUNK_SIZE, RENDER_DISTANCE, CURVATURE_STRENGTH } from './config.js';
import { createPerformanceHud, createRefreshDetector } from './performance.js';
import { createAirParticles } from './airParticles.js';

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
renderer.shadowMap.needsUpdate = true;
document.body.appendChild(renderer.domElement);
const TARGET_ANISOTROPY = Math.min(4, renderer.capabilities.getMaxAnisotropy());

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
dirLight.shadow.camera.updateProjectionMatrix();
scene.add(dirLight);
scene.add(dirLight.target);

const _shadowAnchor = new THREE.Vector3();
const _lastShadowAnchor = new THREE.Vector3(Infinity, Infinity, Infinity);
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _tmpSphere = new THREE.Sphere();

const controls = new SmoothPointerLockControls(camera, document.body);
const refreshDetector = createRefreshDetector();
const performanceHud = createPerformanceHud(renderer, refreshDetector.getEffectiveTargetFps);
controls.addEventListener('lock', () => refreshDetector.scheduleRefreshDetect(200));

initInput();
initResources(scene, globalShaderUniforms, TARGET_ANISOTROPY);
initClouds(scene, globalShaderUniforms);
initUI(controls);

const { updateAirParticles } = createAirParticles({
    scene,
    camera,
    globalShaderUniforms,
    targetAnisotropy: TARGET_ANISOTROPY,
    getWaterLevel: () => (waterMesh ? waterMesh.position.y : -5.0)
});

const TIME_STEP = 1 / 120;
const MAX_PHYSICS_STEPS = 4;
const MAX_FRAME_DELTA = 0.05;
let physicsAccumulator = 0;
const simClock = new THREE.Clock();
const prevPlayerPos = new THREE.Vector3().copy(playerPos);
const underwaterOverlay = document.getElementById('underwater-overlay');

refreshDetector.scheduleRefreshDetect(200);
window.addEventListener('focus', () => refreshDetector.scheduleRefreshDetect(200));
window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshDetector.scheduleRefreshDetect(200);
});

function updateChunkVisibility(cam) {
    if (!cam) return;
    _projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    for (const [, chunk] of activeChunks) {
        const bounds = chunk.userData?.bounds;
        chunk.visible = bounds ? _frustum.intersectsBox(bounds) : true;
    }
}

function frameLoop(now) {
    performanceHud.beginFrame();

    const dt = Math.min(simClock.getDelta(), MAX_FRAME_DELTA);
    physicsAccumulator += dt;
    let stepsThisFrame = 0;

    while (physicsAccumulator >= TIME_STEP) {
        prevPlayerPos.copy(playerPos); 
        updatePhysics(TIME_STEP, camera, controls);
        physicsAccumulator -= TIME_STEP;
        stepsThisFrame++;
        if (stepsThisFrame >= MAX_PHYSICS_STEPS) {
            physicsAccumulator = 0;
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
    performanceHud.updateTickRate(stepsThisFrame, dt);

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

    const mapVisible = isLargeMapVisible ? isLargeMapVisible() : false;
    performanceHud.handleRenderFrame(now === undefined ? performance.now() : now, mapVisible);

    if (waterMesh) {
        const totalWidth = CHUNK_SIZE * (RENDER_DISTANCE * 2 + 2);
        const gridSpacing = totalWidth / 256;
        const verticalDistance = Math.abs(camera.position.y - waterMesh.position.y);
        const closeEnough = verticalDistance < 120;
        let visible = closeEnough;
        if (visible) {
            waterMesh.position.x = Math.floor(camera.position.x / gridSpacing) * gridSpacing;
            waterMesh.position.z = Math.floor(camera.position.z / gridSpacing) * gridSpacing;
            waterMesh.material.uniforms.uTime.value = simClock.getElapsedTime();
            if (_frustum && waterMesh.geometry && waterMesh.geometry.boundingSphere) {
                waterMesh.updateMatrixWorld();
                _tmpSphere.copy(waterMesh.geometry.boundingSphere).applyMatrix4(waterMesh.matrixWorld);
                visible = _frustum.intersectsSphere(_tmpSphere);
            }
        }
        waterMesh.visible = visible;
    }

    renderer.render(scene, camera);
    performanceHud.endFrame();
    requestAnimationFrame(frameLoop);
}

requestAnimationFrame(frameLoop);

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
