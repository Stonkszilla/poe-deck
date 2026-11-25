/*
 * gs-hotkey-probe — probe for the gamescope global hotkey.
 *
 * It answers the main risk of the input epic: can a REGULAR third-party
 * Wayland client bind `gamescope_action_binding`, or is the protocol in fact
 * available only to Steam. Bash cannot reach it: a real client is necessary.
 *
 * Modes:
 *
 *   --dump      Connect, list all globals of the socket and exit. Binds and
 *               arms nothing, so it is safe to run in a live session with the game.
 *               Exit code 0 <=> gamescope_action_binding_manager is in the list.
 *   (default)   Bind the manager, create a binding, register the chords,
 *               arm it and listen for `triggered` for the given number of seconds,
 *               printing each trigger with a timestamp.
 *
 * What the probe does NOT do and cannot do: tell if the key reached the game.
 * Only the operator can see that, in PoE itself. The probe answers for its own
 * half ("do we hear it") and prints what to expect from the other half.
 *
 * Two facts from the gamescope sources, without which a run reads wrong:
 *
 * 1. THE SET COMPARISON IS EXACT, AND IT RUNS ON EVERY KEY EVENT. The hotkey
 *    fires unless `setPressedKeySyms != keybind.setKeySyms` -> continue
 *    (wlserver.cpp:2501, master): the pressed keysyms must be exactly the
 *    same set, one extra held Shift breaks the match, and a binding on {D}
 *    does not fire on Ctrl+D. The other side: intermediate states are also
 *    compared, so the marker set must not occur on the way to another chord
 *    that we send.
 *
 *    Hence the default: TWO chords, Ctrl+D with the left and the right Control.
 *    We do not know in advance which one Steam Input sends. Many triggers on
 *    one binding are a supported case: `add_keyboard_trigger` collects them
 *    in a vector.
 *
 * 2. THE BLOCK FLAG DOES NOT MEAN WHAT THE PROTOCOL SAYS, and before
 *    gamescope 3.16.12 it meant nothing at all. Details are in the README
 *    (§ "Blocking: three versions of the truth"); the probe prints the
 *    expectation itself, so the operator knows what to look for in the game.
 *
 * Why C and not TypeScript (the project stack): the protocol is private and
 * wayland-only, SteamOS ships no libwayland binding for bun, and wayland-scanner
 * generates the marshalling from the XML in one command. This is a spike tool,
 * not application code.
 *
 * Build: ./build.sh (on the Deck inside distrobox: the system has no compiler
 * and no headers). Check without a Deck: ./check.sh, it starts a compositor mock.
 */

#include "gamescope-action-binding-client-protocol.h"

#include <errno.h>
#include <poll.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <wayland-client.h>

/* How often to print the status line, in seconds. The same as gs-overlay-probe:
 * the log of a one-minute run stays readable, and "probe is alive" is visible
 * without a screen. */
#define TICK_SECONDS 2

#define MAX_CHORDS 8
#define MAX_KEYS_PER_CHORD 8

struct chord {
	uint32_t keysym[MAX_KEYS_PER_CHORD];
	int count;
	char name[128];      /* how the chord looks in the log */
	unsigned triggers;   /* how many times this chord fired */
};

/* Argument order of the `triggered` event, detected on the fly (see on_triggered). */
enum arg_order { ORDER_UNSET = -1, ORDER_UNKNOWN, ORDER_XML, ORDER_SWAPPED };

struct state {
	struct gamescope_action_binding_manager *manager;
	uint32_t manager_name;
	uint32_t manager_version;
	bool dump;
	int globals;
	unsigned triggers;
	enum arg_order order;
};

/* Keysym names that are enough for this spike. The full table lives in
 * libxkbcommon, but a runtime dependency for ten names is not worth it:
 * anything not in the table is written as a hex code (0xffca). */
