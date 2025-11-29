import * as THREE from 'three';
import { initInput, SmoothPointerLockControls } from './input.js';
import { initResources, waterMesh } from './resources.js';
import { initClouds, updateClouds } from './clouds.js';
import { updateChunks, activeChunks } from './world.js';
import { updatePhysics, playerPos } from './physics.js';
import { initUI, updateUI } from './ui.js';
import { isLargeMapVisible } from './LargeMap.js';
import { CHUNK_SIZE, RENDER_DISTANCE, CURVATURE_STRENGTH, GRAPHICS_SETTINGS } from './config.js';
import { createPerformanceHud, createRefreshDetector } from './performance.js';
import { createAirParticles } from './airParticles.js';

const scene = new THREE.Scene();
const skyColor = 0x6fa8dc;
scene.background = new THREE.Color(skyColor);
scene.fog = new THREE.Fog(skyColor, 20, (CHUNK_SIZE * RENDER_DISTANCE) - 10);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ 
    antialias: false,
    powerPreference: "high-performance",
    desynchronized: true 
});
const RENDER_SCALE = 0.6;
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(RENDER_SCALE);
renderer.shadowMap.enabled = false;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
document.body.appendChild(renderer.domElement);
renderer.domElement.style.imageRendering = 'pixelated';
const TARGET_ANISOTROPY = Math.min(4, renderer.capabilities.getMaxAnisotropy());
const PSX_RES = { x: 320, y: 240 };
const crtRenderTarget = new THREE.WebGLRenderTarget(
    Math.floor(window.innerWidth * RENDER_SCALE),
    Math.floor(window.innerHeight * RENDER_SCALE),
    {
    magFilter: THREE.NearestFilter,
    minFilter: THREE.NearestFilter,
    depthBuffer: true
});
crtRenderTarget.depthTexture = new THREE.DepthTexture(
    crtRenderTarget.width,
    crtRenderTarget.height,
    THREE.UnsignedShortType
);
const persistenceTargets = [
    new THREE.WebGLRenderTarget(
        Math.floor(window.innerWidth * RENDER_SCALE),
        Math.floor(window.innerHeight * RENDER_SCALE),
        { magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter, depthBuffer: false }
    ),
    new THREE.WebGLRenderTarget(
        Math.floor(window.innerWidth * RENDER_SCALE),
        Math.floor(window.innerHeight * RENDER_SCALE),
        { magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter, depthBuffer: false }
    )
];
let persistenceIndex = 0;
const postScene = new THREE.Scene();
const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const postMaterial = new THREE.ShaderMaterial({
    uniforms: {
        uScene: { value: crtRenderTarget.texture },
        uDepth: { value: crtRenderTarget.depthTexture },
        uPrev: { value: persistenceTargets[0].texture },
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(window.innerWidth * RENDER_SCALE, window.innerHeight * RENDER_SCALE) },
        uDecay: { value: new THREE.Vector3(0.88, 0.9, 0.86) },
        uGhostMix: { value: 0.3 },
        uCameraNear: { value: camera.near },
        uCameraFar: { value: camera.far },
        uFocusDistance: { value: 20.0 },
        uBlurRange: { value: 60.0 },
        uMaxBlur: { value: 3.0 }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
        }
    `,
    fragmentShader: `
        varying vec2 vUv;
        uniform sampler2D uScene;
        uniform sampler2D uDepth;
        uniform sampler2D uPrev;
        uniform float uTime;
        uniform vec2 uResolution;
        uniform vec3 uDecay;
        uniform float uGhostMix;
        uniform float uCameraNear;
        uniform float uCameraFar;
        uniform float uFocusDistance;
        uniform float uBlurRange;
        uniform float uMaxBlur;

        float rand(vec2 co) {
            return fract(sin(dot(co, vec2(12.9898,78.233))) * 43758.5453);
        }

        float linearizeDepth(float depth) {
            float z = depth * 2.0 - 1.0;
            return (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear));
        }

        vec3 gatherBlur(vec2 coord, vec2 radius) {
            vec3 accum = texture2D(uScene, coord).rgb;
            accum += texture2D(uScene, coord + vec2(radius.x, 0.0)).rgb;
            accum += texture2D(uScene, coord - vec2(radius.x, 0.0)).rgb;
            accum += texture2D(uScene, coord + vec2(0.0, radius.y)).rgb;
            accum += texture2D(uScene, coord - vec2(0.0, radius.y)).rgb;
            accum += texture2D(uScene, coord + radius).rgb;
            accum += texture2D(uScene, coord - radius).rgb;
            accum += texture2D(uScene, coord + vec2(radius.x, -radius.y)).rgb;
            accum += texture2D(uScene, coord + vec2(-radius.x, radius.y)).rgb;
            return accum / 9.0;
        }

        vec3 sampleWithDof(vec2 coord, float blurStrength, vec2 blurRadius) {
            vec3 base = texture2D(uScene, coord).rgb;
            if (blurStrength <= 0.001) return base;
            vec3 blurred = gatherBlur(coord, blurRadius);
            return mix(base, blurred, blurStrength);
        }

        void main() {
            vec2 uv = vUv;

            // slight vignette (softened)
            vec2 centered = uv * 2.0 - 1.0;
            float vignette = smoothstep(1.6, 0.6, dot(centered, centered));

            // analog geometry warp (pincushion + wobble)
            float warp = 0.03;
            float pinch = 0.012;
            vec2 geom = centered;
            geom.x += (sin(uTime * 1.7 + geom.y * 4.0)) * 0.004;
            geom.y += (sin(uTime * 1.3 + geom.x * 5.0)) * 0.004;
            geom += geom * vec2(geom.y * geom.y, geom.x * geom.x) * pinch;
            geom += geom * dot(geom, geom) * warp;
            uv = geom * 0.5 + 0.5;

            // tracking jitter (subtle, only lower third)
            float lineId = floor(uv.y * 240.0);
            float track = (rand(vec2(lineId, floor(uTime * 6.0))) - 0.5) * 0.008;
            float band = smoothstep(0.7, 0.95, abs(sin(uTime * 1.2 + uv.y * 12.0)));
            float bandMask = 1.0 - smoothstep(0.33, 0.36, uv.y);
            uv.x += track * band * bandMask;
            uv.x += sin(uTime * 0.6) * 0.0015 * bandMask;

            float depth = linearizeDepth(texture2D(uDepth, uv).r);
            float blurStrength = clamp((depth - uFocusDistance) / uBlurRange, 0.0, 1.0);
            float blurRadius = blurStrength * uMaxBlur;
            vec2 depthBlur = (1.0 / uResolution) * max(blurRadius, 0.0001);

            // chromatic aberration offsets (no convergence drift)
            vec2 shift = vec2(0.0015 * sin(uTime * 0.7), 0.0015 * cos(uTime * 0.9));
            vec3 col;
            col.r = sampleWithDof(uv + shift, blurStrength, depthBlur).r;
            col.g = sampleWithDof(uv, blurStrength, depthBlur).g;
            col.b = sampleWithDof(uv - shift, blurStrength, depthBlur).b;

            // soft edge blend
            vec2 blur = vec2(1.0) / uResolution * 1.25;
            vec3 blurCol = (
                sampleWithDof(uv + blur, blurStrength, depthBlur) +
                sampleWithDof(uv - blur, blurStrength, depthBlur) +
                sampleWithDof(uv + vec2(blur.x, -blur.y), blurStrength, depthBlur) +
                sampleWithDof(uv + vec2(-blur.x, blur.y), blurStrength, depthBlur) +
                col
            ) / 5.0;
            col = mix(col, blurCol, 0.2);

            vec3 prevCol = texture2D(uPrev, uv).rgb;
            vec3 trail = prevCol * uDecay;
            col = col * mix(1.0, vignette, 0.5);
            col = mix(col, col + trail, uGhostMix);

            // luminance-driven bloom / beam spread
            vec2 px = 1.0 / uResolution;
            float lum = dot(col, vec3(0.299, 0.587, 0.114));
            float bloomStrength = smoothstep(0.35, 0.75, lum);
            float spread = mix(1.5, 3.5, bloomStrength);
            vec3 bloom = vec3(0.0);
            bloom += sampleWithDof(uv + vec2(px.x, 0.0) * spread, blurStrength, depthBlur);
            bloom += sampleWithDof(uv - vec2(px.x, 0.0) * spread, blurStrength, depthBlur);
            bloom += sampleWithDof(uv + vec2(0.0, px.y) * spread, blurStrength, depthBlur);
            bloom += sampleWithDof(uv - vec2(0.0, px.y) * spread, blurStrength, depthBlur);
            bloom += sampleWithDof(uv + vec2(px.x, px.y) * spread * 0.7, blurStrength, depthBlur);
            bloom += sampleWithDof(uv - vec2(px.x, px.y) * spread * 0.7, blurStrength, depthBlur);
            bloom *= (1.0 / 6.0) * bloomStrength;
            col += bloom * 0.6;

            // slight vertical beam fattening on bright lines
            col = mix(col, texture2D(uScene, uv + vec2(0.0, px.y * spread * 0.4)).rgb, bloomStrength * 0.15);

            col *= 1.25;
            gl_FragColor = vec4(col, 1.0);
        }
    `,
    depthWrite: false,
    depthTest: false
});
const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial);
postScene.add(postQuad);
const displayScene = new THREE.Scene();
const displayMaterial = new THREE.ShaderMaterial({
    uniforms: {
        uTex: { value: persistenceTargets[0].texture },
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(Math.floor(window.innerWidth * RENDER_SCALE), Math.floor(window.innerHeight * RENDER_SCALE)) }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
        }
    `,
    fragmentShader: `
        varying vec2 vUv;
        uniform sampler2D uTex;
        uniform float uTime;
        uniform vec2 uResolution;
        float rand(vec2 co) {
            return fract(sin(dot(co, vec2(12.9898,78.233))) * 43758.5453);
        }
        void main() {
            vec3 col = texture2D(uTex, vUv).rgb;
            float noise = (rand(vUv * uResolution + uTime * 120.0) - 0.5) * 0.03;
            col += noise;
            gl_FragColor = vec4(col, 1.0);
        }
    `,
    depthWrite: false,
    depthTest: false
});
const displayQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), displayMaterial);
displayScene.add(displayQuad);

