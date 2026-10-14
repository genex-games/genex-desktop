/*
 * GPU rendering into the frames ring through Metal-only ANGLE, the way the headless raylib
 * platform will: each slot's IOSurface becomes an EGL pbuffer (EGL_ANGLE_iosurface_client_buffer,
 * EGL_TEXTURE_2D) bound to a texture that is the color attachment of that slot's framebuffer.
 * GL row 0 is IOSurface memory row 0, so the image is stored bottom-up.
 */
#ifndef GXF_ANGLE_RENDER_H
#define GXF_ANGLE_RENDER_H

#include <stdint.h>

#include "gxf_sender.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct gxf_angle gxf_angle;

/** How a frame is finished before it is sent. */
typedef enum gxf_angle_sync {
  GXF_ANGLE_SYNC_FINISH = 0, /* glFinish: the Metal command buffer completed (waitUntilCompleted) */
  GXF_ANGLE_SYNC_FLUSH = 1,  /* glFlush: committed, not waited for (a race with the reader) */
} gxf_angle_sync;

/** Creates a Metal EGL display and an ES 3.0 context; NULL with *egl_error set on failure. */
gxf_angle* gxf_angle_create(int* egl_error);
/** Wraps every slot of `ring` in a pbuffer, texture and framebuffer; 0 on success. */
int gxf_angle_bind_ring(gxf_angle* angle, const gxf_ring* ring);
/** Draws the test pattern of frame `seq` into `slot` and synchronizes; 0 on success. */
int gxf_angle_draw(gxf_angle* angle, uint32_t slot, uint64_t seq, gxf_angle_sync sync);
/** GL_RENDERER of the context. */
const char* gxf_angle_renderer(const gxf_angle* angle);
void gxf_angle_destroy(gxf_angle* angle);

#ifdef __cplusplus
}
#endif

#endif
