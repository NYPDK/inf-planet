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

    // Prevent accidental tab closing
    window.addEventListener('beforeunload', (e) => {
        e.preventDefault();
        e.returnValue = '';
    });
}