const globalShaderUniforms = {
    uCurvature: { value: GRAPHICS_SETTINGS.CURVATURE ?? CURVATURE_STRENGTH },
    uBendCenter: { value: new THREE.Vector3() },
    uPsxTexel: { value: new THREE.Vector2() }
};

const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
scene.add(hemiLight);
const ambientLight = new THREE.AmbientLight(0xffffff, 0.55);
scene.add(ambientLight);
const SHADOW_FRUSTUM = CHUNK_SIZE * (RENDER_DISTANCE * 2.0);
const SHADOW_MAP_RES = 4096;
const SHADOW_TEXEL_SIZE = (SHADOW_FRUSTUM * 2) / SHADOW_MAP_RES;
const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
const lightDir = new THREE.Vector3(-0.6, -0.5, -0.6).normalize();
const lightDistance = 120;
const lightOffset = new THREE.Vector3().copy(lightDir).multiplyScalar(-lightDistance);
dirLight.position.copy(lightOffset);
dirLight.castShadow = false;
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
const _bboxCorners = Array.from({ length: 8 }, () => new THREE.Vector3());
const _bendCenter = new THREE.Vector3();
function updatePsxTexel() {
    // Fixed PSX-style snap regardless of viewport size
    globalShaderUniforms.uPsxTexel.value.set(2 / PSX_RES.x, 2 / PSX_RES.y);
}
updatePsxTexel();

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

