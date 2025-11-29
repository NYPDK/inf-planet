import * as THREE from 'three';
import { CHUNK_SIZE, RENDER_DISTANCE, PARTICLE_SETTINGS } from './config.js';
import { getTerrainHeight, activeChunks } from './world.js';

const PARTICLE_COUNT = PARTICLE_SETTINGS?.COUNT ?? 500;
const PARTICLE_RADIUS = CHUNK_SIZE * (RENDER_DISTANCE - 1.0);
const PARTICLE_REPEL_RADIUS = 5.0;
const PARTICLE_REPEL_STRENGTH = 32.0;
const PARTICLE_WIND_MAX = 0.9;
const PARTICLE_WIND_CHANGE_INTERVAL = 6.0;
const PARTICLE_SWIRL_BASE = 1.2;
const PARTICLE_MAX_UPDATES_PER_FRAME = Math.max(1, PARTICLE_SETTINGS?.MAX_UPDATES_PER_FRAME ?? PARTICLE_COUNT);
const PARTICLE_MAX_HEIGHT_ABOVE_GROUND = 20.0;
const PARTICLE_MIN_CLEARANCE = 0.5;
const PARTICLE_GROUND_SOFT_CLEAR = 1.0;
const PARTICLE_GROUND_PUSH = 8.0;
const PARTICLE_WATER_MIN_Y = -4.5;
const PARTICLE_SOFT_CEILING = 0.8;
const PARTICLE_CEILING_PUSH = 6.0;
const PARTICLE_CLUSTER_COUNT = 12;
const PARTICLE_CLUSTER_RADIUS = 4.5;
const PARTICLE_CLUSTER_SPREAD = 1.5;
const PARTICLE_CLUSTER_DRIFT_SPEED = 2.0;
const PARTICLE_CLUSTER_DRIFT_CHANGE_INTERVAL = 4.0;
const PARTICLE_FRONT_CONE_COS = 0.766;
const PARTICLE_FRONT_AVOID_DISTANCE = 12.0;
const BOID_NEIGHBOR_RADIUS = 3.5;
const BOID_SAMPLE_COUNT = Math.max(1, PARTICLE_SETTINGS?.NEIGHBOR_SAMPLES ?? 12);
const BOID_ALIGN_WEIGHT = 3.0;
const BOID_COHESION_WEIGHT = 2.0;
const BOID_SEPARATION_WEIGHT = 6.0;
const BOID_MAX_SPEED = 12.0;
const TERRAIN_CACHE_GRID = PARTICLE_SETTINGS?.HEIGHT_CACHE_GRID ?? 1.25;
const TERRAIN_CACHE_MAX = PARTICLE_SETTINGS?.HEIGHT_CACHE_MAX ?? 2048;
const PARTICLE_MAX_STEP = 0.1;

