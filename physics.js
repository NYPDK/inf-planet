import * as THREE from 'three';
import { keys } from './input.js';
import { getTerrainHeight, activeChunks } from './world.js';
import { DEFAULTS, PHYSICS_CONSTANTS, CHUNK_SIZE } from './config.js';
import { waterMesh } from './resources.js';

export const physicsParams = {
    MOVE_SPEED: DEFAULTS.MOVE_SPEED,
    MAX_AIR_SPEED: DEFAULTS.MAX_AIR_SPEED,
    JUMP_FORCE: DEFAULTS.JUMP_FORCE,
    GRAVITY: DEFAULTS.GRAVITY
};

export const velocity = new THREE.Vector3();
export const playerPos = new THREE.Vector3(0, 10, 0);
export let onGround = false;
export let isUnderwater = false;
let currentHeight = PHYSICS_CONSTANTS.PLAYER_HEIGHT;
let flyVelocity = new THREE.Vector3();

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wishDir = new THREE.Vector3();
const _xAxis = new THREE.Vector3(1, 0, 0);
const _zAxis = new THREE.Vector3(0, 0, -1);

export function updatePhysics(dt, camera, controls) {
    if (!controls.isLocked) return;

    const wasUnderwater = isUnderwater;
    isUnderwater = playerPos.y < -5.0;

    if (keys.fly) {
        _forward.copy(_zAxis).applyQuaternion(camera.quaternion);
        _right.copy(_xAxis).applyQuaternion(camera.quaternion);

        _wishDir.set(0, 0, 0);
        if (keys.w) _wishDir.add(_forward);
        if (keys.s) _wishDir.sub(_forward);
        if (keys.d) _wishDir.add(_right);
        if (keys.a) _wishDir.sub(_right);
        if (keys.space) _wishDir.y += 1;
        if (keys.crouch) _wishDir.y -= 1;

        if (_wishDir.lengthSq() > 0) _wishDir.normalize();

        const flySpeed = keys.shift ? physicsParams.MOVE_SPEED * 2.0 : physicsParams.MOVE_SPEED;
        flyVelocity.copy(_wishDir).multiplyScalar(flySpeed);

        playerPos.addScaledVector(flyVelocity, dt);
        onGround = false;
        velocity.set(0, 0, 0);
        return;
    }

    const targetHeight = keys.crouch ? PHYSICS_CONSTANTS.CROUCH_HEIGHT : PHYSICS_CONSTANTS.PLAYER_HEIGHT;
    currentHeight += (targetHeight - currentHeight) * 10.0 * dt;

    _forward.copy(_zAxis).applyQuaternion(camera.quaternion);
    _right.copy(_xAxis).applyQuaternion(camera.quaternion);
    _forward.y = 0; _forward.normalize();
    _right.y = 0; _right.normalize();

    _wishDir.set(0, 0, 0);
    if (keys.w) _wishDir.add(_forward);
    if (keys.s) _wishDir.sub(_forward);
    if (keys.d) _wishDir.add(_right);
    if (keys.a) _wishDir.sub(_right);
    _wishDir.normalize();

    let targetSpeed = keys.shift ? physicsParams.MOVE_SPEED * 2.0 : physicsParams.MOVE_SPEED;
    if (keys.crouch) targetSpeed = physicsParams.MOVE_SPEED * 0.5;

    const currentMoveSpeed = isUnderwater ? targetSpeed * 0.4 : targetSpeed;
    const currentGravity = isUnderwater ? physicsParams.GRAVITY * 0.2 : physicsParams.GRAVITY;
    const currentFriction = isUnderwater ? PHYSICS_CONSTANTS.FRICTION * 2.5 : PHYSICS_CONSTANTS.FRICTION;

    if (onGround) {
        applyFriction(dt, currentFriction);
        accelerate(_wishDir, currentMoveSpeed, PHYSICS_CONSTANTS.GROUND_ACCEL, dt);
        if (keys.space) {
            velocity.y = physicsParams.JUMP_FORCE;
            onGround = false;
        }
    } else {
        const airAccel = isUnderwater ? PHYSICS_CONSTANTS.GROUND_ACCEL : PHYSICS_CONSTANTS.AIR_ACCEL;
        accelerate(_wishDir, physicsParams.MAX_AIR_SPEED, airAccel, dt);
        velocity.y -= currentGravity * dt;
        
        if (isUnderwater) {
            velocity.y *= (1 - dt * 2.0);
        }
    }

    playerPos.addScaledVector(velocity, dt);

    resolveTreeCollisions(dt);

    const terrainH = getTerrainHeight(playerPos.x, playerPos.z);
    const treeH = getTreeHeight(playerPos.x, playerPos.z, playerPos.y);
    const groundH = Math.max(terrainH, treeH);

    const distToGround = playerPos.y - (groundH + currentHeight);

    if (distToGround < 0) {
        playerPos.y = groundH + currentHeight;
        velocity.y = 0;
        onGround = true;
    } else if (onGround && distToGround < PHYSICS_CONSTANTS.STEP_HEIGHT && velocity.y <= 0 && !keys.space) {
        playerPos.y = groundH + currentHeight;
        velocity.y = 0;
        onGround = true; 
    } else {
        onGround = false;
    }

    if (playerPos.y < -50) {
        playerPos.set(0, 20, 0);
        velocity.set(0,0,0);
    }
}

