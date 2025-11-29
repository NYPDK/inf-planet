import { physicsParams, playerPos, velocity } from './physics.js';
import { DEFAULTS, CHUNK_SIZE, GRAPHICS_SETTINGS, CURVATURE_STRENGTH } from './config.js';
import { activeChunks, getTerrainHeight } from './world.js';
import { initLargeMap, toggleLargeMap, updateLargeMapWithCamera } from './LargeMap.js';
import { keys } from './input.js';
import { mapRenderer } from './MapRenderer.js';
import * as THREE from 'three';

let minimapCtx;
let minimapCanvas;
let minimapTimer = 0;
const MINIMAP_INTERVAL = 0.02;
const MINIMAP_SCALE = 3;
const TRAIL_DURATION = 300.0;
let playerPath = [];
let lastMapKey = false;

// Throttled HUD updates
let hudTimer = 0;
const HUD_INTERVAL = 0.1;
let velEl, posEl;

const _forward = new THREE.Vector3();
const _zAxis = new THREE.Vector3(0, 0, -1);

export function initUI(controls) {
    const instructions = document.getElementById('instructions');
    const crosshair = document.getElementById('crosshair');
    const speedHud = document.getElementById('speedHud');
    velEl = document.getElementById('vel');
    posEl = document.getElementById('pos');

    const sensSlider = document.getElementById('sensSlider');
    const speedSlider = document.getElementById('speedSlider');
    const jumpSlider = document.getElementById('jumpSlider');
    const gravitySlider = document.getElementById('gravitySlider');
    const airMaxSlider = document.getElementById('airMaxSlider');
    const curvatureSlider = document.getElementById('curvatureSlider');
    const targetFpsInput = document.getElementById('targetFpsInput');
    const resetBtn = document.getElementById('resetBtn');
    const settingsMenu = document.getElementById('settings-menu');

    minimapCanvas = document.getElementById('minimap');
    minimapCtx = minimapCanvas.getContext('2d');

    initLargeMap(controls);
    
    // Set initial state

    instructions.addEventListener('click', () => controls.lock());

    controls.addEventListener('lock', () => {
        instructions.style.display = 'none';
        crosshair.style.display = 'block';
        speedHud.style.display = 'block';
    });

    controls.addEventListener('unlock', () => {
        const largeMap = document.getElementById('largeMap');
        if (largeMap.style.display === 'none') {
            instructions.style.display = 'block';
            crosshair.style.display = 'none';
            speedHud.style.display = 'none';
        }
    });

    settingsMenu.addEventListener('click', (e) => e.stopPropagation());
    settingsMenu.addEventListener('mousedown', (e) => e.stopPropagation());

    function updateDisplay(id, val) {
        const el = document.getElementById(id);
        if(el) el.innerText = val;
    }

    sensSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        controls.pointerSpeed = val;
        updateDisplay('val-sens', val.toFixed(1));
    });

    speedSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        physicsParams.MOVE_SPEED = val;
        updateDisplay('val-speed', val);
    });

    jumpSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        physicsParams.JUMP_FORCE = val;
        updateDisplay('val-jump', val);
    });

    gravitySlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        physicsParams.GRAVITY = val;
        updateDisplay('val-grav', val);
    });

    airMaxSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        physicsParams.MAX_AIR_SPEED = val;
        updateDisplay('val-airmax', val.toFixed(1));
    });

    if (curvatureSlider) {
        const applyCurvature = (v) => {
            GRAPHICS_SETTINGS.CURVATURE = v;
            updateDisplay('val-curv', v.toFixed(4));
        };
        curvatureSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            applyCurvature(val);
        });
        curvatureSlider.value = GRAPHICS_SETTINGS.CURVATURE ?? CURVATURE_STRENGTH;
        applyCurvature(parseFloat(curvatureSlider.value));
    }

    resetBtn.addEventListener('click', () => {
        physicsParams.MOVE_SPEED = DEFAULTS.MOVE_SPEED;
        physicsParams.JUMP_FORCE = DEFAULTS.JUMP_FORCE;
        physicsParams.GRAVITY = DEFAULTS.GRAVITY;
        controls.pointerSpeed = DEFAULTS.SENSITIVITY;
        physicsParams.MAX_AIR_SPEED = DEFAULTS.MAX_AIR_SPEED;
        if (curvatureSlider) {
            curvatureSlider.value = CURVATURE_STRENGTH;
            curvatureSlider.dispatchEvent(new Event('input'));
        }

        speedSlider.value = physicsParams.MOVE_SPEED;
        jumpSlider.value = physicsParams.JUMP_FORCE;
        gravitySlider.value = physicsParams.GRAVITY;
        sensSlider.value = controls.pointerSpeed;
        airMaxSlider.value = physicsParams.MAX_AIR_SPEED;
        updateDisplay('val-speed', physicsParams.MOVE_SPEED);
        updateDisplay('val-jump', physicsParams.JUMP_FORCE);
        updateDisplay('val-grav', physicsParams.GRAVITY);
        updateDisplay('val-sens', controls.pointerSpeed.toFixed(1));
        updateDisplay('val-airmax', physicsParams.MAX_AIR_SPEED.toFixed(1));
    });

    speedSlider.value = physicsParams.MOVE_SPEED;
    jumpSlider.value = physicsParams.JUMP_FORCE;
    gravitySlider.value = physicsParams.GRAVITY;
    sensSlider.value = DEFAULTS.SENSITIVITY;
    controls.pointerSpeed = DEFAULTS.SENSITIVITY;
    airMaxSlider.value = physicsParams.MAX_AIR_SPEED;
    if (targetFpsInput) {
        targetFpsInput.disabled = true;
        targetFpsInput.style.display = 'none';
        const targetLabel = document.getElementById('val-targetfps');
        if (targetLabel) targetLabel.innerText = `${GRAPHICS_SETTINGS.TARGET_FPS.toFixed(0)} (auto)`;
    }

    updateDisplay('val-speed', physicsParams.MOVE_SPEED);
    updateDisplay('val-jump', physicsParams.JUMP_FORCE);
    updateDisplay('val-grav', physicsParams.GRAVITY);
    updateDisplay('val-sens', DEFAULTS.SENSITIVITY.toFixed(1));
    updateDisplay('val-airmax', physicsParams.MAX_AIR_SPEED.toFixed(1));
    updateDisplay('val-targetfps', `${GRAPHICS_SETTINGS.TARGET_FPS.toFixed(0)} (auto)`);
}