export function createAirParticles({ scene, camera, globalShaderUniforms, targetAnisotropy, getWaterLevel }) {
    const particleGeometry = new THREE.BufferGeometry();
    const particlePositions = new Float32Array(PARTICLE_COUNT * 3);
    const particleVelocities = new Float32Array(PARTICLE_COUNT * 3);
    let particlePoints;
    let particleTexture;
    let particleMaterialUniforms;
    let particleAspect = 1.0;
    let particleUpdateOffset = 0;
    const particleClusterOffsets = [];
    const particleClusterDrift = [];
    const particleClusterDriftTimer = [];
    const particleClusterSwirl = [];
    const particleClusterIds = new Uint16Array(PARTICLE_COUNT);
    const _globalWind = new THREE.Vector3(0.25, 0.02, 0.25);
    const _windTarget = new THREE.Vector3(0.25, 0.02, 0.25);
    let windTimer = PARTICLE_WIND_CHANGE_INTERVAL;

    const _tmpVec = new THREE.Vector3();
    const _tmpVel = new THREE.Vector3();
    const _tmpOffset = new THREE.Vector3();
    const _boidCenter = new THREE.Vector3();
    const _boidAlign = new THREE.Vector3();
    const _boidSeparate = new THREE.Vector3();
    const _boidNeighbor = new THREE.Vector3();
    const _boidNeighborVel = new THREE.Vector3();
    const _camDir = new THREE.Vector3();
    const _groundNormal = new THREE.Vector3();
    const _swirlVec = new THREE.Vector3();
    const _heightCache = new Map();

    function sampleTerrainHeight(x, z) {
        const qx = Math.round(x / TERRAIN_CACHE_GRID);
        const qz = Math.round(z / TERRAIN_CACHE_GRID);
        const key = `${qx}|${qz}`;
        const cached = _heightCache.get(key);
        if (cached !== undefined) return cached;
        if (_heightCache.size >= TERRAIN_CACHE_MAX) {
            _heightCache.clear();
        }
        const h = getTerrainHeight(qx * TERRAIN_CACHE_GRID, qz * TERRAIN_CACHE_GRID);
        _heightCache.set(key, h);
        return h;
    }

    function clampParticleHeight(pos) {
        const groundY = sampleTerrainHeight(pos.x, pos.z);
        const minY = groundY + PARTICLE_MIN_CLEARANCE;
        const maxY = groundY + PARTICLE_MAX_HEIGHT_ABOVE_GROUND;
        const waterMin = Math.max(minY, PARTICLE_WATER_MIN_Y);
        if (pos.y < waterMin) pos.y = waterMin;
        if (pos.y > maxY) pos.y = maxY;
    }

    function getGroundNormal(x, z) {
        const eps = 0.6;
        const hL = sampleTerrainHeight(x - eps, z);
        const hR = sampleTerrainHeight(x + eps, z);
        const hD = sampleTerrainHeight(x, z - eps);
        const hU = sampleTerrainHeight(x, z + eps);
        _groundNormal.set(-(hR - hL), 2 * eps, -(hU - hD)).normalize();
        return _groundNormal;
    }

    function updateClusterOffsets(dt) {
        for (let i = 0; i < PARTICLE_CLUSTER_COUNT; i++) {
            particleClusterDriftTimer[i] -= dt;
            if (particleClusterDriftTimer[i] <= 0) {
                particleClusterDrift[i].copy(randomInSphere(PARTICLE_CLUSTER_DRIFT_SPEED));
                particleClusterDriftTimer[i] = PARTICLE_CLUSTER_DRIFT_CHANGE_INTERVAL;
            }
            particleClusterOffsets[i].addScaledVector(particleClusterDrift[i], dt);
            if (particleClusterOffsets[i].length() > PARTICLE_RADIUS * 0.75) {
                particleClusterOffsets[i].multiplyScalar(0.8);
            }
        }
    }

    function obstacleAvoidance(pos, vel, dt) {
        const groundY = sampleTerrainHeight(pos.x, pos.z);
        const groundNormal = getGroundNormal(pos.x, pos.z);
        const clearance = pos.y - groundY;
        const desiredY = groundY + PARTICLE_MIN_CLEARANCE + 0.6;
        if (clearance < PARTICLE_GROUND_SOFT_CLEAR) {
            const push = Math.min((PARTICLE_GROUND_SOFT_CLEAR - clearance) * PARTICLE_GROUND_PUSH * dt, PARTICLE_GROUND_PUSH * dt);
            vel.addScaledVector(groundNormal, push);
        }
        if (pos.y < desiredY) {
            vel.y += (desiredY - pos.y) * PARTICLE_GROUND_PUSH * 0.35 * dt;
        }

        const ceilingY = groundY + PARTICLE_MAX_HEIGHT_ABOVE_GROUND * PARTICLE_SOFT_CEILING;
        if (pos.y > ceilingY) {
            const over = pos.y - ceilingY;
            vel.y -= over * PARTICLE_CEILING_PUSH * dt;
        }

        const cx = Math.floor(pos.x / CHUNK_SIZE);
        const cz = Math.floor(pos.z / CHUNK_SIZE);
        const maxDist2 = 6 * 6;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                const key = `${cx + dx},${cz + dz}`;
                const trees = activeChunks.get(key)?.userData?.trees;
                if (!trees || trees.length === 0) continue;
                for (let t = 0; t < trees.length; t++) {
                    const tree = trees[t];
                    const dxp = pos.x - tree.x;
                    const dzp = pos.z - tree.z;
                    const dist2 = dxp * dxp + dzp * dzp;
                    if (dist2 < maxDist2 && dist2 > 0.0001) {
                        const dist = Math.sqrt(dist2);
                        const push = (maxDist2 - dist2) / maxDist2;
                        vel.x += (dxp / dist) * push * 10.0 * dt;
                        vel.z += (dzp / dist) * push * 10.0 * dt;
                    }
                }
            }
        }
    }

    function randomInSphere(radius) {
        const u = Math.random();
        const v = Math.random();
        const theta = u * 2.0 * Math.PI;
        const phi = Math.acos(2.0 * v - 1.0);
        const r = radius * Math.cbrt(Math.random());
        const sinPhi = Math.sin(phi);
        return new THREE.Vector3(
            r * sinPhi * Math.cos(theta),
            r * Math.cos(phi),
            r * sinPhi * Math.sin(theta)
        );
    }

    function updateWind(dt) {
        windTimer -= dt;
        if (windTimer <= 0) {
            _windTarget.copy(randomInSphere(PARTICLE_WIND_MAX));
            _windTarget.y *= 0.2;
            windTimer = PARTICLE_WIND_CHANGE_INTERVAL;
        }
        _globalWind.lerp(_windTarget, Math.min(1, dt * 0.5));
    }

    function isInFrontCone(pos) {
        _tmpOffset.subVectors(pos, camera.position);
        const dist = _tmpOffset.length();
        if (dist < 0.0001) return true;
        _tmpOffset.normalize();
        return dist < PARTICLE_FRONT_AVOID_DISTANCE && _tmpOffset.dot(_camDir) > PARTICLE_FRONT_CONE_COS;
    }

    function findSpawnNear(clusterCenter) {
        let candidate = null;
        for (let tries = 0; tries < 6; tries++) {
            const c = randomInSphere(PARTICLE_CLUSTER_SPREAD).add(clusterCenter);
            if (!isInFrontCone(c)) {
                candidate = c;
                break;
            }
            if (!candidate) candidate = c;
        }
        return candidate;
    }

    function getClusterCenter(idx, out) {
        const offset = particleClusterOffsets[idx % PARTICLE_CLUSTER_COUNT];
        return out.copy(camera.position).add(offset);
    }

    function initAirParticles() {
        camera.getWorldDirection(_camDir);
        particleClusterOffsets.length = 0;
        particleClusterDrift.length = 0;
        particleClusterDriftTimer.length = 0;
        particleClusterSwirl.length = 0;
        for (let c = 0; c < PARTICLE_CLUSTER_COUNT; c++) {
            const offset = randomInSphere(PARTICLE_RADIUS * 0.6);
            particleClusterOffsets.push(offset);
            particleClusterDrift.push(randomInSphere(PARTICLE_CLUSTER_DRIFT_SPEED));
            particleClusterDriftTimer.push(Math.random() * PARTICLE_CLUSTER_DRIFT_CHANGE_INTERVAL);
            const swirlDir = Math.random() < 0.5 ? -1 : 1;
            const swirlSpeed = PARTICLE_SWIRL_BASE * (0.6 + Math.random() * 0.9);
            particleClusterSwirl.push(swirlDir * swirlSpeed);
        }

        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const base = i * 3;
            const clusterId = i % PARTICLE_CLUSTER_COUNT;
            particleClusterIds[i] = clusterId;
            const cluster = getClusterCenter(clusterId, _tmpVec);
            const p = findSpawnNear(cluster);
            clampParticleHeight(p);
            particlePositions[base] = p.x;
            particlePositions[base + 1] = p.y;
            particlePositions[base + 2] = p.z;
            particleVelocities[base] = (Math.random() - 0.5) * 4.0;
            particleVelocities[base + 1] = (Math.random() - 0.5) * 4.0;
            particleVelocities[base + 2] = (Math.random() - 0.5) * 4.0;
        }

        particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
        particleTexture = new THREE.TextureLoader().load('textures/slime.png', (tex) => {
            if (tex && tex.image && tex.image.width && tex.image.height) {
                particleAspect = tex.image.width / tex.image.height;
            }
        });
        particleTexture.colorSpace = THREE.SRGBColorSpace;
        particleTexture.anisotropy = 1;
        particleTexture.minFilter = THREE.NearestFilter;
        particleTexture.magFilter = THREE.NearestFilter;
        particleTexture.generateMipmaps = false;
        particleTexture.wrapS = THREE.ClampToEdgeWrapping;
        particleTexture.wrapT = THREE.ClampToEdgeWrapping;

        particleMaterialUniforms = {
            uCurvature: globalShaderUniforms.uCurvature,
            uBendCenter: globalShaderUniforms.uBendCenter,
            uWaterLevel: { value: typeof getWaterLevel === 'function' ? getWaterLevel() : -5.0 },
            uWaterColor: { value: new THREE.Color(0x3b7d9c) }
        };

        const particleMaterial = new THREE.PointsMaterial({
            map: particleTexture,
            color: 0xffffff,
            size: 0.4,
            sizeAttenuation: true,
            transparent: true,
            opacity: 0.9,
            depthWrite: false,
            depthTest: true,
            alphaTest: 0.1
        });
        particleMaterial.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, particleMaterialUniforms);
            shader.uniforms.uAspect = { value: particleAspect };
            shader.uniforms.uPsxTexel = globalShaderUniforms.uPsxTexel;

            shader.vertexShader = shader.vertexShader.replace(
                '#include <common>',
                `
                uniform float uCurvature;
                uniform vec3 uBendCenter;
                uniform vec2 uPsxTexel;
                varying vec3 vWorldPos;
                #include <common>
                `
            );

            shader.vertexShader = shader.vertexShader.replace(
                '#include <project_vertex>',
                `
                vec4 bentWorldPosition = modelMatrix * vec4( position, 1.0 );
                float dist = distance(bentWorldPosition.xz, uBendCenter.xz);
                float bendFactor = dist * dist * uCurvature;
                bentWorldPosition.y -= bendFactor;

                vWorldPos = bentWorldPosition.xyz;

                vec4 mvPosition = viewMatrix * bentWorldPosition;
                gl_Position = projectionMatrix * mvPosition;
                vec2 snap = uPsxTexel * gl_Position.w;
                gl_Position.xy = floor(gl_Position.xy / snap) * snap;
                `
            );

            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <common>',
                `
                uniform float uWaterLevel;
                uniform vec3 uWaterColor;
                varying vec3 vWorldPos;
                uniform float uAspect;
                #include <common>
                `
            );

            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <map_fragment>',
                `
                #ifdef USE_MAP
                    vec2 uv = vUv;
                    if (uAspect > 1.0) {
                        uv.x = (uv.x - 0.5) * uAspect + 0.5;
                    } else {
                        uv.y = (uv.y - 0.5) / uAspect + 0.5;
                    }
                    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
                    vec4 sampledDiffuseColor = texture2D( map, uv );
                    diffuseColor *= sampledDiffuseColor;
                    float waterMask = step(vWorldPos.y, uWaterLevel);
                    float depthFactor = clamp((uWaterLevel - vWorldPos.y) * 0.2, 0.0, 1.0);
                    vec3 waterTint = mix(uWaterColor, vec3(0.1, 0.35, 0.7), 0.5);
                    diffuseColor.rgb = mix(diffuseColor.rgb, waterTint, waterMask * depthFactor);
                    diffuseColor.a *= mix(1.0, 0.5, waterMask * depthFactor);
                #endif
                `
            );
        };
        particlePoints = new THREE.Points(particleGeometry, particleMaterial);
        particlePoints.frustumCulled = false;
        particlePoints.renderOrder = 2;
        scene.add(particlePoints);
    }

    function updateAirParticles(dt) {
        if (!particlePoints) return;
        if (particleMaterialUniforms && typeof getWaterLevel === 'function') {
            particleMaterialUniforms.uWaterLevel.value = getWaterLevel();
        }
        camera.getWorldDirection(_camDir);
        updateWind(dt);
        updateClusterOffsets(dt);
        const positions = particleGeometry.attributes.position.array;
        const velocities = particleVelocities;
        let needsUpdate = false;

        const updatesThisFrame = Math.min(PARTICLE_MAX_UPDATES_PER_FRAME, PARTICLE_COUNT);
        const stride = Math.max(1, Math.ceil(PARTICLE_COUNT / updatesThisFrame));
        particleUpdateOffset = (particleUpdateOffset + 1) % stride;
        const stepDt = Math.min(dt * stride, PARTICLE_MAX_STEP);
        const neighborSamples = Math.min(BOID_SAMPLE_COUNT, PARTICLE_COUNT - 1);

        for (let i = particleUpdateOffset; i < PARTICLE_COUNT; i += stride) {
            const base = i * 3;
            _tmpVec.set(positions[base], positions[base + 1], positions[base + 2]);
            _tmpVel.set(velocities[base], velocities[base + 1], velocities[base + 2]);
            const clusterId = particleClusterIds[i];
            const clusterCenter = getClusterCenter(clusterId, _boidNeighbor);
            const swirlStrength = particleClusterSwirl[clusterId] || PARTICLE_SWIRL_BASE;

            _boidCenter.set(0, 0, 0);
            _boidAlign.set(0, 0, 0);
            _boidSeparate.set(0, 0, 0);
            let neighborCount = 0;

            for (let n = 0; n < neighborSamples; n++) {
                const idx = Math.floor(Math.random() * PARTICLE_COUNT);
                if (idx === i) continue;
                const nBase = idx * 3;
                const nx = positions[nBase];
                const ny = positions[nBase + 1];
                const nz = positions[nBase + 2];
                _tmpOffset.set(nx - _tmpVec.x, ny - _tmpVec.y, nz - _tmpVec.z);
                const d = _tmpOffset.length();
                if (d > 0 && d < BOID_NEIGHBOR_RADIUS) {
                    neighborCount++;
                    _boidNeighbor.set(nx, ny, nz);
                    _boidCenter.add(_boidNeighbor);
                    _boidNeighborVel.set(
                        velocities[nBase],
                        velocities[nBase + 1],
                        velocities[nBase + 2]
                    );
                    _boidAlign.add(_boidNeighborVel);
                    const sepStrength = (BOID_NEIGHBOR_RADIUS - d) / BOID_NEIGHBOR_RADIUS;
                    _boidSeparate.addScaledVector(_tmpOffset, -sepStrength / Math.max(d, 0.001));
                }
            }

            if (neighborCount > 0) {
                _boidCenter.multiplyScalar(1 / neighborCount);
                _boidAlign.multiplyScalar(1 / neighborCount);

                _boidCenter.sub(_tmpVec).multiplyScalar(BOID_COHESION_WEIGHT);
                _boidAlign.sub(_tmpVel).multiplyScalar(BOID_ALIGN_WEIGHT);
                _boidSeparate.multiplyScalar(BOID_SEPARATION_WEIGHT);

                _tmpVel.addScaledVector(_boidCenter, stepDt);
                _tmpVel.addScaledVector(_boidAlign, stepDt);
                _tmpVel.addScaledVector(_boidSeparate, stepDt);
            }

            _swirlVec.set(_tmpVec.x - clusterCenter.x, 0, _tmpVec.z - clusterCenter.z);
            const swirlLen2 = _swirlVec.lengthSq();
            if (swirlLen2 > 0.0001) {
                const swirlLen = Math.sqrt(swirlLen2);
                _swirlVec.set(-_swirlVec.z / swirlLen, 0, _swirlVec.x / swirlLen);
                _tmpVel.addScaledVector(_swirlVec, swirlStrength * stepDt);
            }

            _tmpOffset.subVectors(_tmpVec, camera.position);
            const dist = _tmpOffset.length();
            if (dist < PARTICLE_REPEL_RADIUS && dist > 0.0001) {
                _tmpOffset.normalize();
                const strength = (PARTICLE_REPEL_RADIUS - dist) / PARTICLE_REPEL_RADIUS;
                _tmpVel.addScaledVector(_tmpOffset, strength * PARTICLE_REPEL_STRENGTH * stepDt);
            } else {
                _tmpVel.multiplyScalar(1 - Math.min(1, stepDt * 0.05));
                _tmpVel.x += (Math.random() - 0.5) * 8.0 * stepDt;
                _tmpVel.y += (Math.random() - 0.5) * 3.0 * stepDt;
                _tmpVel.z += (Math.random() - 0.5) * 8.0 * stepDt;
            }

            _tmpVel.addScaledVector(_globalWind, stepDt * 0.65);

            const speed = _tmpVel.length();
            if (speed > BOID_MAX_SPEED) {
                _tmpVel.multiplyScalar(BOID_MAX_SPEED / speed);
            }

            _tmpVec.addScaledVector(_tmpVel, stepDt);
            obstacleAvoidance(_tmpVec, _tmpVel, stepDt);
            _tmpVel.y *= 0.98;

            _tmpOffset.subVectors(_tmpVec, camera.position);
            const distToPlayer = _tmpOffset.length();
            const behindCam = _tmpOffset.normalize().dot(_camDir) < -0.2;
            if (distToPlayer > PARTICLE_RADIUS || (behindCam && distToPlayer > PARTICLE_RADIUS * 0.8)) {
                const newPos = findSpawnNear(clusterCenter);
                clampParticleHeight(newPos);
                _tmpVec.copy(newPos);
                _tmpVel.set((Math.random() - 0.5) * 4.0, (Math.random() - 0.5) * 4.0, (Math.random() - 0.5) * 4.0);
            }
            clampParticleHeight(_tmpVec);

            positions[base] = _tmpVec.x;
            positions[base + 1] = _tmpVec.y;
            positions[base + 2] = _tmpVec.z;
            velocities[base] = _tmpVel.x;
            velocities[base + 1] = _tmpVel.y;
            velocities[base + 2] = _tmpVel.z;
            needsUpdate = true;
        }
        if (needsUpdate) particleGeometry.attributes.position.needsUpdate = true;
    }

    initAirParticles();

    return {
        updateAirParticles
    };
}
