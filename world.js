import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { CHUNK_SIZE, RENDER_DISTANCE, TREE_COUNT, GRASS_COUNT } from './config.js';
import { materials, geometries } from './resources.js';

export const activeChunks = new Map();
const noise2D = createNoise2D();
const dummy = new THREE.Object3D();
const buildQueue = [];
const buildQueueSet = new Set();
const removeQueue = [];
const removeQueueSet = new Set();
const MAX_CHUNK_BUILDS_PER_FRAME = 1;
const MAX_CHUNK_REMOVES_PER_FRAME = 1;

export function getTerrainHeight(x, z) {
    let y = 0;
    let n = noise2D(x * 0.008, z * 0.008);
    y += Math.pow(1.0 - Math.abs(n), 1.5) * 15.0; 
    
    y += noise2D(x * 0.04, z * 0.04) * 4.0;
    
    y -= 10.0; 
    
    return y;
}

function createChunk(cx, cz, scene) {
    const group = new THREE.Group();
    
    const geometry = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, 32, 32);
    geometry.rotateX(-Math.PI / 2);
    const posAttr = geometry.attributes.position;
    
    const colors = [];
    const color = new THREE.Color();
    const c1 = new THREE.Color(0xd2b48c);
    const c2 = new THREE.Color(0x4a6b36);
    const c3 = new THREE.Color(0x1a330a);
    const c4 = new THREE.Color(0x8a8a8a);

    for (let i = 0; i < posAttr.count; i++) {
        const x = posAttr.getX(i) + cx * CHUNK_SIZE;
        const z = posAttr.getZ(i) + cz * CHUNK_SIZE;
        const h = getTerrainHeight(x, z);
        posAttr.setY(i, h);

        if (h < -4.0) {
             color.copy(c1);
        } else if (h < 0.0) {
             const t = (h - (-4.0)) / 4.0;
             color.lerpColors(c1, c2, t);
        } else if (h < 8.0) {
             const t = h / 8.0;
             color.lerpColors(c2, c3, t);
        } else {
             const t = Math.min(1.0, (h - 8.0) / 10.0);
             color.lerpColors(c3, c4, t);
        }
        colors.push(color.r, color.g, color.b);
    }
    
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    const terrain = new THREE.Mesh(geometry, materials.groundMat);
    terrain.receiveShadow = true;
    terrain.castShadow = true; // Terrain self-shadowing
    terrain.customDepthMaterial = materials.depthMat;
    terrain.frustumCulled = false;
    group.add(terrain);

    const trunkMesh = new THREE.InstancedMesh(geometries.trunkGeo, materials.trunkMat, TREE_COUNT);
    trunkMesh.castShadow = true;
    trunkMesh.receiveShadow = true;
    trunkMesh.customDepthMaterial = materials.depthMat;
    trunkMesh.frustumCulled = false;

    const leavesMesh = new THREE.InstancedMesh(geometries.leavesGeo, materials.treeMat, TREE_COUNT);
    leavesMesh.castShadow = true;
    leavesMesh.receiveShadow = true;
    leavesMesh.customDepthMaterial = materials.depthMat;
    leavesMesh.frustumCulled = false;

    const grassMesh = new THREE.InstancedMesh(geometries.grassGeo, materials.grassMat, GRASS_COUNT);
    grassMesh.castShadow = true;
    grassMesh.receiveShadow = true;
    grassMesh.customDepthMaterial = materials.grassDepthMat;
    grassMesh.frustumCulled = false;

    const grassDryMesh = new THREE.InstancedMesh(geometries.grassGeo, materials.grassDryMat, GRASS_COUNT);
    grassDryMesh.castShadow = true;
    grassDryMesh.receiveShadow = true;
    grassDryMesh.customDepthMaterial = materials.grassDryDepthMat;
    grassDryMesh.frustumCulled = false;
    
    const existingTrees = [];

    let treeIdx = 0;
    for (let i = 0; i < TREE_COUNT * 3; i++) { 
        if (treeIdx >= TREE_COUNT) break;

        const rx = (Math.random() - 0.5) * CHUNK_SIZE;
        const rz = (Math.random() - 0.5) * CHUNK_SIZE;
        const wx = cx * CHUNK_SIZE + rx;
        const wz = cz * CHUNK_SIZE + rz;
        const h = getTerrainHeight(wx, wz);

        const density = noise2D(wx * 0.02, wz * 0.02);

        if (density < 0.2) continue; 

        let tooClose = false;
        for (let t of existingTrees) {
            const dx = t.x - rx;
            const dz = t.z - rz;
            if (dx*dx + dz*dz < 25) { 
                tooClose = true;
                break;
            }
        }
        if (tooClose) continue;

        const h2 = getTerrainHeight(wx + 2, wz);
        const slope = Math.abs(h - h2);

        if (h > -4 && slope < 1.5) {
            dummy.position.set(rx, h - 0.2, rz); 
            const scale = 0.8 + Math.random() * 0.6;
            const heightScale = scale * (0.8 + Math.random()*0.4);
            dummy.scale.set(scale, heightScale, scale);
            dummy.rotation.set(0, Math.random() * Math.PI, 0);
            dummy.updateMatrix();
            
            trunkMesh.setMatrixAt(treeIdx, dummy.matrix);
            leavesMesh.setMatrixAt(treeIdx, dummy.matrix);
            existingTrees.push({
                x: rx + cx * CHUNK_SIZE, 
                z: rz + cz * CHUNK_SIZE,
                s: scale,
                hs: heightScale
            }); 
            treeIdx++;
        }
    }

    let grassIdx = 0;
    let grassDryIdx = 0;
    for (let i = 0; i < GRASS_COUNT; i++) {
        const rx = (Math.random() - 0.5) * CHUNK_SIZE;
        const rz = (Math.random() - 0.5) * CHUNK_SIZE;
        const wx = cx * CHUNK_SIZE + rx;
        const wz = cz * CHUNK_SIZE + rz;
        const h = getTerrainHeight(wx, wz);

        if (h >= 0.0) {
            dummy.position.set(rx, h, rz);
            const s = 0.8 + Math.random() * 0.5;
            dummy.scale.set(s, s, s);
            dummy.rotation.set(0, Math.random() * Math.PI, 0);
            dummy.updateMatrix();
            grassMesh.setMatrixAt(grassIdx, dummy.matrix);
            grassIdx++;
        } else if (h > -5.0) {
            // Sand / beach zone uses dry grass
            dummy.position.set(rx, h, rz);
            const s = 0.8 + Math.random() * 0.5;
            dummy.scale.set(s, s, s);
            dummy.rotation.set(0, Math.random() * Math.PI, 0);
            dummy.updateMatrix();
            grassDryMesh.setMatrixAt(grassDryIdx, dummy.matrix);
            grassDryIdx++;
        }
    }

    if (treeIdx > 0) {
        trunkMesh.count = treeIdx;
        leavesMesh.count = treeIdx;
        trunkMesh.instanceMatrix.needsUpdate = true;
        leavesMesh.instanceMatrix.needsUpdate = true;
        group.add(trunkMesh);
        group.add(leavesMesh);
    }
    if (grassIdx > 0) {
        grassMesh.count = grassIdx;
        grassMesh.instanceMatrix.needsUpdate = true;
        group.add(grassMesh);
    }
    if (grassDryIdx > 0) {
        grassDryMesh.count = grassDryIdx;
        grassDryMesh.instanceMatrix.needsUpdate = true;
        group.add(grassDryMesh);
    }

    group.userData = { trees: existingTrees };
    group.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
    scene.add(group);
    return group;
}

