import * as THREE from 'three';
import { CHUNK_SIZE, RENDER_DISTANCE } from './config.js';

const CLOUD_COUNT = 14;
const CLOUD_RANGE = CHUNK_SIZE * RENDER_DISTANCE * 1.0;
const CLOUD_HEIGHT_MIN = 45;
const CLOUD_HEIGHT_MAX = 70;

let cloudMesh;
const cloudInstances = [];

const dummy = new THREE.Object3D();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();

export function initClouds(scene, globalShaderUniforms) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial({
        color: 0xf8f8f8,
        flatShading: true,
        transparent: true,
        opacity: 0.95
    });

    material.onBeforeCompile = (shader) => {
        shader.uniforms.uCurvature = globalShaderUniforms.uCurvature;
        shader.uniforms.uBendCenter = globalShaderUniforms.uBendCenter;
        shader.uniforms.uPsxTexel = globalShaderUniforms.uPsxTexel;

        shader.vertexShader = shader.vertexShader.replace(
            '#include <common>',
            `
            uniform float uCurvature;
            uniform vec3 uBendCenter;
            uniform vec2 uPsxTexel;
            #include <common>
            `
        );
        
        shader.vertexShader = shader.vertexShader.replace(
            '#include <project_vertex>', 
            `
            vec4 bentWorldPosition = vec4( transformed, 1.0 );
            #ifdef USE_BATCHING
                bentWorldPosition = batchingMatrix * bentWorldPosition;
            #endif
            #ifdef USE_INSTANCING
                bentWorldPosition = instanceMatrix * bentWorldPosition;
            #endif
            bentWorldPosition = modelMatrix * bentWorldPosition;

            float dist = distance(bentWorldPosition.xz, uBendCenter.xz);
            float bendFactor = dist * dist * uCurvature;
            bentWorldPosition.y -= bendFactor;

            vec4 mvPosition = viewMatrix * bentWorldPosition;
            gl_Position = projectionMatrix * mvPosition;
            vec2 snap = uPsxTexel * gl_Position.w;
            gl_Position.xy = floor(gl_Position.xy / snap) * snap;

            #ifdef USE_FOG
                vFogDepth = length(mvPosition.xyz);
            #endif
            `
        );

        shader.vertexShader = shader.vertexShader.replace(
            '#include <worldpos_vertex>',
            `
            vec4 worldPosition = bentWorldPosition;
            `
        );
    };

    const maxInstances = CLOUD_COUNT * 5;
    cloudMesh = new THREE.InstancedMesh(geometry, material, maxInstances);
    cloudMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    cloudMesh.castShadow = false;
    cloudMesh.receiveShadow = false;
    cloudMesh.frustumCulled = false;
    scene.add(cloudMesh);

    let idx = 0;

    for (let i = 0; i < CLOUD_COUNT; i++) {
        const cx = (Math.random() - 0.5) * CLOUD_RANGE * 2;
        const cz = (Math.random() - 0.5) * CLOUD_RANGE * 2;
        const cy = CLOUD_HEIGHT_MIN + Math.random() * (CLOUD_HEIGHT_MAX - CLOUD_HEIGHT_MIN);
        
        const driftSpeed = 0.5 + Math.random() * 1.2;

        const blobs = 2 + Math.floor(Math.random() * 3);
        const baseScale = 5 + Math.random() * 4;

        for (let j = 0; j < blobs; j++) {
            const ox = (Math.random() - 0.5) * baseScale;
            const oy = (Math.random() - 0.5) * baseScale * 0.6;
            const oz = (Math.random() - 0.5) * baseScale;

            const s = baseScale * (0.6 + Math.random() * 0.4);
            
            dummy.position.set(cx + ox, cy + oy, cz + oz);
            dummy.scale.set(s, s, s);
            dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
            dummy.updateMatrix();

            cloudMesh.setMatrixAt(idx, dummy.matrix);

            cloudInstances.push({
                idx: idx,
                relX: ox, relY: oy, relZ: oz,
                cX: cx, cY: cy, cZ: cz,
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

    for (let i = 0; i < cloudInstances.length; i++) {
        const cloud = cloudInstances[i];

        cloud.cX += cloud.speed * dt;

        if (cloud.cX - playerPos.x > boundary) {
            cloud.cX -= boundary * 2;
        } else if (cloud.cX - playerPos.x < -boundary) {
            cloud.cX += boundary * 2;
        }

        if (cloud.cZ - playerPos.z > boundary) {
            cloud.cZ -= boundary * 2;
        } else if (cloud.cZ - playerPos.z < -boundary) {
            cloud.cZ += boundary * 2;
        }

        dummy.position.set(cloud.cX + cloud.relX, cloud.cY + cloud.relY, cloud.cZ + cloud.relZ);
        dummy.scale.set(cloud.s, cloud.s, cloud.s);
        dummy.rotation.copy(cloud.rot);
        
        dummy.updateMatrix();
        cloudMesh.setMatrixAt(cloud.idx, dummy.matrix);
    }
    
    cloudMesh.instanceMatrix.needsUpdate = true;
}
