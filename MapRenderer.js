import { getTerrainHeight, activeChunks } from './world.js';
import { CHUNK_SIZE } from './config.js';

// Reduced resolution: 2 pixels per world unit is plenty for a map
// (default chunk is 60 units -> 120x120 pixels)
const TILE_RES = 2; 
const TILE_PIXEL_SIZE = CHUNK_SIZE * TILE_RES;
const MAX_GENERATIONS_PER_FRAME = 2; // Strict budget to prevent freezing

class MapRenderer {
    constructor() {
        this.tileCache = new Map();
        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCanvas.width = TILE_PIXEL_SIZE;
        this.offscreenCanvas.height = TILE_PIXEL_SIZE;
        this.offscreenCtx = this.offscreenCanvas.getContext('2d', { alpha: false });
        
        this.generationQueue = [];
    }

    getTile(cx, cz) {
        const key = `${cx},${cz}`;
        if (this.tileCache.has(key)) {
            return this.tileCache.get(key);
        }
        
        // Not in cache. Is it already queued?
        // (Primitive check, could be optimized with a Set)
        const queued = this.generationQueue.find(q => q.cx === cx && q.cz === cz);
        if (!queued) {
            // Push to front (LIFO) or back (FIFO)?
            // For map panning, usually we want new stuff ASAP.
            // But if we zoomed out, we have thousands.
            // Let's just push.
            this.generationQueue.push({ cx, cz, key });
        }
        return null;
    }

    processQueue() {
        let processed = 0;
        
        // Simple heuristic: prioritize chunks closest to the LAST requested view center?
        // For now, just process FIFO, but maybe limit queue size?
        if (this.generationQueue.length > 200) {
            // If queue is huge (zoomed out massive), clear old requests?
            // Or just splice?
            // Let's clear the start if it gets too big to avoid lag debt.
            this.generationQueue.splice(0, this.generationQueue.length - 200);
        }

        while (processed < MAX_GENERATIONS_PER_FRAME && this.generationQueue.length > 0) {
            const req = this.generationQueue.shift(); // Get first
            if (this.tileCache.has(req.key)) continue; // Already done?

            const tile = this.generateTile(req.cx, req.cz);
            this.tileCache.set(req.key, tile);
            processed++;
        }
    }

    generateTile(cx, cz) {
        const ctx = this.offscreenCtx;
        const imgData = ctx.createImageData(TILE_PIXEL_SIZE, TILE_PIXEL_SIZE);
        const data = imgData.data;

        const startX = cx * CHUNK_SIZE;
        const startZ = cz * CHUNK_SIZE;

        for (let y = 0; y < TILE_PIXEL_SIZE; y++) {
            for (let x = 0; x < TILE_PIXEL_SIZE; x++) {
                const wx = startX + (x / TILE_RES);
                const wz = startZ + (y / TILE_RES);

                const h = getTerrainHeight(wx, wz);

                let r, g, b;

                if (h < -4.0) {
                    // Sand
                    r = 0xd2; g = 0xb4; b = 0x8c;
                    if (h < -5) { // Water
                         if (h < -6) { r=30; g=63; b=90; } // Deep
                         else { r=59; g=125; b=156; } // Shallow
                    }
                } else if (h < 0.0) {
                    const t = (h - (-4.0)) / 4.0;
                    r = 0xd2 + (0x4a - 0xd2) * t;
                    g = 0xb4 + (0x6b - 0xb4) * t;
                    b = 0x8c + (0x36 - 0x8c) * t;
                } else if (h < 8.0) {
                    const t = h / 8.0;
                    r = 0x4a + (0x1a - 0x4a) * t;
                    g = 0x6b + (0x33 - 0x6b) * t;
                    b = 0x36 + (0x0a - 0x36) * t;
                } else {
                    const t = Math.min(1.0, (h - 8.0) / 10.0);
                    r = 0x1a + (0x8a - 0x1a) * t;
                    g = 0x33 + (0x8a - 0x33) * t;
                    b = 0x0a + (0x8a - 0x0a) * t;
                }

                const idx = (y * TILE_PIXEL_SIZE + x) * 4;
                data[idx] = r;
                data[idx+1] = g;
                data[idx+2] = b;
                data[idx+3] = 255;
            }
        }

        ctx.putImageData(imgData, 0, 0);
        
        const tileCanvas = document.createElement('canvas');
        tileCanvas.width = TILE_PIXEL_SIZE;
        tileCanvas.height = TILE_PIXEL_SIZE;
        const tileCtx = tileCanvas.getContext('2d');
        tileCtx.drawImage(this.offscreenCanvas, 0, 0);
        return tileCanvas;
    }

