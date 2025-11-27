import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import Stats from 'three/addons/libs/stats.module.js';
import { initInput } from './input.js';
import { initResources, waterMesh } from './resources.js';
import { initClouds, updateClouds } from './clouds.js';
import { updateChunks } from './world.js';
import { updatePhysics, playerPos } from './physics.js';
import { initUI, updateUI } from './ui.js';
import { CHUNK_SIZE, RENDER_DISTANCE, CURVATURE_STRENGTH } from './config.js';

// --- Setup ---
const scene = new THREE.Scene();
const skyColor = 0x6fa8dc; // Richer blue
scene.background = new THREE.Color(skyColor);
scene.fog = new THREE.Fog(skyColor, 20, (CHUNK_SIZE * RENDER_DISTANCE) - 10);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(1); // Performance: Force 1:1 pixel ratio
renderer.shadowMap.enabled = false; // Shadows disabled for now
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// Global Shader Uniforms for curved world effect
const globalShaderUniforms = {
    uCurvature: { value: CURVATURE_STRENGTH },
    uBendCenter: { value: new THREE.Vector3() } // Updated each frame to follow the player
};

// Lights
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
scene.add(hemiLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
const lightDir = new THREE.Vector3(-0.6, -1.0, -0.6).normalize();
const lightDistance = 120;
const lightOffset = new THREE.Vector3().copy(lightDir).multiplyScalar(-lightDistance);
dirLight.position.copy(lightOffset);
dirLight.castShadow = false; // Shadows disabled for now
dirLight.shadow.camera.top = 80;
dirLight.shadow.camera.bottom = -80;
dirLight.shadow.camera.left = -80;
dirLight.shadow.camera.right = 80;
dirLight.shadow.camera.near = 1;
dirLight.shadow.camera.far = 250;
dirLight.shadow.bias = -0.001;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
scene.add(dirLight);

// 3D Trail Setup (Ribbon)
const TRAIL_HISTORY = 3.0; 
const MAX_TRAIL_POINTS = 1200; 
const TRAIL_WIDTH = 0.3;

const trailGeo = new THREE.BufferGeometry();
const trailPositions = new Float32Array(MAX_TRAIL_POINTS * 2 * 3);
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));

const indices = [];
for (let i = 0; i < MAX_TRAIL_POINTS - 1; i++) {
    const v = i * 2;
    indices.push(v, v+1, v+2);
    indices.push(v+2, v+1, v+3);
}
trailGeo.setIndex(indices);

const trailMat = new THREE.MeshBasicMaterial({ color: 0xffff00, side: THREE.DoubleSide });
const trailMesh = new THREE.Mesh(trailGeo, trailMat);
trailMesh.frustumCulled = false; 
scene.add(trailMesh);

let worldTrail = []; 
const _tDir = new THREE.Vector3();
const _tRight = new THREE.Vector3();
const _tUp = new THREE.Vector3(0, 1, 0);
const _xAxis = new THREE.Vector3(1, 0, 0);
const _lightUp = new THREE.Vector3(0, 1, 0);
const _lightViewMat = new THREE.Matrix4();
const _invLightViewMat = new THREE.Matrix4();
const _lightTarget = new THREE.Vector3();
const _lightPos = new THREE.Vector3();
const _lightCenter = new THREE.Vector3();

// --- Initialization ---
const controls = new PointerLockControls(camera, document.body);

initInput();
initResources(scene, globalShaderUniforms);
initClouds(scene, globalShaderUniforms);
initUI(controls);

// --- Loop Vars ---
const clock = new THREE.Clock();
const TIME_STEP = 1 / 60;
let physicsAccumulator = 0;
const prevPlayerPos = new THREE.Vector3().copy(playerPos);
const underwaterOverlay = document.getElementById('underwater-overlay');
const stats = new Stats();
document.body.appendChild(stats.dom);

