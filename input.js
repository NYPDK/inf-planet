import { EventDispatcher, Euler } from 'three';

export const keys = { w: false, a: false, s: false, d: false, space: false, shift: false, crouch: false, map: false, fly: false };

const onKey = (code, state, event) => {
    if(code === 'KeyW') keys.w = state;
    if(code === 'KeyA') keys.a = state;
    if(code === 'KeyS') keys.s = state;
    if(code === 'KeyD') keys.d = state;
    if(code === 'Space') keys.space = state;
    if(code === 'ShiftLeft' || code === 'ShiftRight') keys.shift = state;
    if(code === 'KeyC') keys.crouch = state;
    if(code === 'KeyM') keys.map = state;
    if(code === 'KeyN' && state && !event.repeat) keys.fly = !keys.fly;
};

export function initInput() {
    document.addEventListener('keydown', e => {
        onKey(e.code, true, e);
    });
    document.addEventListener('keyup', e => onKey(e.code, false, e));

    window.addEventListener('beforeunload', (e) => {
        e.preventDefault();
        e.returnValue = '';
    });
}

export class SmoothPointerLockControls extends EventDispatcher {
    constructor(camera, domElement) {
        super();
        this.camera = camera;
        this.domElement = domElement;
        this.isLocked = false;
        this.pointerSpeed = 1.0;
        
        this.minPolarAngle = 0;
        this.maxPolarAngle = Math.PI;

        this._euler = new Euler(0, 0, 0, 'YXZ');
        this._PI_2 = Math.PI / 2;
        
        this.mouseAccum = { x: 0, y: 0 };
        
        this._onMouseMove = this.onMouseMove.bind(this);
        this._onPointerLockChange = this.onPointerLockChange.bind(this);
        this._onPointerLockError = this.onPointerLockError.bind(this);
        
        this.connect();
    }

    connect() {
        this.domElement.ownerDocument.addEventListener('mousemove', this._onMouseMove);
        this.domElement.ownerDocument.addEventListener('pointerlockchange', this._onPointerLockChange);
        this.domElement.ownerDocument.addEventListener('pointerlockerror', this._onPointerLockError);
    }

    disconnect() {
        this.domElement.ownerDocument.removeEventListener('mousemove', this._onMouseMove);
        this.domElement.ownerDocument.removeEventListener('pointerlockchange', this._onPointerLockChange);
        this.domElement.ownerDocument.removeEventListener('pointerlockerror', this._onPointerLockError);
    }
    
    dispose() {
        this.disconnect();
    }

    onMouseMove(event) {
        if (this.isLocked === false) return;
        this.mouseAccum.x += event.movementX || 0;
        this.mouseAccum.y += event.movementY || 0;
    }
    
    update(dt) {
        if (!this.isLocked) return;
        
        const mouseX = this.mouseAccum.x;
        const mouseY = this.mouseAccum.y;
        
        // Reset accumulator
        this.mouseAccum.x = 0;
        this.mouseAccum.y = 0;

        if (mouseX === 0 && mouseY === 0) return;

        // Base sensitivity 0.002 to match standard Three.js controls
        const sensitivity = 0.002 * this.pointerSpeed;

        this._euler.setFromQuaternion(this.camera.quaternion);
        this._euler.y -= mouseX * sensitivity;
        this._euler.x -= mouseY * sensitivity;

        this._euler.x = Math.max(this._PI_2 - this.maxPolarAngle, Math.min(this._PI_2 - this.minPolarAngle, this._euler.x));

        this.camera.quaternion.setFromEuler(this._euler);
        this.dispatchEvent({ type: 'change' });
    }

    lock() {
        this.domElement.requestPointerLock();
    }

    unlock() {
        this.domElement.ownerDocument.exitPointerLock();
    }

    onPointerLockChange() {
        if (this.domElement.ownerDocument.pointerLockElement === this.domElement) {
            this.dispatchEvent({ type: 'lock' });
            this.isLocked = true;
        } else {
            this.dispatchEvent({ type: 'unlock' });
            this.isLocked = false;
        }
    }

    onPointerLockError() {
        console.error('SmoothPointerLockControls: Unable to use Pointer Lock API');
    }
}