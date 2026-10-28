// Web platform layer for doomgeneric. JS provides time and presents frames;
// keys are pushed in from JS through dg_push_key.

#include <stdint.h>
#include "doomgeneric.h"
#include "d_event.h"

#define WASM_IMPORT(name) __attribute__((import_module("env"), import_name(name)))

WASM_IMPORT("js_now_ms") double js_now_ms(void);
WASM_IMPORT("js_draw_frame") void js_draw_frame(pixel_t *buf, int w, int h);
WASM_IMPORT("js_set_title") void js_set_title(const char *title);

#define KEYQUEUE_SIZE 64
static uint16_t key_queue[KEYQUEUE_SIZE];
static unsigned key_w = 0, key_r = 0;

__attribute__((export_name("dg_push_key")))
void dg_push_key(int pressed, int doom_key)
{
    key_queue[key_w] = (uint16_t)(((pressed ? 1 : 0) << 8) | (doom_key & 0xff));
    key_w = (key_w + 1) % KEYQUEUE_SIZE;
}

// Mouse: buttons bitfield (1 left, 2 right, 4 middle) and horizontal turn.
// Vertical motion is ignored so the mouse never walks the player forward.
__attribute__((export_name("dg_mouse")))
void dg_mouse(int buttons, int dx)
{
    event_t ev = { .type = ev_mouse, .data1 = buttons, .data2 = dx, .data3 = 0 };
    D_PostEvent(&ev);
}

__attribute__((export_name("dg_create")))
void dg_create(int argc, char **argv)
{
    doomgeneric_Create(argc, argv);
}

__attribute__((export_name("dg_tick")))
void dg_tick(void)
{
    doomgeneric_Tick();
}

__attribute__((export_name("dg_malloc")))
void *dg_malloc(unsigned long n)
{
    return malloc(n);
}

// i_system.c calls system() for an error dialog on some platforms.
int system(const char *cmd) { (void)cmd; return -1; }

void DG_Init(void) {}

void DG_DrawFrame(void)
{
    js_draw_frame(DG_ScreenBuffer, DOOMGENERIC_RESX, DOOMGENERIC_RESY);
}

// No real sleeping in the browser; Doom only uses this inside short busy-waits.
void DG_SleepMs(uint32_t ms) { (void)ms; }

uint32_t DG_GetTicksMs(void)
{
    return (uint32_t)js_now_ms();
}

int DG_GetKey(int *pressed, unsigned char *doom_key)
{
    if (key_r == key_w)
        return 0;
    uint16_t k = key_queue[key_r];
    key_r = (key_r + 1) % KEYQUEUE_SIZE;
    *pressed = k >> 8;
    *doom_key = k & 0xff;
    return 1;
}

void DG_SetWindowTitle(const char *title)
{
    js_set_title(title);
}
