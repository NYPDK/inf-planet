import { getTerrainHeight, activeChunks } from './world.js';
import { playerPos } from './physics.js';
import { mapRenderer } from './MapRenderer.js';

let canvas;
let ctx;
let isVisible = false;
let scale = 3;
const TRAIL_DURATION = 300.0;

let viewX = 0;
let viewZ = 0;
let isDragging = false;
let lastMouseX = 0;
let lastMouseY = 0;

let controlsRef = null;

let mouseScreenX = -1;
let mouseScreenY = -1;

export function initLargeMap(controls) {
    controlsRef = controls;
    canvas = document.getElementById('largeMap');
    ctx = canvas.getContext('2d');

    resize();
    window.addEventListener('resize', resize);

    canvas.addEventListener('mousedown', e => {
        if (!isVisible) return;
        isDragging = true;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        canvas.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', e => {
        if (!isDragging && isVisible) {
            mouseScreenX = e.clientX;
            mouseScreenY = e.clientY;
        } else if (isDragging && isVisible) {
            const dx = e.clientX - lastMouseX;
            const dy = e.clientY - lastMouseY;

            viewX -= dx / scale;
            viewZ -= dy / scale;
        }
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
    });

    canvas.addEventListener('mouseup', () => {
        isDragging = false;
        if (isVisible) canvas.style.cursor = 'grab';
    });

    canvas.addEventListener('mouseleave', () => {
        mouseScreenX = -1;
        mouseScreenY = -1;
    });

    canvas.addEventListener('wheel', e => {
        if (!isVisible) return;
        e.preventDefault();
        const zoomSpeed = 0.001;
        const newScale = Math.max(0.5, Math.min(20, scale - e.deltaY * zoomSpeed * scale));
        scale = newScale;
    });
}

function resize() {
    if (canvas) {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
}

export function toggleLargeMap() {
    isVisible = !isVisible;
    canvas.style.display = isVisible ? 'block' : 'none';
    
    if (isVisible) {
        controlsRef.unlock();
        viewX = playerPos.x;
        viewZ = playerPos.z;
        canvas.style.cursor = 'grab';
    } else {
        controlsRef.lock();
    }
}

export function updateLargeMap(playerPath, cameraQuaternion) {
    if (!isVisible || !ctx) return;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    // Use MapRenderer for terrain and trees
    mapRenderer.draw(ctx, viewX, viewZ, scale, canvas.width, canvas.height);
    mapRenderer.drawTrees(ctx, viewX, viewZ, scale, canvas.width, canvas.height);

    if (playerPath.length > 1) {
        ctx.strokeStyle = '#ffff00';
        ctx.lineWidth = 2 * (scale / 3);
        ctx.beginPath();
        
        let first = true;
        for (const p of playerPath) {
            const screenX = cx + (p.x - viewX) * scale;
            const screenY = cy + (p.z - viewZ) * scale;
            
            if (first) {
                ctx.moveTo(screenX, screenY);
                first = false;
            } else {
                ctx.lineTo(screenX, screenY);
            }
        }
        ctx.stroke();
    }

    const pScreenX = cx + (playerPos.x - viewX) * scale;
    const pScreenY = cy + (playerPos.z - viewZ) * scale;

    ctx.save();
    ctx.translate(pScreenX, pScreenY);
    ctx.fillStyle = 'red';
    ctx.beginPath();
    ctx.arc(0, 0, 4 * (scale/3), 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
}

export function updateLargeMapWithCamera(playerPath, camera) {
    if (!isVisible || !ctx) return;
    
    const _forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const rotation = Math.PI - Math.atan2(_forward.x, _forward.z);

    updateLargeMap(playerPath); 

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const pScreenX = cx + (playerPos.x - viewX) * scale;
    const pScreenY = cy + (playerPos.z - viewZ) * scale;

    ctx.save();
    ctx.translate(pScreenX, pScreenY);
    ctx.rotate(rotation);
    
    const size = 6 * (scale / 3);
    ctx.fillStyle = 'red';
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size, size);
    ctx.lineTo(0, size * 0.6);
    ctx.lineTo(-size, size);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    if (mouseScreenX !== -1 && mouseScreenY !== -1) {
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;

        const worldX = viewX + (mouseScreenX - cx) / scale;
        const worldZ = viewZ + (mouseScreenY - cy) / scale;

        ctx.font = 'bold 16px Arial';
        ctx.fillStyle = 'white';
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 3;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        const coordsText = `X: ${Math.round(worldX)}, Z: ${Math.round(worldZ)}`;

        ctx.strokeText(coordsText, mouseScreenX, mouseScreenY + 15);
        ctx.fillText(coordsText, mouseScreenX, mouseScreenY + 15);
    }
}

import * as THREE from 'three';
