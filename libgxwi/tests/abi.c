#include <peios/gxwi.h>

#include <assert.h>
#include <errno.h>
#include <stddef.h>
#include <stdint.h>

/* These checks protect the public ABI on supported 64-bit targets. */
_Static_assert(sizeof(struct peios_gxwi_bytes) == 16, "byte span layout");
_Static_assert(sizeof(struct peios_gxwi_live_options) == 64, "live options layout");
_Static_assert(offsetof(struct peios_gxwi_live_options, styles) == 48, "styles offset");
_Static_assert(sizeof(struct peios_gxwi_listed) == 104, "listed layout");
_Static_assert(offsetof(struct peios_gxwi_listed, own) == 64, "own offset");
_Static_assert(offsetof(struct peios_gxwi_listed, application_id) == 72, "application offset");

int main(void) {
    uint32_t kind = UINT32_MAX;
    uint64_t surface = UINT64_MAX;
    size_t count = SIZE_MAX;
    int fd = -2;
    struct peios_gxwi_listed listed = { .id = UINT64_MAX };
    struct peios_gxwi_bytes empty = { .data = NULL, .len = 0 };

    assert(peios_gxwi_abi_version() == PEIOS_GXWI_ABI_VERSION);
    peios_gxwi_display_destroy(NULL);
    peios_gxwi_event_destroy(NULL);
    errno = 0;
    assert(peios_gxwi_connect(NULL) == -1 && errno == EINVAL);
    assert(peios_gxwi_serve(NULL, &fd) == -1 && errno == EINVAL && fd == -2);
    assert(peios_gxwi_create_live(NULL, NULL) == -1 && errno == EINVAL);
    assert(peios_gxwi_create_raw(NULL, 1, empty, empty) == -1 && errno == EINVAL);
    assert(peios_gxwi_title(NULL, 1, empty) == -1 && errno == EINVAL);
    assert(peios_gxwi_destroy(NULL, 1) == -1 && errno == EINVAL);
    assert(peios_gxwi_start(NULL, empty, NULL, 0) == -1 && errno == EINVAL);
    assert(peios_gxwi_close(NULL, 1) == -1 && errno == EINVAL);
    assert(peios_gxwi_log_off(NULL) == -1 && errno == EINVAL);
    assert(peios_gxwi_receive(NULL, NULL) == -1 && errno == EINVAL);
    assert(peios_gxwi_stop_listening(NULL) == -1 && errno == EINVAL);
    assert(peios_gxwi_event_kind(NULL, &kind) == -1 && errno == EINVAL);
    assert(kind == UINT32_MAX);
    assert(peios_gxwi_event_close(NULL, &surface) == -1 && errno == EINVAL);
    assert(surface == UINT64_MAX);
    assert(peios_gxwi_event_surface_count(NULL, &count) == -1 && errno == EINVAL);
    assert(count == SIZE_MAX);
    assert(peios_gxwi_event_surface(NULL, 0, &listed) == -1 && errno == EINVAL);
    assert(listed.id == UINT64_MAX);
    return 0;
}
