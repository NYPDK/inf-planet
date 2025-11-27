import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { BUMP_REPEAT } from './config.js';

export function generateNoiseTexture() {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;
    const noise = createNoise2D(); 

    for (let i = 0; i < data.length; i += 4) {
        const x = (i / 4) % size;
        const y = Math.floor((i / 4) / size);
        const n2 = noise(x * 0.8, y * 0.8); // High freq for texture
        const v = (n2 * 0.5 + 0.5) * 255; 
        data[i] = v;     
        data[i + 1] = v; 
        data[i + 2] = v; 
        data[i + 3] = 255; 
    }
    ctx.putImageData(imgData, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(BUMP_REPEAT, BUMP_REPEAT); 
    tex.colorSpace = THREE.NoColorSpace; 
    return tex;
}
