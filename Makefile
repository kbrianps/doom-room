# Doom Room build. Needs only clang (with the wasm32 target), wasm-ld, curl,
# git, unzip, gzip and python3. Everything else is downloaded into
# toolchain/ and vendor/ by `make deps`.

WASI_SDK_VER     := 34
DOOMGENERIC_REPO := https://github.com/ozkl/doomgeneric.git
DOOMGENERIC_REV  := e257a09527062bfb986b6e5e0780839b6cbd5b71
FREEDM_VER       := 0.13.0

TC      := toolchain
SYSROOT := $(TC)/wasi-sysroot-$(WASI_SDK_VER).0
RT      := $(TC)/libclang_rt-$(WASI_SDK_VER).0/wasm32-unknown-wasip1/libclang_rt.builtins.a
DG      := vendor/doomgeneric/doomgeneric
WAD     := vendor/freedm-$(FREEDM_VER)/freedm.wad
OUT     := build

CC      := clang
CFLAGS  := --target=wasm32-wasip1 --sysroot=$(SYSROOT) -O2 -g0 \
           -I$(DG) -Isrc -DNORMALUNIX -DDOOMGENERIC_RESX=320 -DDOOMGENERIC_RESY=200 \
           -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS \
           -Wno-everything -Werror=implicit-function-declaration \
           -Werror=incompatible-function-pointer-types
LDFLAGS := --target=wasm32-wasip1 --sysroot=$(SYSROOT) -nodefaultlibs -mexec-model=reactor \
           -Wl,--export-dynamic -Wl,-z,stack-size=1048576 \
           -Wl,--initial-memory=67108864 -Wl,--max-memory=268435456 \
           -lc -lwasi-emulated-signal -lwasi-emulated-process-clocks $(RT)

DOOM_SRC := dummy am_map doomdef doomstat dstrings d_event d_items d_iwad \
  d_loop d_main d_mode d_net f_finale f_wipe g_game hu_lib hu_stuff info \
  i_cdmus i_endoom i_joystick i_scale i_sound i_system i_timer memio m_argv \
  m_bbox m_cheat m_config m_controls m_fixed m_menu m_misc m_random p_ceilng \
  p_doors p_enemy p_floor p_inter p_lights p_map p_maputl p_mobj p_plats \
  p_pspr p_saveg p_setup p_sight p_spec p_switch p_telept p_tick p_user r_bsp \
  r_data r_draw r_main r_plane r_segs r_sky r_things sha1 sounds statdump \
  st_lib st_stuff s_sound tables v_video wi_stuff w_checksum w_file w_main \
  w_wad z_zone w_file_stdc i_input i_video doomgeneric mus2mid

OBJS := $(addprefix $(OUT)/doom/,$(addsuffix .o,$(DOOM_SRC))) \
        $(OUT)/src/dg_web.o $(OUT)/src/net.o

all: web/doom.wasm web/freedm.wad.wasm

# ---- dependencies ----------------------------------------------------------

deps: $(SYSROOT) $(RT) $(DG)/.patched $(WAD)

$(SYSROOT):
	mkdir -p $(TC)
	curl -fsSL https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$(WASI_SDK_VER)/wasi-sysroot-$(WASI_SDK_VER).0.tar.gz | tar xz -C $(TC)

$(RT):
	mkdir -p $(TC)
	curl -fsSL https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$(WASI_SDK_VER)/libclang_rt-$(WASI_SDK_VER).0.tar.gz | tar xz -C $(TC)

$(DG)/.patched: patches/doomgeneric.patch
	rm -rf vendor/doomgeneric
	git clone -q $(DOOMGENERIC_REPO) vendor/doomgeneric
	git -C vendor/doomgeneric checkout -q $(DOOMGENERIC_REV)
	git -C vendor/doomgeneric apply ../../patches/doomgeneric.patch
	touch $@

$(WAD):
	mkdir -p vendor
	curl -fsSL -o vendor/freedm.zip https://github.com/freedoom/freedoom/releases/download/v$(FREEDM_VER)/freedm-$(FREEDM_VER).zip
	unzip -q -o vendor/freedm.zip -d vendor && rm vendor/freedm.zip

# ---- engine ----------------------------------------------------------------

web/doom.wasm: $(OBJS)
	$(CC) $(LDFLAGS) $(OBJS) -o $@

$(OUT)/doom/%.o: $(DG)/%.c $(DG)/.patched | $(SYSROOT)
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

$(OUT)/src/%.o: src/%.c src/net.h $(DG)/.patched | $(SYSROOT)
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

# ---- maps: gzip the WAD and wrap it in a data-only wasm module -------------

web/freedm.wad.wasm: $(WAD) tools/pack_wasm.py
	@mkdir -p $(OUT)
	gzip -9 -c $< > $(OUT)/freedm.wad.gz
	python3 -I tools/pack_wasm.py $(OUT)/freedm.wad.gz $@

# ---- dev helpers -----------------------------------------------------------

serve: all
	python3 -m http.server -d web 8080

test: all
	node tools/duel_test.mjs

clean:
	rm -rf $(OUT) web/doom.wasm web/freedm.wad.wasm

distclean: clean
	rm -rf $(TC) vendor

.PHONY: all deps serve test clean distclean