function animate() {
    requestAnimationFrame(animate);
    
    stats.begin();

    const dt = Math.min(clock.getDelta(), 0.1); 
    physicsAccumulator += dt;

    while (physicsAccumulator >= TIME_STEP) {
        prevPlayerPos.copy(playerPos); 
        updatePhysics(TIME_STEP, camera, controls);
        physicsAccumulator -= TIME_STEP;
    }

    const alpha = physicsAccumulator / TIME_STEP;
    camera.position.lerpVectors(prevPlayerPos, playerPos, alpha);

    // Update global shader uniforms so curvature stays centered on the rendered (interpolated) camera
    globalShaderUniforms.uBendCenter.value.copy(camera.position);

    // Update 3D Trail (Ribbon)
    const now = clock.getElapsedTime();
    worldTrail.push({ x: camera.position.x, y: camera.position.y - 1.5, z: camera.position.z, t: now });
    
    while (worldTrail.length > 0 && now - worldTrail[0].t > TRAIL_HISTORY) {
        worldTrail.shift();
    }

    // Update Mesh Vertices
    const trailPosAttr = trailMesh.geometry.attributes.position;
    const count = worldTrail.length;

    for (let i = 0; i < count; i++) {
        if (i >= MAX_TRAIL_POINTS) break;
        
        const curr = worldTrail[i];
        let next = worldTrail[i + 1];
        
        if (next) {
            _tDir.set(next.x - curr.x, next.y - curr.y, next.z - curr.z);
        } else if (i > 0) {
            const prev = worldTrail[i - 1];
            _tDir.set(curr.x - prev.x, curr.y - prev.y, curr.z - prev.z);
        } else {
            _tDir.set(0, 0, 1);
        }
        _tDir.normalize();
        
        if (Math.abs(_tDir.y) > 0.99) {
            _tRight.crossVectors(_tDir, _xAxis);
        } else {
            _tRight.crossVectors(_tDir, _tUp);
        }
        _tRight.normalize().multiplyScalar(TRAIL_WIDTH / 2);

        const v = i * 2;
        trailPosAttr.setXYZ(v, curr.x - _tRight.x, curr.y - _tRight.y, curr.z - _tRight.z);
        trailPosAttr.setXYZ(v + 1, curr.x + _tRight.x, curr.y + _tRight.y, curr.z + _tRight.z);
    }
    
    trailMesh.geometry.setDrawRange(0, Math.max(0, (Math.min(count, MAX_TRAIL_POINTS) - 1) * 6));
    trailPosAttr.needsUpdate = true;

    // Underwater Logic
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
    
    // Stable shadow mapping: keep sun direction fixed, anchor to player, snap to light texel grid
    const shadowCam = dirLight.shadow.camera;
    const texelSizeX = (shadowCam.right - shadowCam.left) / dirLight.shadow.mapSize.width;
    const texelSizeY = (shadowCam.top - shadowCam.bottom) / dirLight.shadow.mapSize.height;

    // Build light view matrix centered on camera (matches curvature center)
    const lightTarget = _lightTarget.copy(camera.position);
    const lightPos = _lightPos.copy(camera.position).addScaledVector(lightDir, -lightDistance);
    _lightViewMat.lookAt(lightPos, lightTarget, _lightUp);
    _invLightViewMat.copy(_lightViewMat).invert();

    // Snap player center in light space to texel grid
    const snappedCenter = _lightCenter.copy(camera.position).applyMatrix4(_lightViewMat);
    snappedCenter.x = Math.floor(snappedCenter.x / texelSizeX) * texelSizeX;
    snappedCenter.y = Math.floor(snappedCenter.y / texelSizeY) * texelSizeY;
    snappedCenter.z = Math.floor(snappedCenter.z / texelSizeX) * texelSizeX;
    snappedCenter.applyMatrix4(_invLightViewMat);

    dirLight.position.copy(snappedCenter).addScaledVector(lightDir, -lightDistance);
    dirLight.target.position.copy(snappedCenter);
    dirLight.target.updateMatrixWorld();

    if (waterMesh) {
        // Calculate Grid Spacing for Snapping
        // Total Width = CHUNK_SIZE * (RENDER_DISTANCE * 2 + 2)
        // Segments = 256
        const totalWidth = CHUNK_SIZE * (RENDER_DISTANCE * 2 + 2);
        const gridSpacing = totalWidth / 256;

        // Snap position to nearest grid line to prevent vertex swimming
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