    draw(ctx, viewX, viewZ, scale, width, height) {
        this.processQueue();

        const halfWidth = width / scale / 2;
        const halfHeight = height / scale / 2;
        const left = viewX - halfWidth;
        const right = viewX + halfWidth;
        const top = viewZ - halfHeight;
        const bottom = viewZ + halfHeight;

        const minCx = Math.floor(left / CHUNK_SIZE);
        const maxCx = Math.floor(right / CHUNK_SIZE);
        const minCz = Math.floor(top / CHUNK_SIZE);
        const maxCz = Math.floor(bottom / CHUNK_SIZE);

        const cx = width / 2;
        const cy = height / 2;

        // Optimization: If zoomed out way too far, don't draw individual tiles if not ready,
        // or draw a simplified representation? 
        // For now, rely on generation budget to keep FPS up. 
        // Missing tiles will just leave gaps (black background) until generated.

        for (let cz = minCz; cz <= maxCz; cz++) {
            for (let cxCoord = minCx; cxCoord <= maxCx; cxCoord++) {
                const tile = this.getTile(cxCoord, cz);
                
                const chunkWorldX = cxCoord * CHUNK_SIZE;
                const chunkWorldZ = cz * CHUNK_SIZE;

                const screenX = cx + (chunkWorldX - viewX) * scale;
                const screenY = cy + (chunkWorldZ - viewZ) * scale;
                const screenSize = CHUNK_SIZE * scale;

                if (tile) {
                    ctx.drawImage(tile, screenX, screenY, screenSize + 0.5, screenSize + 0.5);
                } else {
                    // Placeholder for loading
                    // ctx.fillStyle = '#222';
                    // ctx.fillRect(screenX, screenY, screenSize, screenSize);
                }
            }
        }
    }

    drawTrees(ctx, viewX, viewZ, scale, width, height) {
        // Only draw trees if we are zoomed in enough. 
        // Drawing thousands of tree dots when zoomed out is also a performance killer.
        if (scale < 0.5) return;

        const cx = width / 2;
        const cy = height / 2;
        const treeRadius = 2 * (scale / 3);

        ctx.fillStyle = '#0d1a05'; 

        for (const chunk of activeChunks.values()) {
            if (chunk.userData && chunk.userData.trees) {
                for (const tree of chunk.userData.trees) {
                    const dx = (tree.x - viewX) * scale;
                    const dy = (tree.z - viewZ) * scale;
                    
                    if (dx < -width/2 - 10 || dx > width/2 + 10 || 
                        dy < -height/2 - 10 || dy > height/2 + 10) continue;

                    ctx.beginPath();
                    ctx.arc(cx + dx, cy + dy, treeRadius, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }
    }

    pruneCache(currentCx, currentCz, keepDistance) {
        for (const key of this.tileCache.keys()) {
            const [kx, kz] = key.split(',').map(Number);
            if (Math.abs(kx - currentCx) > keepDistance || Math.abs(kz - currentCz) > keepDistance) {
                this.tileCache.delete(key);
            }
        }
    }
}

export const mapRenderer = new MapRenderer();