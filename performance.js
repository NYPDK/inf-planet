import Stats from 'three/addons/libs/stats.module.js';
import { GRAPHICS_SETTINGS } from './config.js';

const MIN_PIXEL_RATIO = 0.25;
const MAX_PIXEL_RATIO = 1;
const FPS_CHECK_INTERVAL = 500; // ms
const DYNRES_MIN_INTERVAL = 1500; // ms
const UPSCALE_STEP = 0.05;
const MAP_RESUME_DELAY_MS = 1000;
const MIN_FPS_CAP = 30;
const RFPS_SMOOTH = 0.25;
const DEFAULT_TARGET_FPS = 240;

export function createRefreshDetector() {
    let bestDetectedHz = 0;
    let detectInProgress = false;
    let detectTimer = null;

    function getEffectiveTargetFps() {
        return GRAPHICS_SETTINGS.TARGET_FPS || DEFAULT_TARGET_FPS;
    }

    function detectDisplayRefreshRate(samples = 180, warmup = 30) {
        if (detectInProgress) return Promise.resolve(bestDetectedHz || getEffectiveTargetFps());
        if (document.visibilityState !== 'visible' || !document.hasFocus()) return Promise.resolve(getEffectiveTargetFps());
        detectInProgress = true;
        return new Promise((resolve) => {
            let lastTime;
            let minDelta = Infinity;
            let collected = 0;
            function sample(t) {
                if (lastTime !== undefined) {
                    const delta = t - lastTime;
                    if (collected >= warmup) {
                        minDelta = Math.min(minDelta, delta);
                        collected++;
                        if (collected >= warmup + samples) {
                            detectInProgress = false;
                            const hz = Math.max(MIN_FPS_CAP, Math.min(360, Math.round(1000 / Math.max(minDelta, 0.0001))));
                            bestDetectedHz = Math.max(bestDetectedHz, hz);
                            GRAPHICS_SETTINGS.TARGET_FPS = bestDetectedHz;
                            const label = document.getElementById('val-targetfps');
                            if (label) label.innerText = `${bestDetectedHz} (auto)`;
                            resolve(bestDetectedHz);
                            return;
                        }
                    } else {
                        collected++;
                    }
                }
                lastTime = t;
                requestAnimationFrame(sample);
            }
            requestAnimationFrame(sample);
        });
    }

    function scheduleRefreshDetect(delay = 0) {
        if (detectTimer) clearTimeout(detectTimer);
        detectTimer = setTimeout(() => {
            detectTimer = null;
            detectDisplayRefreshRate();
        }, delay);
    }

    return {
        detectDisplayRefreshRate,
        scheduleRefreshDetect,
        getEffectiveTargetFps
    };
}

export function createPerformanceHud(renderer, getEffectiveTargetFps) {
    const stats = new Stats();
    stats.showPanel(0);
    stats.dom.style.top = '';
    stats.dom.style.left = '10px';
    stats.dom.style.bottom = '10px';
    document.body.appendChild(stats.dom);

    const tickStats = new Stats();
    const tickPanel = new Stats.Panel('TPS', '#0f0', '#021');
    tickStats.addPanel(tickPanel);
    tickStats.showPanel(tickStats.dom.children.length - 1);
    tickStats.dom.style.top = '';
    tickStats.dom.style.bottom = '10px';
    tickStats.dom.style.left = '100px';
    document.body.appendChild(tickStats.dom);

    const fpsPanel = new Stats.Panel('RFPS', '#0ff', '#002');
    stats.addPanel(fpsPanel);
    fpsPanel.dom = stats.dom;

    let currentPixelRatio = 1;
    let fpsCheckTimer = 0;
    let framesSinceLastCheck = 0;
    let lastDynResChange = 0;
    let smoothedRfps = 0;
    let mapCooldownMs = 0;
    let lastMapVisible = false;
    let lastRenderTime = performance.now();
    let tickCounter = 0;
    let tickTimer = 0;

    function beginFrame() {
        stats.begin();
    }

    function endFrame() {
        stats.end();
    }

    function updateTickRate(stepsThisFrame, dt) {
        tickCounter += stepsThisFrame;
        tickTimer += dt;
        if (tickTimer >= 1.0) {
            const tickRate = tickCounter / tickTimer;
            tickPanel.update(tickRate, 180);
            tickCounter = 0;
            tickTimer = 0;
        }
    }

    function handleRenderFrame(now, mapVisible) {
        const nowFrame = now === undefined ? performance.now() : now;
        const frameDtMs = nowFrame - lastRenderTime;
        lastRenderTime = nowFrame;

        const targetFps = Math.max(MIN_FPS_CAP, getEffectiveTargetFps());

        const mapJustClosed = lastMapVisible && !mapVisible;
        if (mapJustClosed) {
            currentPixelRatio = MAX_PIXEL_RATIO;
            renderer.setPixelRatio(currentPixelRatio);
            lastDynResChange = nowFrame;
            mapCooldownMs = MAP_RESUME_DELAY_MS;
            fpsCheckTimer = 0;
            framesSinceLastCheck = 0;
        }

        if (mapVisible) {
            mapCooldownMs = MAP_RESUME_DELAY_MS;
            fpsCheckTimer = 0;
            framesSinceLastCheck = 0;
        } else if (mapCooldownMs > 0) {
            mapCooldownMs = Math.max(0, mapCooldownMs - frameDtMs);
        }

        const rawRfps = 1000 / Math.max(frameDtMs, 0.0001);
        if (smoothedRfps === 0) smoothedRfps = rawRfps;
        smoothedRfps += (rawRfps - smoothedRfps) * RFPS_SMOOTH;
        const rfpsGaugeMax = Math.max(targetFps * 2, rawRfps * 1.2);
        fpsPanel.update(smoothedRfps, rfpsGaugeMax);

        if (!mapVisible && mapCooldownMs === 0) {
            fpsCheckTimer += frameDtMs;
            framesSinceLastCheck++;

            if (fpsCheckTimer > FPS_CHECK_INTERVAL) {
                const avgFps = (framesSinceLastCheck / fpsCheckTimer) * 1000;
                const canAdjust = (nowFrame - lastDynResChange) > DYNRES_MIN_INTERVAL;
                if (canAdjust && avgFps < targetFps - 10 && currentPixelRatio > MIN_PIXEL_RATIO) {
                    const nextRatio = Math.max(MIN_PIXEL_RATIO, currentPixelRatio - 0.05);
                    if (Math.abs(nextRatio - currentPixelRatio) > 0.001) {
                        currentPixelRatio = nextRatio;
                        renderer.setPixelRatio(currentPixelRatio);
                        lastDynResChange = nowFrame;
                    }
                } else if (canAdjust && avgFps > targetFps + 20 && currentPixelRatio < MAX_PIXEL_RATIO) {
                    const nextRatio = Math.min(MAX_PIXEL_RATIO, currentPixelRatio + UPSCALE_STEP);
                    if (Math.abs(nextRatio - currentPixelRatio) > 0.001) {
                        currentPixelRatio = nextRatio;
                        renderer.setPixelRatio(currentPixelRatio);
                        lastDynResChange = nowFrame;
                    }
                }

                fpsCheckTimer = 0;
                framesSinceLastCheck = 0;
            }
        } else {
            fpsCheckTimer = 0;
            framesSinceLastCheck = 0;
        }

        lastMapVisible = mapVisible;

        return { frameDtMs, targetFps };
    }

    return {
        beginFrame,
        endFrame,
        handleRenderFrame,
        updateTickRate,
        stats,
        tickPanel,
        tickStats,
        fpsPanel
    };
}
