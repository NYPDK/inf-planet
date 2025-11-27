import * as THREE from 'three';
import { CHUNK_SIZE, RENDER_DISTANCE } from './config.js';

const CLOUD_COUNT = 40; // Number of distinct clouds
const CLOUD_RANGE = CHUNK_SIZE * RENDER_DISTANCE * 1.2; // Radius to spawn/keep clouds
const CLOUD_HEIGHT_MIN = 50;
const CLOUD_HEIGHT_MAX = 90;

let cloudMesh;
const cloudInstances = []; // Stores { position, scale, rotation, speed, clumpId }

const dummy = new THREE.Object3D();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();

export function initClouds(scene, globalShaderUniforms) {
    // Use low-poly geometry
    const geometry = new THREE.DodecahedronGeometry(1, 0);
    const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.3,
        flatShading: true,
        transparent: true,
        opacity: 0.85
    });

    // Apply curvature and fog to clouds
    material.onBeforeCompile = (shader) => {
        // Add custom uniforms
        shader.uniforms.uCurvature = globalShaderUniforms.uCurvature;
        shader.uniforms.uBendCenter = globalShaderUniforms.uBendCenter;

        // Inject uniform declarations
        shader.vertexShader = shader.vertexShader.replace(
            '#include <common>',
            `
            uniform float uCurvature;
            uniform vec3 uBendCenter;
            #include <common>
            `
        );
        
        // Inject curvature logic right before gl_Position calculation
        shader.vertexShader = shader.vertexShader.replace(
            '#include <project_vertex>', 
            `
            // Compute bent world position with instancing/batching support
            vec4 bentWorldPosition = vec4( transformed, 1.0 );
            #ifdef USE_BATCHING
                bentWorldPosition = batchingMatrix * bentWorldPosition;
            #endif
            #ifdef USE_INSTANCING
                bentWorldPosition = instanceMatrix * bentWorldPosition;
            #endif
            bentWorldPosition = modelMatrix * bentWorldPosition;

            // Calculate horizontal distance from the bend center
            float dist = distance(bentWorldPosition.xz, uBendCenter.xz);
            
            // Quadratic bend factor
            float bendFactor = dist * dist * uCurvature;
            
            // Apply the bend to the world position's Y-coordinate
            bentWorldPosition.y -= bendFactor;

            // Now, transform this *bent* world position to view space, then clip space
            vec4 mvPosition = viewMatrix * bentWorldPosition;
            gl_Position = projectionMatrix * mvPosition;

            // Re-add fog calculation
            #ifdef USE_FOG
                vFogDepth = length(mvPosition.xyz);
            #endif
            `
        );

        // Prevent worldPosition redefinition by skipping the default worldpos chunk
        shader.vertexShader = shader.vertexShader.replace(
            '#include <worldpos_vertex>',
            `
            // worldPosition already computed with curvature above
            vec4 worldPosition = bentWorldPosition;
            `
        );
    };

    // Estimated instances: Cloud Count * Avg Blobs per cloud (e.g. 3-6)
    const maxInstances = CLOUD_COUNT * 8;
    cloudMesh = new THREE.InstancedMesh(geometry, material, maxInstances);
    cloudMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    cloudMesh.castShadow = false; // Clouds casting shadows can be expensive/distracting on large terrain
    cloudMesh.receiveShadow = false;
    cloudMesh.frustumCulled = false; // Prevent culling issues with wide cloud spread + curvature
    scene.add(cloudMesh);

    let idx = 0;

    for (let i = 0; i < CLOUD_COUNT; i++) {
        // Generate a random starting position for this cloud "clump"
        const cx = (Math.random() - 0.5) * CLOUD_RANGE * 2;
        const cz = (Math.random() - 0.5) * CLOUD_RANGE * 2;
        const cy = CLOUD_HEIGHT_MIN + Math.random() * (CLOUD_HEIGHT_MAX - CLOUD_HEIGHT_MIN);
        
        const driftSpeed = 1.0 + Math.random() * 3.0; // Random drift speed for this cloud

        // Create blobs for this cloud
        const blobs = 3 + Math.floor(Math.random() * 4);
        const baseScale = 6 + Math.random() * 8;

        for (let j = 0; j < blobs; j++) {
            // Offset blob from center
            const ox = (Math.random() - 0.5) * baseScale;
            const oy = (Math.random() - 0.5) * baseScale * 0.6;
            const oz = (Math.random() - 0.5) * baseScale;

            const s = baseScale * (0.6 + Math.random() * 0.4);
            
            dummy.position.set(cx + ox, cy + oy, cz + oz);
            dummy.scale.set(s, s, s);
            dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
            dummy.updateMatrix();

            cloudMesh.setMatrixAt(idx, dummy.matrix);

            // Store data for updates
            cloudInstances.push({
                idx: idx,
                relX: ox, relY: oy, relZ: oz, // Relative to cloud center
                cX: cx, cY: cy, cZ: cz,       // Cloud center (World)
                s: s,
                rot: dummy.rotation.clone(),
                speed: driftSpeed
            });
            
            idx++;
        }
    }
    cloudMesh.count = idx;
}

export function updateClouds(dt, playerPos) {
    if (!cloudMesh) return;

    const boundary = CLOUD_RANGE;

    // We iterate through instances.
    // Optimization: Clouds move together. We could group them logic-wise, 
    // but updating linear arrays is fast enough for ~200 instances.

    for (let i = 0; i < cloudInstances.length; i++) {
        const cloud = cloudInstances[i];

        // Move the "center" of the cloud
        cloud.cX += cloud.speed * dt;

        // Wrap logic (Infinite Sky)
        // Check distance from player on X/Z axes
        
        // X Axis Wrap
        if (cloud.cX - playerPos.x > boundary) {
            cloud.cX -= boundary * 2;
        } else if (cloud.cX - playerPos.x < -boundary) {
            cloud.cX += boundary * 2;
        }

        // Z Axis Wrap
        if (cloud.cZ - playerPos.z > boundary) {
            cloud.cZ -= boundary * 2;
        } else if (cloud.cZ - playerPos.z < -boundary) {
            cloud.cZ += boundary * 2;
        }

        // Recompose Matrix
        dummy.position.set(cloud.cX + cloud.relX, cloud.cY + cloud.relY, cloud.cZ + cloud.relZ);
        dummy.scale.set(cloud.s, cloud.s, cloud.s);
        dummy.rotation.copy(cloud.rot);
        
        // Slowly rotate blobs for dynamic effect?
        // dummy.rotation.x += dt * 0.05;
        // dummy.rotation.y += dt * 0.02;
        // cloud.rot.copy(dummy.rotation);

        dummy.updateMatrix();
        cloudMesh.setMatrixAt(cloud.idx, dummy.matrix);
    }
    
    cloudMesh.instanceMatrix.needsUpdate = true;
}
