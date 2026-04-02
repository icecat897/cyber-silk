export interface TextureSpec {
  internalFormat: number
  format: number
  type: number
  filtering: number
}

export interface SingleFBO {
  texture: WebGLTexture
  framebuffer: WebGLFramebuffer
  width: number
  height: number
}

export interface DoubleFBO {
  read: SingleFBO
  write: SingleFBO
  swap: () => void
}

function assertResource<T>(resource: T | null, message: string): T {
  if (!resource) {
    throw new Error(message)
  }

  return resource
}

export function createFBO(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  spec: TextureSpec,
): SingleFBO {
  const texture = assertResource(gl.createTexture(), 'Unable to create texture')
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, spec.filtering)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, spec.filtering)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    spec.internalFormat,
    width,
    height,
    0,
    spec.format,
    spec.type,
    null,
  )

  const framebuffer = assertResource(gl.createFramebuffer(), 'Unable to create framebuffer')
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)

  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('Framebuffer is incomplete. Float render targets may be unavailable.')
  }

  return {
    texture,
    framebuffer,
    width,
    height,
  }
}

export function createDoubleFBO(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  spec: TextureSpec,
): DoubleFBO {
  const first = createFBO(gl, width, height, spec)
  const second = createFBO(gl, width, height, spec)

  return {
    read: first,
    write: second,
    swap() {
      const read = this.read
      this.read = this.write
      this.write = read
    },
  }
}

export function disposeFBO(gl: WebGL2RenderingContext, target: SingleFBO) {
  gl.deleteFramebuffer(target.framebuffer)
  gl.deleteTexture(target.texture)
}

export function disposeDoubleFBO(gl: WebGL2RenderingContext, target: DoubleFBO) {
  disposeFBO(gl, target.read)
  disposeFBO(gl, target.write)
}
