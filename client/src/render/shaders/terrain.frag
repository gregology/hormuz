#version 300 es
precision mediump float;

in vec2 vUV;
in vec4 vColor;

uniform sampler2D uTexture;
uniform float uGradientScale;
uniform float uMaxElevation;

out vec4 finalColor;

// Hash noise for terrain micro-variation
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

// Decode elevation from RG channels (16-bit encoding)
float decodeElevation(vec4 texel) {
    return texel.r * 255.0 + texel.g * 255.0 * 256.0;
}

void main() {
    // Sample center elevation
    float elev = decodeElevation(texture(uTexture, vUV));

    // Ocean: fully transparent
    if (elev < 0.5) {
        finalColor = vec4(0.0);
        return;
    }

    // Normalize elevation (0-1 range)
    float elevNorm = elev / uMaxElevation;

    // --- Biome coloring by elevation ---
    // Coastal sand (low elevation)
    vec3 sandColor = vec3(0.761, 0.639, 0.400);   // warm tan ~#c2a366
    // Scrubland / dry grass (mid-low)
    vec3 scrubColor = vec3(0.620, 0.565, 0.380);   // olive-tan
    // Sparse vegetation / rocky ground (mid)
    vec3 rockColor = vec3(0.545, 0.490, 0.400);    // grey-brown
    // Mountain rock (high)
    vec3 mountainColor = vec3(0.478, 0.435, 0.380); // darker grey-brown
    // Peak rock (very high)
    vec3 peakColor = vec3(0.420, 0.400, 0.380);     // cool grey

    // Smooth blending between zones
    vec3 biomeColor = sandColor;
    biomeColor = mix(biomeColor, scrubColor, smoothstep(0.05, 0.20, elevNorm));
    biomeColor = mix(biomeColor, rockColor, smoothstep(0.25, 0.45, elevNorm));
    biomeColor = mix(biomeColor, mountainColor, smoothstep(0.50, 0.70, elevNorm));
    biomeColor = mix(biomeColor, peakColor, smoothstep(0.75, 0.90, elevNorm));

    // --- Procedural noise for natural variation ---
    // Scale UV to heightmap grid coords for consistent noise frequency
    vec2 gridPos = vUV * vec2(226.0, 162.0);

    // Multi-frequency noise for organic texture
    float n1 = vnoise(gridPos * 2.0) * 0.6;
    float n2 = vnoise(gridPos * 5.0 + 47.3) * 0.3;
    float n3 = vnoise(gridPos * 12.0 + 91.7) * 0.1;
    float nTotal = n1 + n2 + n3;

    // Shift biome color by noise (subtle hue/brightness variation)
    biomeColor *= 0.88 + nTotal * 0.24;
    // Slight green tint in mid-elevations (sparse vegetation)
    float vegMask = smoothstep(0.08, 0.25, elevNorm) * (1.0 - smoothstep(0.40, 0.60, elevNorm));
    biomeColor += vec3(-0.02, 0.03, -0.02) * vegMask * nTotal;

    // --- Hillshade (directional lighting) ---
    // Sample neighbors for gradient
    vec2 texSize = vec2(textureSize(uTexture, 0));
    vec2 texelSize = 1.0 / texSize;

    float hL = decodeElevation(texture(uTexture, vUV - vec2(texelSize.x, 0.0)));
    float hR = decodeElevation(texture(uTexture, vUV + vec2(texelSize.x, 0.0)));
    float hU = decodeElevation(texture(uTexture, vUV - vec2(0.0, texelSize.y)));
    float hD = decodeElevation(texture(uTexture, vUV + vec2(0.0, texelSize.y)));

    // Gradient (rise over run in game units, cell size cancels out in normalized space)
    float dzdx = (hR - hL) * 0.5 * uGradientScale;
    float dzdy = (hD - hU) * 0.5 * uGradientScale;

    // Surface normal
    vec3 normal = normalize(vec3(-dzdx, -dzdy, 1.0));

    // NW light direction at ~35 degrees altitude (same as pre-computed hillshade)
    vec3 lightDir = normalize(vec3(-0.5773, -0.5773, 0.5773));

    float shade = max(0.0, dot(normal, lightDir));

    // Flat ground baseline (~0.577)
    float flatShade = 0.5773;

    // Remap shade relative to flat: shadows darken, highlights brighten
    float shadeFactor;
    if (shade < flatShade) {
        // Shadow: darken by up to 35%
        shadeFactor = 0.65 + 0.35 * (shade / flatShade);
    } else {
        // Highlight: brighten by up to 20%
        shadeFactor = 1.0 + 0.20 * ((shade - flatShade) / (1.0 - flatShade));
    }

    vec3 color = biomeColor * shadeFactor;

    // --- Coastal edge: slight darkening at sea-level boundary ---
    float coastMask = smoothstep(0.0, 0.04, elevNorm);
    color *= 0.85 + 0.15 * coastMask;

    finalColor = vec4(color, 1.0) * vColor;
}