function getNearbyTrees() {
    const trees = [];
    const cx = Math.floor(playerPos.x / CHUNK_SIZE);
    const cz = Math.floor(playerPos.z / CHUNK_SIZE);

    for (let x = -1; x <= 1; x++) {
        for (let z = -1; z <= 1; z++) {
            const key = `${cx + x},${cz + z}`;
            const chunk = activeChunks.get(key);
            if (chunk && chunk.userData && chunk.userData.trees) {
                for (const t of chunk.userData.trees) {
                    trees.push(t);
                }
            }
        }
    }
    return trees;
}

function resolveTreeCollisions(dt) {
    const PLAYER_RADIUS = 0.4;
    const trees = getNearbyTrees();
    
    for (const t of trees) {
        const treeBaseY = getTerrainHeight(t.x, t.z);
        const dx = playerPos.x - t.x;
        const dz = playerPos.z - t.z;
        const dist = Math.sqrt(dx*dx + dz*dz);

        const widthScale = t.s || 1.0;
        const heightScale = t.hs || 1.0;

        const trunkRadius = 0.8 * widthScale;
        const trunkHeight = 3.0 * heightScale;
        const trunkH_Max = treeBaseY + trunkHeight;

        if (playerPos.y >= treeBaseY && playerPos.y <= trunkH_Max + 1.0) { 
             if (dist < trunkRadius + PLAYER_RADIUS) {
                 const pushDir = new THREE.Vector3(dx, 0, dz).normalize();
                 const overlap = (trunkRadius + PLAYER_RADIUS) - dist;
                 playerPos.addScaledVector(pushDir, overlap);
             }
        }

        const leafStart = treeBaseY + (2.0 * heightScale);
        const leafEnd = treeBaseY + (9.0 * heightScale);
        const leafMaxRadius = 3.0 * widthScale;
        const leafHeight = 7.0 * heightScale;
        
        if (playerPos.y > leafStart && playerPos.y < leafEnd) {
            const relY = playerPos.y - leafStart;
            const r = leafMaxRadius * (1.0 - relY / leafHeight);
            
            if (dist < r + PLAYER_RADIUS) {
                const horizontalOverlap = (r + PLAYER_RADIUS) - dist;
                
                if (relY < horizontalOverlap) {
                    playerPos.y = leafStart - 0.05;
                    if (velocity.y > 0) velocity.y = 0;
                } else {
                    const pushDir = new THREE.Vector3(dx, 0, dz).normalize();
                    playerPos.addScaledVector(pushDir, horizontalOverlap);
                }
            }
        }
    }
}

function getTreeHeight(x, z, currentY) {
    let maxY = -Infinity;
    const trees = getNearbyTrees(); 
    
    for (const t of trees) {
        const treeBaseY = getTerrainHeight(t.x, t.z);
        const dx = x - t.x;
        const dz = z - t.z;
        const dist = Math.sqrt(dx*dx + dz*dz);
        
        const widthScale = t.s || 1.0;
        const heightScale = t.hs || 1.0;

        const trunkRadius = 0.8 * widthScale;
        const trunkTopY = treeBaseY + (3.0 * heightScale);

        if (dist < trunkRadius) {
            if (currentY >= trunkTopY - 0.5) { 
                maxY = Math.max(maxY, trunkTopY);
            }
        }

        const leafMaxRadius = 3.0 * widthScale;
        const leafHeight = 7.0 * heightScale;
        const leafStart = treeBaseY + (2.0 * heightScale);

        if (dist < leafMaxRadius) {
            const heightFromBase = leafHeight * (1.0 - dist / leafMaxRadius);
            const surfaceY = leafStart + heightFromBase;
            
            if (currentY >= surfaceY - 0.5) { 
                maxY = Math.max(maxY, surfaceY);
            }
        }
    }
    return maxY;
}

function accelerate(wishDir, wishSpeed, accel, dt) {
    const currentSpeed = velocity.dot(wishDir);
    const addSpeed = wishSpeed - currentSpeed;
    if (addSpeed <= 0) return;
    let accelSpeed = accel * wishSpeed * dt;
    if (accelSpeed > addSpeed) accelSpeed = addSpeed;
    velocity.x += accelSpeed * wishDir.x;
    velocity.z += accelSpeed * wishDir.z;
}

function applyFriction(dt, frictionVal) {
    const speed = velocity.length();
    if (speed < 0.1) {
        velocity.set(0,0,0);
        return;
    }
    const drop = speed * frictionVal * dt;
    let newSpeed = Math.max(0, speed - drop);
    velocity.multiplyScalar(newSpeed / speed);
}