static const struct {
	const char *name;
	uint32_t sym;
} k_keysyms[] = {
	{ "Control_L", 0xffe3 }, { "Control_R", 0xffe4 },
	{ "Alt_L",     0xffe9 }, { "Alt_R",     0xffea },
	{ "Shift_L",   0xffe1 }, { "Shift_R",   0xffe2 },
	{ "Super_L",   0xffeb }, { "Super_R",   0xffec },
	{ "F13", 0xffca }, { "F14", 0xffcb }, { "F15", 0xffcc }, { "F16", 0xffcd },
	{ "F17", 0xffce }, { "F18", 0xffcf }, { "F19", 0xffd0 }, { "F20", 0xffd1 },
};

/* The inverse of keysym_parse. The caller gives the buffer, because printable
 * ASCII has no name in the table; otherwise "D" would print as 0x44. */
static const char *keysym_name(uint32_t sym, char *buf, size_t size)
{
	for (size_t i = 0; i < sizeof(k_keysyms) / sizeof(k_keysyms[0]); i++)
		if (k_keysyms[i].sym == sym)
			return k_keysyms[i].name;

	if (sym > 0x20 && sym < 0x7f) {
		snprintf(buf, size, "%c", (char)sym);
		return buf;
	}

	snprintf(buf, size, "0x%x", sym);
	return buf;
}

static bool keysym_parse(const char *name, uint32_t *out)
{
	for (size_t i = 0; i < sizeof(k_keysyms) / sizeof(k_keysyms[0]); i++) {
		if (strcmp(k_keysyms[i].name, name) == 0) {
			*out = k_keysyms[i].sym;
			return true;
		}
	}

	/* A single printable ASCII character is its own keysym (Latin-1 matches ASCII).
	 * gamescope normalizes the case with xkb_keysym_to_upper anyway, so
	 * "d" and "D" give the same trigger. */
	if (name[0] && !name[1] && name[0] > 0x20 && name[0] < 0x7f) {
		*out = (uint32_t)(unsigned char)name[0];
		return true;
	}

	char *end = NULL;
	unsigned long value = strtoul(name, &end, 0);
	if (end && *end == '\0' && end != name && value != 0 && value <= 0xffffffffUL) {
		*out = (uint32_t)value;
		return true;
	}
	return false;
}

/* "Control_L+Alt_L+F13" -> set of keysyms. Returns false if a name does not parse. */
static bool chord_parse(const char *spec, struct chord *out)
{
	char buf[256];
	if (strlen(spec) >= sizeof(buf)) {
		fprintf(stderr, "✗  chord is longer than %zu characters: %s\n", sizeof(buf) - 1, spec);
		return false;
	}
	strcpy(buf, spec);

	out->count = 0;
	for (char *tok = strtok(buf, "+"); tok; tok = strtok(NULL, "+")) {
		if (out->count == MAX_KEYS_PER_CHORD) {
			fprintf(stderr, "✗  more than %d keys in a chord: %s\n", MAX_KEYS_PER_CHORD, spec);
			return false;
		}
		if (!keysym_parse(tok, &out->keysym[out->count])) {
			fprintf(stderr, "✗  unknown key \"%s\" — write it as a code, for example 0xffca\n", tok);
			return false;
		}
		out->count++;
	}
	return out->count > 0;
}

/* Human-readable chord name. It goes to the probe log and to set_description.
 * gamescope writes the description to its own journal, so "did our trigger fire"
 * can also be checked from its side (journalctl -b | grep -i binding). */
static void chord_name(struct chord *c)
{
	size_t used = 0;
	c->name[0] = '\0';
	for (int i = 0; i < c->count; i++) {
		char sym[32], part[48];
		snprintf(part, sizeof(part), "%s%s", i ? "+" : "",
		         keysym_name(c->keysym[i], sym, sizeof(sym)));

		size_t len = strlen(part);
		if (used + len + 1 >= sizeof(c->name))
			break;
		memcpy(c->name + used, part, len + 1);
		used += len;
	}
}

