#version 300 es
precision mediump float;

in vec2 vUV;
in vec4 vColor;

uniform float uTime;
uniform float uZoom;

out vec4 finalColor;

// Hash-based value noise (no texture dependency)
float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));

    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Fractional Brownian Motion
float fbm(vec2 p) {
    float v = 0.0;
    v += vnoise(p) * 0.5;
    v += vnoise(p * 2.0 + 17.3) * 0.25;
    v += vnoise(p * 4.0 + 43.7) * 0.125;
    return v / 0.875;
}

void main() {
    // World position in game units (113000 x 81000 map area)
    vec2 worldPos = vUV * vec2(113000.0, 81000.0);

    // Scale factor: ensures roughly the same wave density on screen at any zoom.
    // At zoom 0.04 (full map), waveScale ≈ 1.  At zoom 0.3, waveScale ≈ 7.5.
    float waveScale = max(uZoom / 0.04, 1.0);

    // Coordinate for wave computation — scales with zoom so waves are always visible
    vec2 wp = worldPos * 0.001 * waveScale;

    // --- Wave layers (always visible regardless of zoom) ---
    float w1 = sin(wp.x * 0.8 + wp.y * 0.3 + uTime * 0.4) * 0.5 + 0.5;
    float w2 = sin(wp.x * 0.5 - wp.y * 1.2 + uTime * 0.55) * 0.5 + 0.5;
    float w3 = sin(wp.x * 2.5 + wp.y * 1.8 + uTime * 0.9) * 0.5 + 0.5;
    float w4 = sin(-wp.x * 1.8 + wp.y * 2.2 + uTime * 0.7) * 0.5 + 0.5;

    float wave = w1 * 0.35 + w2 * 0.30 + w3 * 0.20 + w4 * 0.15;

    // --- Extra detail layers for close zoom ---
    float zoomDetail = smoothstep(2.0, 8.0, waveScale);
    float wd1 = sin(wp.x * 6.0 + wp.y * 5.0 + uTime * 1.4) * 0.5 + 0.5;
    float wd2 = sin(-wp.x * 4.0 + wp.y * 7.0 - uTime * 1.1) * 0.5 + 0.5;
    float detailWave = wd1 * 0.5 + wd2 * 0.5;
    wave = mix(wave, wave * 0.7 + detailWave * 0.3, zoomDetail);

    // --- Organic noise (also zoom-scaled) ---
    float n = fbm(wp * 0.8 + uTime * 0.08);

    // --- Color palette ---
    vec3 deepColor = vec3(0.102, 0.227, 0.361);   // ~#1a3a5c
    vec3 midColor = vec3(0.125, 0.275, 0.400);
    vec3 crestColor = vec3(0.145, 0.345, 0.478);  // ~#24587a

    // Mix based on wave height + noise
    float colorMix = wave * 0.65 + n * 0.35;
    vec3 color = mix(deepColor, midColor, smoothstep(0.25, 0.55, colorMix));
    color = mix(color, crestColor, smoothstep(0.55, 0.85, colorMix));

    // --- Brightness from wave normals (fake directional light) ---
    float dWdx = (w1 * 0.35 * cos(wp.x * 0.8 + wp.y * 0.3 + uTime * 0.4) * 0.8
                + w3 * 0.20 * cos(wp.x * 2.5 + wp.y * 1.8 + uTime * 0.9) * 2.5);
    float brightness = 0.92 + dWdx * 0.06;
    color *= brightness;

    // --- Specular highlights (sun glints on crests) ---
    float spec = pow(max(0.0, w1 * w3), 6.0) * 0.08;
    color += vec3(0.7, 0.75, 0.85) * spec;

    // --- Subtle foam on peaks ---
    float foam = smoothstep(0.78, 0.95, wave + n * 0.08);
    color = mix(color, vec3(0.35, 0.42, 0.48), foam * 0.12);

    finalColor = vec4(color, 1.0) * vColor;
}
