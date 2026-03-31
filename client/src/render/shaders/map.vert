#include <common>
#include <logdepthbuf_pars_vertex>

out vec2 vUV;

void main() {
    vUV = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
}