const _lastUpdatePos = new THREE.Vector3(Infinity, Infinity, Infinity);

export function updateChunks(playerPos, scene) {
    // Always process queues to ensure smooth loading even if player stops
    if (buildQueue.length > 1) {
        buildQueue.sort((a, b) => a.dist2 - b.dist2);
    }
    let built = 0;
    while (built < MAX_CHUNK_BUILDS_PER_FRAME && buildQueue.length > 0) {
        const job = buildQueue.shift();
        buildQueueSet.delete(job.key);
        if (activeChunks.has(job.key)) continue;
        activeChunks.set(job.key, createChunk(job.cx, job.cz, scene));
        built++;
    }

    if (removeQueue.length > 1) {
        removeQueue.sort((a, b) => b.dist2 - a.dist2);
    }
    let removed = 0;
    while (removed < MAX_CHUNK_REMOVES_PER_FRAME && removeQueue.length > 0) {
        const job = removeQueue.shift();
        removeQueueSet.delete(job.key);
        const mesh = job.mesh || activeChunks.get(job.key);
        if (!mesh) continue;
        scene.remove(mesh);
        mesh.traverse((obj) => {
            if (obj.geometry) obj.geometry.dispose();
        });
        activeChunks.delete(job.key);
        removed++;
    }

    // Only check for new chunks if player has moved enough
    if (playerPos.distanceToSquared(_lastUpdatePos) < 16.0) { // 4 units distance
        return built > 0 || removed > 0;
    }
    _lastUpdatePos.copy(playerPos);

    const currentChunkX = Math.floor(playerPos.x / CHUNK_SIZE);
    const currentChunkZ = Math.floor(playerPos.z / CHUNK_SIZE);
    const neededKeys = new Set();

    for (let x = -RENDER_DISTANCE; x <= RENDER_DISTANCE; x++) {
        for (let z = -RENDER_DISTANCE; z <= RENDER_DISTANCE; z++) {
            const cx = currentChunkX + x;
            const cz = currentChunkZ + z;
            const key = `${cx},${cz}`;
            neededKeys.add(key);

            if (!activeChunks.has(key) && !buildQueueSet.has(key)) {
                const dist2 = x * x + z * z;
                buildQueue.push({ key, cx, cz, dist2 });
                buildQueueSet.add(key);
            }
        }
    }

    if (removeQueue.length) {
        for (let i = removeQueue.length - 1; i >= 0; i--) {
            if (neededKeys.has(removeQueue[i].key)) {
                removeQueueSet.delete(removeQueue[i].key);
                removeQueue.splice(i, 1);
            }
        }
    }

    for (const [key, mesh] of activeChunks) {
        if (neededKeys.has(key) || removeQueueSet.has(key)) continue;
        const [kx, kz] = key.split(',').map(Number);
        const dx = kx - currentChunkX;
        const dz = kz - currentChunkZ;
        const dist2 = dx * dx + dz * dz;
        if (dist2 > (RENDER_DISTANCE + 1) * (RENDER_DISTANCE + 1)) {
            removeQueue.push({ key, mesh, dist2 });
            removeQueueSet.add(key);
        }
    }
    
    return built > 0 || removed > 0;
}
