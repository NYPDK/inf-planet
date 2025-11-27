import { physicsParams, playerPos } from './physics.js';
import { DEFAULTS, CHUNK_SIZE } from './config.js';
import { activeChunks, getTerrainHeight } from './world.js';
import { initLargeMap, toggleLargeMap, updateLargeMapWithCamera } from './LargeMap.js';
import { keys } from './input.js';
import * as THREE from 'three';

let minimapCtx;
let minimapCanvas;
let minimapTimer = 0;
const MINIMAP_INTERVAL = 0.02;
const MINIMAP_SCALE = 3;
const TRAIL_DURATION = 300.0;
let playerPath = [];
let lastMapKey = false;

// Reusable vector for minimap rotation
const _forward = new THREE.Vector3();
const _zAxis = new THREE.Vector3(0, 0, -1);

export function initUI(controls) {
    const instructions = document.getElementById('instructions');
    const crosshair = document.getElementById('crosshair');
    const speedHud = document.getElementById('speedHud');
    const sensSlider = document.getElementById('sensSlider');
    const speedSlider = document.getElementById('speedSlider');
    const jumpSlider = document.getElementById('jumpSlider');
    const gravitySlider = document.getElementById('gravitySlider');
    const airMaxSlider = document.getElementById('airMaxSlider');
    const resetBtn = document.getElementById('resetBtn');
    const settingsMenu = document.getElementById('settings-menu');

    minimapCanvas = document.getElementById('minimap');
    minimapCtx = minimapCanvas.getContext('2d');

    initLargeMap(controls);

    // --- Event Listeners ---
    instructions.addEventListener('click', () => controls.lock());

    controls.addEventListener('lock', () => {
        instructions.style.display = 'none';
        crosshair.style.display = 'block';
        speedHud.style.display = 'block';
    });

    controls.addEventListener('unlock', () => {
        // Only show instructions if NOT in map mode
        // We can check style of large map
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

    resetBtn.addEventListener('click', () => {
        physicsParams.MOVE_SPEED = DEFAULTS.MOVE_SPEED;
        physicsParams.JUMP_FORCE = DEFAULTS.JUMP_FORCE;
        physicsParams.GRAVITY = DEFAULTS.GRAVITY;
        controls.pointerSpeed = DEFAULTS.SENSITIVITY;
        physicsParams.MAX_AIR_SPEED = DEFAULTS.MAX_AIR_SPEED;

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

    // Initialize UI with current values
    speedSlider.value = physicsParams.MOVE_SPEED;
    jumpSlider.value = physicsParams.JUMP_FORCE;
    gravitySlider.value = physicsParams.GRAVITY;
    sensSlider.value = DEFAULTS.SENSITIVITY; // Controls not yet linked to params directly in same way
    airMaxSlider.value = physicsParams.MAX_AIR_SPEED;

    updateDisplay('val-speed', physicsParams.MOVE_SPEED);
    updateDisplay('val-jump', physicsParams.JUMP_FORCE);
    updateDisplay('val-grav', physicsParams.GRAVITY);
    updateDisplay('val-sens', DEFAULTS.SENSITIVITY.toFixed(1));
    updateDisplay('val-airmax', physicsParams.MAX_AIR_SPEED.toFixed(1));
}

export function updateUI(dt, clock, camera) {
    // Check for Map Toggle
    if (keys.map && !lastMapKey) {
        toggleLargeMap();
    }
    lastMapKey = keys.map;

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

    const step = 4; 
    for (let py = 0; py < minimapCanvas.height; py += step) {
        for (let px = 0; px < minimapCanvas.width; px += step) {
            const wx = playerPos.x + (px - cx) / MINIMAP_SCALE;
            const wz = playerPos.z + (py - cy) / MINIMAP_SCALE;
            const h = getTerrainHeight(wx, wz);
            
            let color = '#4a6b36'; 
            if (h < -6) color = '#1e3f5a'; 
            else if (h < -5) color = '#3b7d9c'; 
            else if (h < -4) color = '#d2b48c'; 
            else if (h > 5) color = '#1a330a'; 

            minimapCtx.fillStyle = color;
            minimapCtx.fillRect(px, py, step, step);
        }
    }

    minimapCtx.fillStyle = '#0d1a05'; 
    for (const chunk of activeChunks.values()) {
        if (chunk.userData && chunk.userData.trees) {
            for (const tree of chunk.userData.trees) {
                const dx = (tree.x - playerPos.x) * MINIMAP_SCALE;
                const dy = (tree.z - playerPos.z) * MINIMAP_SCALE;
                if (Math.abs(dx) < cx && Math.abs(dy) < cy) {
                    minimapCtx.beginPath();
                    minimapCtx.arc(cx + dx, cy + dy, 2, 0, Math.PI * 2);
                    minimapCtx.fill();
                }
            }
        }
    }

    playerPath.push({ x: playerPos.x, z: playerPos.z, t: now });
    playerPath = playerPath.filter(p => now - p.t < TRAIL_DURATION);

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