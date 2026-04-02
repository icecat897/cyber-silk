import { createDoubleFBO, createFBO, disposeDoubleFBO, disposeFBO, type DoubleFBO, type SingleFBO, type TextureSpec } from '../fluid/framebuffers'

export interface BloomResources {
  prefilter: SingleFBO
  blur: DoubleFBO
}

export function createBloomResources(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  spec: TextureSpec,
): BloomResources {
  return {
    prefilter: createFBO(gl, width, height, spec),
    blur: createDoubleFBO(gl, width, height, spec),
  }
}

export function disposeBloomResources(gl: WebGL2RenderingContext, resources: BloomResources) {
  disposeFBO(gl, resources.prefilter)
  disposeDoubleFBO(gl, resources.blur)
}

export const BLOOM_PREFILTER_FRAGMENT = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTexture;
uniform float uThreshold;

void main() {
  vec3 color = max(texture(uTexture, vUv).rgb, 0.0);
  float brightness = max(max(color.r, color.g), color.b);
  float soft = smoothstep(uThreshold * 0.45, uThreshold, brightness);
  fragColor = vec4(color * soft, 1.0);
}
`

export const BLOOM_BLUR_FRAGMENT = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTexture;
uniform vec2 uDirection;

void main() {
  vec3 color = texture(uTexture, vUv).rgb * 0.227027;
  color += texture(uTexture, vUv + uDirection * 1.384615).rgb * 0.316216;
  color += texture(uTexture, vUv - uDirection * 1.384615).rgb * 0.316216;
  color += texture(uTexture, vUv + uDirection * 3.230769).rgb * 0.070270;
  color += texture(uTexture, vUv - uDirection * 3.230769).rgb * 0.070270;
  fragColor = vec4(color, 1.0);
}
`