export function updateUI(dt, clock, camera) {
    if (keys.map && !lastMapKey) {
        toggleLargeMap();
    }
    lastMapKey = keys.map;

    hudTimer += dt;
    if (hudTimer > HUD_INTERVAL) {
        hudTimer = 0;
        if (velEl) {
            const hVel = Math.sqrt(velocity.x**2 + velocity.z**2);
            velEl.innerText = hVel.toFixed(0);
        }
        if (posEl) {
            posEl.innerText = `${Math.round(playerPos.x)}, ${Math.round(playerPos.z)}`;
        }
    }

    minimapTimer += dt;
    if (minimapTimer > MINIMAP_INTERVAL) {
        drawMinimap(clock.getElapsedTime(), camera);
        updateLargeMapWithCamera(playerPath, camera);
        minimapTimer = 0;
    }
}

function drawMinimap(now, camera) {
    const cx = minimapCanvas.width / 2;
    const cy = minimapCanvas.height / 2;

    // Use MapRenderer
    // Clear first? draw draws over, but maybe not fully if zoomed out?
    // But for minimap we fill the whole canvas usually.
    // Let's allow mapRenderer to handle drawing.
    // Note: LargeMap was clearing with rgba(0,0,0,0.85), minimap usually opaque or specific background?
    // LargeMap logic:
    // ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    // ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Minimap previously filled rects, effectively opaque.
    // So we don't strictly need to clear if we cover everything, but good practice.
    minimapCtx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);

    mapRenderer.draw(minimapCtx, playerPos.x, playerPos.z, MINIMAP_SCALE, minimapCanvas.width, minimapCanvas.height);
    mapRenderer.drawTrees(minimapCtx, playerPos.x, playerPos.z, MINIMAP_SCALE, minimapCanvas.width, minimapCanvas.height);


    playerPath.push({ x: playerPos.x, z: playerPos.z, t: now });
    
    // Remove old points from the start (efficient since sorted by time)
    let removeCount = 0;
    for (const p of playerPath) {
        if (now - p.t >= TRAIL_DURATION) {
            removeCount++;
        } else {
            break;
        }
    }
    if (removeCount > 0) {
        playerPath.splice(0, removeCount);
    }

    minimapCtx.strokeStyle = '#ffff00';
    minimapCtx.lineWidth = 2;
    minimapCtx.beginPath();
    
    let first = true;
    for (const p of playerPath) {
        const dx = (p.x - playerPos.x) * MINIMAP_SCALE;
        const dy = (p.z - playerPos.z) * MINIMAP_SCALE; 
        
        if (Math.abs(dx) > cx || Math.abs(dy) > cy) {
             if (!first) minimapCtx.stroke(); 
             first = true; 
             minimapCtx.beginPath();
             continue;
        }

        if (first) {
            minimapCtx.moveTo(cx + dx, cy + dy);
            first = false;
        } else {
            minimapCtx.lineTo(cx + dx, cy + dy);
        }
    }
    minimapCtx.stroke();

    minimapCtx.save();
    minimapCtx.translate(cx, cy);
    
    _forward.copy(_zAxis).applyQuaternion(camera.quaternion);
    const rotation = Math.PI - Math.atan2(_forward.x, _forward.z);
    minimapCtx.rotate(rotation);

    minimapCtx.fillStyle = 'red';
    minimapCtx.beginPath();
    minimapCtx.moveTo(0, -6);
    minimapCtx.lineTo(5, 5);
    minimapCtx.lineTo(0, 3);
    minimapCtx.lineTo(-5, 5);
    minimapCtx.closePath();
    minimapCtx.fill();
    minimapCtx.restore();
}