function setShadowsEnabled(enabled) {
    renderer.shadowMap.enabled = !!enabled;
    dirLight.castShadow = !!enabled;
    dirLight.shadow.needsUpdate = true;
    renderer.shadowMap.needsUpdate = true;
}
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

function fillBoxCorners(box, out) {
    const min = box.min;
    const max = box.max;
    out[0].set(min.x, min.y, min.z);
    out[1].set(max.x, min.y, min.z);
    out[2].set(min.x, max.y, min.z);
    out[3].set(max.x, max.y, min.z);
    out[4].set(min.x, min.y, max.z);
    out[5].set(max.x, min.y, max.z);
    out[6].set(min.x, max.y, max.z);
    out[7].set(max.x, max.y, max.z);
}

function bendPointToCurvedWorld(src, curvature, out) {
    out.copy(src);
    const dx = out.x - _bendCenter.x;
    const dz = out.z - _bendCenter.z;
    out.y -= (dx * dx + dz * dz) * curvature;
    return out;
}

function isCurvedBoxVisible(box, curvature) {
    fillBoxCorners(box, _bboxCorners);
    for (let i = 0; i < _bboxCorners.length; i++) {
        bendPointToCurvedWorld(_bboxCorners[i], curvature, _bboxCorners[i]);
    }
    const planes = _frustum.planes;
    for (let p = 0; p < planes.length; p++) {
        let outside = true;
        for (let i = 0; i < _bboxCorners.length; i++) {
            if (planes[p].distanceToPoint(_bboxCorners[i]) >= -0.01) {
                outside = false;
                break;
            }
        }
        if (outside) return false;
    }
    return true;
}

