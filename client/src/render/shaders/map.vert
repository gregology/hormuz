#version 300 es

in vec2 aPosition;
in vec2 aUV;

// Global uniforms (set by PixiJS per render target)
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;

// Local uniforms (set by MeshPipe per mesh — contains the mesh's world transform)
uniform mat3 uTransformMatrix;
uniform vec4 uColor;

out vec2 vUV;
out vec4 vColor;

void main() {
    vUV = aUV;
    vColor = uColor * uWorldColorAlpha;

    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}
