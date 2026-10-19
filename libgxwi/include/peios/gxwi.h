#ifndef PEIOS_GXWI_H
#define PEIOS_GXWI_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PEIOS_GXWI_ABI_VERSION 1u
#define PEIOS_GXWI_ROLE_WINDOW 1u
#define PEIOS_GXWI_ROLE_PANEL 2u
#define PEIOS_GXWI_ROLE_OVERLAY 3u
#define PEIOS_GXWI_ROLE_BACKGROUND 4u
#define PEIOS_GXWI_ROLE_DIALOG 5u
#define PEIOS_GXWI_EDGE_DEFAULT 0u
#define PEIOS_GXWI_EDGE_TOP 1u
#define PEIOS_GXWI_EDGE_BOTTOM 2u
#define PEIOS_GXWI_EDGE_LEFT 3u
#define PEIOS_GXWI_EDGE_RIGHT 4u
#define PEIOS_GXWI_EVENT_OTHER 0u
#define PEIOS_GXWI_EVENT_CLOSE 1u
#define PEIOS_GXWI_EVENT_SURFACES 2u
#define PEIOS_GXWI_LISTED_HAS_OWN 1u
#define PEIOS_GXWI_LISTED_HAS_APPLICATION 2u

typedef struct peios_gxwi_display peios_gxwi_display;
typedef struct peios_gxwi_event peios_gxwi_event;

struct peios_gxwi_bytes {
    const uint8_t *data;
    size_t len;
};

struct peios_gxwi_live_options {
    uint64_t surface;
    struct peios_gxwi_bytes title;
    uint32_t role;
    uint32_t edge;
    struct peios_gxwi_bytes socket;
    const struct peios_gxwi_bytes *styles;
    size_t style_count;
};

struct peios_gxwi_listed {
    uint64_t id;
    struct peios_gxwi_bytes title;
    uint32_t role;
    uint32_t flags;
    struct peios_gxwi_bytes icon;
    uint64_t app;
    uint32_t workspace;
    uint32_t reserved;
    uint64_t own;
    struct peios_gxwi_bytes application_id;
    struct peios_gxwi_bytes application_title;
};

/*
 * All functions except version/destroy return 0 on success and -1 with errno
 * on failure, unless their own comment says otherwise. Output parameters are
 * untouched on failure. EINVAL means an invalid argument (including invalid
 * UTF-8, an unknown role/edge, or the wrong event kind); ERANGE means an event
 * index is out of range. System errors are preserved; other failures use EIO.
 *
 * Pointers must refer to suitably aligned, live objects of the declared type.
 * Byte spans and arrays may use NULL only with a zero length. Text is UTF-8,
 * with explicit byte lengths; embedded NUL is supported and no terminator is
 * required. Input memory is borrowed only until a function returns. Output
 * pointers must be writable and must not alias input objects. Invalid non-NULL
 * pointers, double destruction and use after destruction are caller errors.
 *
 * Display operations may run concurrently, including receive and shutdown.
 * Concurrent receive calls each consume a separate packet; their completion
 * order is unspecified. Destruction must not overlap any call using that handle.
 * Events are immutable and may be read concurrently. Destroying a display does
 * not invalidate an event. Event string views expire when their event is freed.
 * NULL destruction is a no-op. No callbacks are invoked.
 */
uint32_t peios_gxwi_abi_version(void);

/* Connect to GXWI_DISPLAY with Identification set before connect. Missing
 * GXWI_DISPLAY returns ENOENT. This does not grant shell authority. */
int peios_gxwi_connect(peios_gxwi_display **out);
void peios_gxwi_display_destroy(peios_gxwi_display *display);

/* Returns a new close-on-exec stream fd owned by the caller in out_fd. The
 * desktop receives its peer; the caller serves HTTP/2 on the returned fd. */
int peios_gxwi_serve(const peios_gxwi_display *display, int *out_fd);
int peios_gxwi_create_live(const peios_gxwi_display *display,
                         const struct peios_gxwi_live_options *options);
int peios_gxwi_create_raw(const peios_gxwi_display *display, uint64_t surface,
                        struct peios_gxwi_bytes title, struct peios_gxwi_bytes path);
int peios_gxwi_title(const peios_gxwi_display *display, uint64_t surface,
                    struct peios_gxwi_bytes title);
int peios_gxwi_destroy(const peios_gxwi_display *display, uint64_t surface);

/* These send requests only. The desktop decides whether this connection is a
 * shell and whether to act; successful sending is not authorization or an ack. */
int peios_gxwi_start(const peios_gxwi_display *display, struct peios_gxwi_bytes program,
                    const struct peios_gxwi_bytes *arguments, size_t argument_count);
int peios_gxwi_close(const peios_gxwi_display *display, uint64_t desktop_surface);
int peios_gxwi_log_off(const peios_gxwi_display *display);

/* Blocks for a packet: 1 with a new owned event, 0 at EOF (out=NULL), -1 on
 * failure. Unknown, malformed or truncated packets produce EVENT_OTHER. Unknown roles are
 * omitted from surface lists, preserving the existing desktop protocol. */
int peios_gxwi_receive(const peios_gxwi_display *display, peios_gxwi_event **out);
/* Wakes receivers with EOF, while leaving sending available. */
int peios_gxwi_stop_listening(const peios_gxwi_display *display);
void peios_gxwi_event_destroy(peios_gxwi_event *event);
int peios_gxwi_event_kind(const peios_gxwi_event *event, uint32_t *out);
int peios_gxwi_event_close(const peios_gxwi_event *event, uint64_t *out);
int peios_gxwi_event_surface_count(const peios_gxwi_event *event, size_t *out);
int peios_gxwi_event_surface(const peios_gxwi_event *event, size_t index,
                           struct peios_gxwi_listed *out);

#ifdef __cplusplus
}
#endif
#endif