function updateChunkVisibility(cam) {
    if (!cam) return;
    _projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    const curvature = globalShaderUniforms.uCurvature.value ?? CURVATURE_STRENGTH;
    _bendCenter.copy(globalShaderUniforms.uBendCenter.value ?? cam.position);
    for (const [, chunk] of activeChunks) {
        const bounds = chunk.userData?.bounds;
        chunk.visible = bounds ? isCurvedBoxVisible(bounds, curvature) : true;
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
    globalShaderUniforms.uCurvature.value = GRAPHICS_SETTINGS.CURVATURE ?? CURVATURE_STRENGTH;
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

    renderer.setRenderTarget(crtRenderTarget);
    renderer.render(scene, camera);

    const readRT = persistenceTargets[persistenceIndex];
    const writeRT = persistenceTargets[1 - persistenceIndex];
    postMaterial.uniforms.uPrev.value = readRT.texture;
    postMaterial.uniforms.uTime.value = simClock.getElapsedTime();
    postMaterial.uniforms.uResolution.value.set(crtRenderTarget.width, crtRenderTarget.height);

    renderer.setRenderTarget(writeRT);
    renderer.render(postScene, postCamera);

    renderer.setRenderTarget(null);
    displayMaterial.uniforms.uTex.value = writeRT.texture;
    displayMaterial.uniforms.uTime.value = simClock.getElapsedTime();
    displayMaterial.uniforms.uResolution.value.set(crtRenderTarget.width, crtRenderTarget.height);
    renderer.render(displayScene, postCamera);
    persistenceIndex = 1 - persistenceIndex;
    performanceHud.endFrame();
    requestAnimationFrame(frameLoop);
}

requestAnimationFrame(frameLoop);

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    updatePsxTexel();
    crtRenderTarget.setSize(
        Math.floor(window.innerWidth * RENDER_SCALE),
        Math.floor(window.innerHeight * RENDER_SCALE)
    );
    persistenceTargets[0].setSize(
        Math.floor(window.innerWidth * RENDER_SCALE),
        Math.floor(window.innerHeight * RENDER_SCALE)
    );
    persistenceTargets[1].setSize(
        Math.floor(window.innerWidth * RENDER_SCALE),
        Math.floor(window.innerHeight * RENDER_SCALE)
    );
    postMaterial.uniforms.uResolution.value.set(crtRenderTarget.width, crtRenderTarget.height);
    displayMaterial.uniforms.uResolution.value.set(crtRenderTarget.width, crtRenderTarget.height);
});