static uint64_t now_nanos(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

/* ── events ──────────────────────────────────────────────────────────────── */

static void on_global(void *data, struct wl_registry *registry, uint32_t name,
                      const char *interface, uint32_t version)
{
	struct state *st = data;
	st->globals++;

	bool ours = strcmp(interface, gamescope_action_binding_manager_interface.name) == 0;
	if (st->dump)
		printf("  %-52s v%-2u%s\n", interface, version, ours ? "  ← the one we need" : "");

	if (!ours)
		return;

	st->manager_name = name;
	st->manager_version = version;
	if (!st->dump) {
		uint32_t bind_version =
			version < (uint32_t)gamescope_action_binding_manager_interface.version
			? version : (uint32_t)gamescope_action_binding_manager_interface.version;
		st->manager = wl_registry_bind(registry, name,
		                               &gamescope_action_binding_manager_interface,
		                               bind_version);
	}
}

static void on_global_remove(void *data, struct wl_registry *registry, uint32_t name)
{
	struct state *st = data;
	(void)registry;
	if (name == st->manager_name && st->manager)
		printf("⚠  hotkey manager left the registry — gamescope revoked it\n");
}

static const struct wl_registry_listener k_registry_listener = {
	.global = on_global,
	.global_remove = on_global_remove,
};

/* The arguments arrive under the names from the XML, but the names cannot be
 * trusted: gamescope ≤3.16.24 sends them in a different order than its own XML
 * of the same tag declares:
 *
 *   XML  :  sequence, time_lo, time_hi, trigger_flags
 *   ≤3.16.24: sequence, trigger_flags, time_lo, time_hi   (src/WaylandServer/
 *             GamescopeActionBinding.h, the send_triggered call; fixed in 3.16.25)
 *
 * The Deck has 3.16.23.4, a version with the mismatch: reading by the XML, we
 * got a time of 424 years and flags 0x159b. We do not tell them apart by version
 * (the protocol cannot report it), but by the time itself: our own CLOCK_MONOTONIC
 * is the reference, and exactly one of the two layouts is plausible.
 */
/* Listener context: the `triggered` event does NOT tell which trigger matched;
 * it carries only sequence, time and flags. So each chord gets its own binding
 * with its own listener, and "which one fired" is read from the object.
 * Without this, run #37 gave 62 events, and nobody could say if even one of
 * them was Ctrl+D. */
struct binding_ctx {
	struct state *st;
	struct chord *chord;
};

static void on_triggered(void *data, struct gamescope_action_binding *binding,
                         uint32_t sequence, uint32_t time_lo, uint32_t time_hi,
                         uint32_t trigger_flags)
{
	struct binding_ctx *ctx = data;
	struct state *st = ctx->st;
	(void)binding;

	uint64_t now = now_nanos();
	uint64_t as_xml = ((uint64_t)time_hi << 32) | (uint64_t)time_lo;
	uint64_t as_swapped = ((uint64_t)trigger_flags << 32) | (uint64_t)time_hi;

	/* By construction the event is less than a minute old: we just received it.
	 * One second of tolerance forward covers a timestamp slightly ahead of
	 * our clock_gettime: the goal is to tell a plausible value from 424 years,
	 * not to catch nanoseconds. */
	bool xml_ok = as_xml < now + 1000000000ull && now < as_xml + 60000000000ull;
	bool swapped_ok = as_swapped < now + 1000000000ull && now < as_swapped + 60000000000ull;

	enum arg_order order = ORDER_UNKNOWN;
	uint64_t event_ns = as_xml;
	uint32_t flags = trigger_flags;

	if (xml_ok && !swapped_ok) {
		order = ORDER_XML;
	} else if (swapped_ok && !xml_ok) {
		order = ORDER_SWAPPED;
		event_ns = as_swapped;
		flags = time_lo;
	}

	if (order != st->order) {
		st->order = order;
		printf("  triggered argument order: %s\n",
		       order == ORDER_XML ? "as in XML (gamescope ≥3.16.25)"
		     : order == ORDER_SWAPPED ? "as in gamescope ≤3.16.24 — flags and time are swapped"
		     : "NOT RECOGNIZED, the time below is unreadable");
	}

	char lag[80];
	if (order == ORDER_UNKNOWN)
		snprintf(lag, sizeof(lag), "⚠ raw arguments 0x%x 0x%x 0x%x",
		         time_lo, time_hi, trigger_flags);
	else
		snprintf(lag, sizeof(lag), "reached us in %.2f ms",
		         (double)(now - event_ns) / 1e6);

	st->triggers++;
	ctx->chord->triggers++;
	printf("  ★ [%s] #%u  seq=%u  t=%.6f s CLOCK_MONOTONIC  %s  flags=0x%x%s\n",
	       ctx->chord->name, st->triggers, sequence, (double)event_ns / 1e9, lag, flags,
	       (flags & GAMESCOPE_ACTION_BINDING_TRIGGER_FLAG_KEYBOARD) ? " (keyboard)" : "");
	fflush(stdout);
}

static const struct gamescope_action_binding_listener k_binding_listener = {
	.triggered = on_triggered,
};

/* ── loop ────────────────────────────────────────────────────────────────── */

/* One pass: wait for events or a timeout. Returns false if the connection
 * broke (gamescope is gone); this outcome is separate from "no presses". */
static bool pump(struct wl_display *display, int timeout_ms)
{
	while (wl_display_prepare_read(display) != 0) {
		if (wl_display_dispatch_pending(display) < 0)
			return false;
	}

	if (wl_display_flush(display) < 0 && errno != EAGAIN) {
		wl_display_cancel_read(display);
		return false;
	}

	struct pollfd pfd = { .fd = wl_display_get_fd(display), .events = POLLIN };
	int ready = poll(&pfd, 1, timeout_ms);
	if (ready <= 0) {
		wl_display_cancel_read(display);
		return ready == 0 || errno == EINTR;
	}

	if (wl_display_read_events(display) < 0)
		return false;
	return wl_display_dispatch_pending(display) >= 0;
}

/* ── main ────────────────────────────────────────────────────────────────── */

static void usage(void)
{
	fprintf(stderr,
	    "gs-hotkey-probe [--dump] [--seconds N] [--no-block] [--display SOCKET]\n"
	    "                [--keys Control_L+Alt_L+F13]…\n"
	    "\n"
	    "  --dump      list the globals of the socket and exit; code 0 = hotkey manager present\n"
	    "  --seconds   how long to listen, default 60\n"
	    "  --no-block  set the no_block bit of the protocol (see README, § blocking)\n"
	    "  --keys      chord, repeatable; default is Ctrl+D with the left\n"
	    "              and the right Control\n"
	    "  --display   socket name; default is GAMESCOPE_WAYLAND_DISPLAY,\n"
	    "              then WAYLAND_DISPLAY, then gamescope-0\n");
}

int main(int argc, char **argv)
{
	struct state st = { .order = ORDER_UNSET };
	int seconds = 60;
	uint32_t arm_flags = 0;
	const char *socket_name = NULL;
	/* Zero it: the trigger counter and the chord name live right here, and
	 * chord_parse does not touch them. Garbage in them would go to the final breakdown. */
	struct chord chords[MAX_CHORDS] = { 0 };
	int chord_count = 0;

	for (int i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--dump") == 0) {
			st.dump = true;
		} else if (strcmp(argv[i], "--no-block") == 0) {
			arm_flags |= GAMESCOPE_ACTION_BINDING_ARM_FLAG_NO_BLOCK;
		} else if (strcmp(argv[i], "--seconds") == 0 && i + 1 < argc) {
			seconds = atoi(argv[++i]);
		} else if (strcmp(argv[i], "--display") == 0 && i + 1 < argc) {
			socket_name = argv[++i];
		} else if (strcmp(argv[i], "--keys") == 0 && i + 1 < argc) {
			if (chord_count == MAX_CHORDS) {
				fprintf(stderr, "✗  more than %d chords is not supported\n", MAX_CHORDS);
				return 2;
			}
			if (!chord_parse(argv[++i], &chords[chord_count]))
				return 2;
			chord_count++;
		} else {
			usage();
			return 2;
		}
	}

	/* Default: the left and the right modifier variants. Which one Steam Input
	 * sends is unknown until a run on the hardware, and the comparison is exact.
	 *
	 * The key is "D", not "F13" as the input recon suggested: Steam Input CANNOT
	 * send F13-F24 (the configurator does not show them; checked against
	 * Valve discussions, README § "What to press").
	 *
	 * The chord is Ctrl+D, two keys and not three. The key count does not matter:
	 * the marker set must not occur on the way to another chord that we send, and
	 * {Ctrl,D} satisfies this: "D" is not in Ctrl+Alt+C, which goes to the game.
	 * This exact pair can go on two back buttons of the Deck and be pressed
	 * by hand today; awakened-poe-trade also uses Ctrl+D.
	 * Whether PoE itself uses "D" is a separate question; MODE=GAMEKEY closes it. */
	if (chord_count == 0) {
		static const char *k_default[] = { "Control_L+D", "Control_R+D" };
		for (size_t i = 0; i < sizeof(k_default) / sizeof(k_default[0]); i++)
			if (chord_parse(k_default[i], &chords[chord_count]))
				chord_count++;
	}

	if (!socket_name)
		socket_name = getenv("GAMESCOPE_WAYLAND_DISPLAY");
	if (!socket_name)
		socket_name = getenv("WAYLAND_DISPLAY");
	if (!socket_name)
		socket_name = "gamescope-0";

	printf("socket: %s (XDG_RUNTIME_DIR=%s)\n", socket_name,
	       getenv("XDG_RUNTIME_DIR") ? getenv("XDG_RUNTIME_DIR") : "not set");

	struct wl_display *display = wl_display_connect(socket_name);
	if (!display) {
		printf("✗  could not connect to socket %s: %s\n", socket_name, strerror(errno));
		printf("   in Game Mode the socket name is in /run/user/<uid>/gamescope-environment\n");
		return 1;
	}
	printf("✓  connected to the socket as a regular client, with no special rights\n");

	struct wl_registry *registry = wl_display_get_registry(display);
	wl_registry_add_listener(registry, &k_registry_listener, &st);
	if (wl_display_roundtrip(display) < 0) {
		printf("✗  registry did not arrive: %s\n", strerror(errno));
		return 1;
	}

	if (st.dump) {
		printf("\nglobals in total: %d\n", st.globals);
		if (!st.manager_version) {
			printf("✗  gamescope_action_binding_manager is NOT in the registry — "
			       "either this is not gamescope, or the protocol is closed to us\n");
			return 1;
		}
		printf("✓  gamescope_action_binding_manager present, version %u — "
		       "the protocol is available to a third-party client\n", st.manager_version);
		return 0;
	}

	if (!st.manager) {
		printf("✗  gamescope_action_binding_manager is NOT in the registry. Globals in total: %d.\n",
		       st.globals);
		printf("   SPIKE ANSWER: NO. The main input path is out, go to the fallbacks.\n");
		return 1;
	}
	printf("✓  hotkey manager bound: global version %u, we took %u\n",
	       st.manager_version, gamescope_action_binding_manager_interface.version);

	/* ONE BINDING PER CHORD, not one object with a list of triggers.
	 * The `triggered` event does not tell which trigger matched, so the only
	 * way to tell them apart is the receiving object. The manager creates
	 * bindings with no limit on their number. */
	struct gamescope_action_binding *bindings[MAX_CHORDS];
	struct binding_ctx ctxs[MAX_CHORDS];

	for (int i = 0; i < chord_count; i++) {
		chord_name(&chords[i]);

		bindings[i] = gamescope_action_binding_manager_create_action_binding(st.manager);
		if (!bindings[i]) {
			printf("✗  create_action_binding returned no object for chord %s\n",
			       chords[i].name);
			return 1;
		}

		ctxs[i].st = &st;
		ctxs[i].chord = &chords[i];
		gamescope_action_binding_add_listener(bindings[i], &k_binding_listener, &ctxs[i]);

		char desc[192];
		snprintf(desc, sizeof(desc), "poe-deck hotkey: %s", chords[i].name);
		gamescope_action_binding_set_description(bindings[i], desc);

		struct wl_array keysyms;
		wl_array_init(&keysyms);
		for (int k = 0; k < chords[i].count; k++) {
			uint32_t *slot = wl_array_add(&keysyms, sizeof(uint32_t));
			if (!slot) {
				printf("✗  out of memory for the keysym array\n");
				return 1;
			}
			*slot = chords[i].keysym[k];
		}
		gamescope_action_binding_add_keyboard_trigger(bindings[i], &keysyms);
		wl_array_release(&keysyms);

		gamescope_action_binding_arm(bindings[i], arm_flags);
		printf("  trigger %d: %s\n", i + 1, chords[i].name);
	}

	if (wl_display_roundtrip(display) < 0) {
		printf("✗  server rejected the binding: %s\n", strerror(errno));
		printf("   SPIKE ANSWER: NO, the protocol is closed to third-party clients.\n");
		return 1;
	}
	printf("✓  binding armed, arm_flags=0x%x (%s)\n", arm_flags,
	       (arm_flags & GAMESCOPE_ACTION_BINDING_ARM_FLAG_NO_BLOCK)
	           ? "no_block bit SET" : "no_block bit not set");

	/* The one thing the probe does not measure itself: did the key reach the game.
	 * So it names what to look at, and why the answer is not obvious. */
	printf("\nWHAT TO WATCH IN THE GAME. The protocol promises: without no_block the key\n"
	       "is intercepted and does not reach the application. The sources say otherwise:\n"
	       "since 3.16.12 it is a SET no_block that blocks, and before 3.16.12\n"
	       "there is no blocking at all. Details: README, § \"Blocking: three versions of the truth\".\n"
	       "Run it both ways and watch if PoE reacts to the marker key.\n");

	printf("\nlistening for %d s. Press the assigned button, both in the game and in QAM.\n", seconds);
	fflush(stdout);

	uint64_t started = now_nanos();
	uint64_t deadline = started + (uint64_t)seconds * 1000000000ull;
	uint64_t next_tick = started + (uint64_t)TICK_SECONDS * 1000000000ull;
	bool alive = true;

	while (alive) {
		uint64_t now = now_nanos();
		if (now >= deadline)
			break;

		uint64_t until = next_tick > now ? next_tick - now : 0;
		uint64_t left = deadline - now;
		if (until > left)
			until = left;

		alive = pump(display, (int)(until / 1000000ull));

		now = now_nanos();
		if (now >= next_tick) {
			printf("  [%3llu s] alive, triggers %u\n",
			       (unsigned long long)((now - started) / 1000000000ull), st.triggers);
			fflush(stdout);
			next_tick = now + (uint64_t)TICK_SECONDS * 1000000000ull;
		}
	}

	printf("\n");
	if (!alive) {
		printf("✗  connection to gamescope broke before the end of the run "
		       "(triggers collected: %u)\n", st.triggers);
		wl_display_disconnect(display);
		return 1;
	}

	for (int i = 0; i < chord_count; i++) {
		gamescope_action_binding_disarm(bindings[i]);
		gamescope_action_binding_destroy(bindings[i]);
	}
	wl_display_roundtrip(display);
	wl_display_disconnect(display);

	if (st.triggers == 0) {
		printf("RESULT: binding ACCEPTED, but it did not fire once in %d s.\n", seconds);
		printf("      chords we listened for:");
		for (int i = 0; i < chord_count; i++)
			printf(" %s", chords[i].name);
		printf("\n");
		printf("      This is NOT a \"no\": the third-party client could bind.\n");
		printf("      Two branches from here: either the key did not reach gamescope\n");
		printf("      (check Steam Input), or the keysym set did not match exactly\n");
		printf("      (try --keys with other combinations).\n");
		return 1;
	}

	printf("RESULT: YES. A third-party client binds gamescope_action_binding and receives\n");
	printf("      events: %u of them in %d s. What remains is to confirm by eye\n",
	       st.triggers, seconds);
	printf("      if the key also reached the game.\n\n");

	/* The per-chord breakdown is the reason for one binding per chord.
	 * Without it, "62 events" does not answer if the right chord fired
	 * or a single lone modifier produced all of them. */
	printf("      per chord:\n");
	for (int i = 0; i < chord_count; i++)
		printf("        %-28s %u%s\n", chords[i].name, chords[i].triggers,
		       chords[i].triggers ? "" : "   ← never");
	return 0;
}
