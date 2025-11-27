import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { generateNoiseTexture } from './utils.js';
import { BUMP_SCALE, CHUNK_SIZE, RENDER_DISTANCE } from './config.js';

export const materials = {};
export const geometries = {};
export let waterMesh;

export function initResources(scene, globalShaderUniforms) {
    const shaderUniforms = globalShaderUniforms || {
        uCurvature: { value: 0.0 },
        uBendCenter: { value: new THREE.Vector3() }
    };

    const textureLoader = new THREE.TextureLoader();
    const grassTexture = textureLoader.load('textures/tall-grass-texture.png');
    grassTexture.colorSpace = THREE.SRGBColorSpace;

    const groundBump = generateNoiseTexture();
    
    // 1. Define Materials
    materials.groundMat = new THREE.MeshStandardMaterial({ 
        vertexColors: true, 
        roughness: 0.6, 
        bumpMap: groundBump,
        bumpScale: BUMP_SCALE 
    });

    materials.trunkMat = new THREE.MeshStandardMaterial({ 
        color: 0x3d2817, 
        roughness: 0.8 
    });

    materials.treeMat = new THREE.MeshStandardMaterial({ 
        color: 0x1a330a, 
        flatShading: true, 
        roughness: 0.5 
    });

    materials.grassMat = new THREE.MeshBasicMaterial({
        map: grassTexture,
        transparent: true,
        alphaTest: 0.5,
        side: THREE.DoubleSide
    });

    // 2. Define Geometries
    geometries.trunkGeo = new THREE.CylinderGeometry(0.4, 0.8, 3, 5);
    geometries.trunkGeo.translate(0, 1.5, 0); 
    
    geometries.leavesGeo = new THREE.ConeGeometry(3, 7, 6);
    geometries.leavesGeo.translate(0, 5.5, 0);

    const grassPlane1 = new THREE.PlaneGeometry(1.2, 1.2);
    const grassPlane2 = new THREE.PlaneGeometry(1.2, 1.2);
    grassPlane2.rotateY(Math.PI / 2);
    geometries.grassGeo = BufferGeometryUtils.mergeGeometries([grassPlane1, grassPlane2]);
    geometries.grassGeo.translate(0, 0.6, 0);

    // 3. Shader Injection Logic
    
    // Common Vertex Shader Injection for Curvature
    const commonUniforms = `
        uniform float uCurvature;
        uniform vec3 uBendCenter;
    `;
    
    const curvatureLogic = `
        // Compute bent world position (supports Instancing & Batching)
        vec4 bentWorldPosition = vec4( transformed, 1.0 );
        #ifdef USE_BATCHING
            bentWorldPosition = batchingMatrix * bentWorldPosition;
        #endif
        #ifdef USE_INSTANCING
            bentWorldPosition = instanceMatrix * bentWorldPosition;
        #endif
        bentWorldPosition = modelMatrix * bentWorldPosition;

        // Calculate distance from bend center
        float dist = distance(bentWorldPosition.xz, uBendCenter.xz);
        
        // Quadratic bend factor
        float bendFactor = dist * dist * uCurvature;
        
        // Apply bend to Y
        bentWorldPosition.y -= bendFactor;

        // Transform to view space, then clip space
        vec4 mvPosition = viewMatrix * bentWorldPosition;
        gl_Position = projectionMatrix * mvPosition;
    `;

    // Applies curvature to Standard/Basic Materials
    function setupMaterial(material) {
        material.onBeforeCompile = (shader) => {
            shader.uniforms.uCurvature = shaderUniforms.uCurvature;
            shader.uniforms.uBendCenter = shaderUniforms.uBendCenter;

            shader.vertexShader = shader.vertexShader.replace(
                '#include <common>',
                `${commonUniforms}\n#include <common>`
            );
            
            shader.vertexShader = shader.vertexShader.replace(
                '#include <project_vertex>',
                `
                ${curvatureLogic}
                #ifdef USE_FOG
                    vFogDepth = length(mvPosition.xyz);
                #endif
                `
            );

            // Fix worldPosition for lighting
            shader.vertexShader = shader.vertexShader.replace(
                '#include <worldpos_vertex>',
                `vec4 worldPosition = bentWorldPosition;`
            );
        };
    }

    // Creates and assigns a custom Depth Material for shadows
    function setupShadowMaterial(material) {
        const depthMat = new THREE.MeshDepthMaterial({
            depthPacking: THREE.RGBADepthPacking,
            map: material.map || null,
            alphaTest: material.alphaTest || 0,
            side: material.side
        });

        // We must manually inject the curvature into the depth material too
        depthMat.onBeforeCompile = (shader) => {
            shader.uniforms.uCurvature = shaderUniforms.uCurvature;
            shader.uniforms.uBendCenter = shaderUniforms.uBendCenter;

            shader.vertexShader = shader.vertexShader.replace(
                '#include <common>',
                `${commonUniforms}\n#include <common>`
            );

            // MeshDepthMaterial uses <project_vertex> but usually no fog/lighting
            shader.vertexShader = shader.vertexShader.replace(
                '#include <project_vertex>',
                curvatureLogic 
            );
        };

        material.customDepthMaterial = depthMat;

        // Optional: Distance Material (for PointLights) - simpler fallback logic
        const distMat = new THREE.MeshDistanceMaterial({
            map: material.map || null,
            alphaTest: material.alphaTest || 0
        });
        distMat.onBeforeCompile = depthMat.onBeforeCompile;
        material.customDistanceMaterial = distMat;
    }

    // 4. Apply Shaders
    setupMaterial(materials.groundMat);
    setupMaterial(materials.trunkMat);
    setupMaterial(materials.treeMat);
    setupMaterial(materials.grassMat);

    setupShadowMaterial(materials.groundMat);
    setupShadowMaterial(materials.trunkMat);
    setupShadowMaterial(materials.treeMat);
    setupShadowMaterial(materials.grassMat);

    // 5. Water Setup (Custom ShaderMaterial)
    const waterGeo = new THREE.PlaneGeometry(
        CHUNK_SIZE * (RENDER_DISTANCE * 2 + 2), 
        CHUNK_SIZE * (RENDER_DISTANCE * 2 + 2), 
        256, 
        256
    );
    waterGeo.rotateX(-Math.PI / 2);

    const waterUniforms = THREE.UniformsUtils.merge([
        THREE.UniformsLib['fog'],
        THREE.UniformsLib['lights'],
        shaderUniforms, 
        {
            uTime: { value: 0 },
            uColor: { value: new THREE.Color(0x3b7d9c) }
        }
    ]);
    waterUniforms.uCurvature = shaderUniforms.uCurvature;
    waterUniforms.uBendCenter = shaderUniforms.uBendCenter;

    const waterVertShader = `
        #include <common>
        #include <fog_pars_vertex>
        #include <lights_pars_begin>
        
        uniform float uTime;
        uniform float uCurvature;
        uniform vec3 uBendCenter;
        varying float vHeight;
        varying vec3 vWorldPosition;
        varying vec3 vNormal;

        void main() {
            vec3 pos = position;
            
            // Base world position
            vec4 baseWorldPos = modelMatrix * vec4(pos, 1.0);

            // Waves
            float wave1 = sin(baseWorldPos.x * 0.8 + uTime * 1.5) * 0.05;
            float wave2 = cos(baseWorldPos.z * 0.1 + uTime * 1.2) * 0.05;
            float displacement = wave1 + wave2;
            pos.y += displacement;

            // Simple wave normal approximation
            vec3 worldNormal = normalize(vec3(
                -0.2 * 0.8 * cos(baseWorldPos.x * 0.8 + uTime * 1.5), 
                1.0, 
                -0.2 * 0.75 * sin(baseWorldPos.z * 0.75 + uTime * 1.2)
            ));
            vNormal = worldNormal;

            vHeight = pos.y;
            
            vec4 worldPos = modelMatrix * vec4(pos, 1.0);

            // Curvature
            float dist = distance(baseWorldPos.xz, uBendCenter.xz);
            float bendFactor = dist * dist * uCurvature;
            worldPos.y -= bendFactor;

            vWorldPosition = worldPos.xyz;

            vec4 mvPosition = viewMatrix * worldPos;
            gl_Position = projectionMatrix * mvPosition;
            
            #include <fog_vertex>
            vFogDepth = length(mvPosition.xyz); 
        }
    `;

    const waterFragShader = `
        #include <common>
        #include <fog_pars_fragment>
        
        uniform vec3 uColor;
        varying float vHeight;
        varying vec3 vNormal;
        varying vec3 vWorldPosition;

        void main() {
            vec3 diffuseColor = uColor + vHeight * 0.05;
            vec3 lightDir = normalize(vec3(50.0, 80.0, 50.0)); 
            float diff = max(dot(vNormal, lightDir), 0.0);
            vec3 viewDir = normalize(cameraPosition - vWorldPosition);
            vec3 halfDir = normalize(lightDir + viewDir);
            float spec = pow(max(dot(vNormal, halfDir), 0.0), 64.0);
            vec3 lighting = diffuseColor * (0.6 + diff * 0.4) + vec3(1.0) * spec * 0.5;
            
            gl_FragColor = vec4(lighting, 0.85); 
            #include <fog_fragment>
        }
    `;

    const waterMat = new THREE.ShaderMaterial({
        uniforms: waterUniforms,
        vertexShader: waterVertShader,
        fragmentShader: waterFragShader,
        transparent: true,
        side: THREE.DoubleSide,
        fog: true,
        lights: true
    });

    waterMesh = new THREE.Mesh(waterGeo, waterMat);
    waterMesh.position.y = -5;
    scene.add(waterMesh);
}