// SPDX-License-Identifier: MIT
// Original bounded Relay bridge to the pinned whisper.cpp C API.
// Build against the pinned v1.9.2 headers; no third-party implementation is copied here.
#include <whisper.h>
#include <dlfcn.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef RELAY_STATIC_WHISPER
#define BIND(name) __typeof__(&name) call_##name = &name
#else
#define BIND(name) __typeof__(&name) call_##name = (__typeof__(&name))dlsym(library, #name); if (!call_##name) return 2
#endif
static void discard_log(enum ggml_log_level level, const char *text, void *user) {
    (void)level; (void)text; (void)user;
}

int main(int argc, char **argv) {
    if (argc != 4) return 2;
    FILE *input = fopen(argv[3], "rb");
    if (!input || fseek(input, 0, SEEK_END)) return 2;
    long bytes = ftell(input);
    if (bytes < 1600 * 4 || bytes > 16000 * 120 * 4 || bytes % 4 || fseek(input, 0, SEEK_SET)) { fclose(input); return 2; }
    int count = (int)(bytes / 4);
    float *samples = malloc((size_t)bytes);
    if (!samples || fread(samples, 4, (size_t)count, input) != (size_t)count) { fclose(input); free(samples); return 2; }
    fclose(input);
    double energy = 0;
    for (int i = 0; i < count; ++i) {
        if (!isfinite(samples[i]) || fabsf(samples[i]) > 1.001f) { free(samples); return 2; }
        energy += (double)samples[i] * samples[i];
    }
    if (sqrt(energy / count) < 0.001) { free(samples); return 3; }
#ifdef RELAY_STATIC_WHISPER
    if (strcmp(argv[1], "--builtin")) { free(samples); return 2; }
#else
    void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!library) { free(samples); return 2; }
#endif
    BIND(whisper_log_set);
    BIND(whisper_context_default_params);
    BIND(whisper_init_from_file_with_params);
    BIND(whisper_full_default_params);
    BIND(whisper_full);
    BIND(whisper_full_n_segments);
    BIND(whisper_full_get_segment_text);
    BIND(whisper_free);
    call_whisper_log_set(discard_log, NULL);
    struct whisper_context_params context_params = call_whisper_context_default_params();
#ifdef __APPLE__
    context_params.use_gpu = true;
#else
    context_params.use_gpu = false;
#endif
    struct whisper_context *context = call_whisper_init_from_file_with_params(argv[2], context_params);
    if (!context) { free(samples); return 2; }
    struct whisper_full_params options = call_whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    options.n_threads = 4;
    options.no_context = true;
    options.no_timestamps = true;
    options.print_special = false;
    options.print_progress = false;
    options.print_realtime = false;
    options.print_timestamps = false;
    options.language = "auto";
    options.translate = false;
    int result = call_whisper_full(context, options, samples, count);
    free(samples);
    if (result) { call_whisper_free(context); return 2; }
    size_t length = 0;
    int segments = call_whisper_full_n_segments(context);
    for (int i = 0; i < segments; ++i) {
        const char *text = call_whisper_full_get_segment_text(context, i);
        if (!text) continue;
        size_t size = strlen(text);
        if (length + size > 80000) { call_whisper_free(context); return 2; }
        length += size;
        if (fwrite(text, 1, size, stdout) != size) { call_whisper_free(context); return 2; }
    }
    call_whisper_free(context);
    return length ? 0 : 3;
}
