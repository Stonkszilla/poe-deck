/*
 * gs-pointer — pointer coordinates of an X server as lines on stdout.
 *
 * Measurement [#92] found the analog channel of the panel: the cursor from the left trackpad
 * lives on the GAME server (`:1`) — 270 moves in 30 s, X 0..967, Y 0..799 —
 * while on the session `:0` it stayed in the corner the whole time (ADR 0002, F11).
 * So we still draw on our own server, but take the coordinates from the other one.
 *
 * ── Why a separate binary and not a flag of gs-panel ─────────────────────────
 *
 * The shape is taken from `gs-hotkey-probe`: a small C client reads what bun
 * cannot, and prints lines that the daemon parses. The renderer keeps
 * the one-way seam of ADR 0003 (`rect`, `text`, `show` in, nothing out),
 * and the connection to the other server does not mix with drawing on ours.
 *
 * ── What this deliberately does not do ──────────────────────────────────────
 *
 *  - **no XTEST and no synthetic input**: we read, we do not move. Synthetic
 *    input does not reach the game anyway (ADR 0002, F6);
 *  - **no grab** (`XGrabPointer`): the pointer belongs to the game, we must not
 *    take it away, or the game itself breaks;
 *  - **no event subscription**: `XQueryPointer` asks for the state, and
 *    it needs neither focus nor event delivery to our window. This is exactly why
 *    the invariant "input never arrives from the overlay layer" still holds.
 *
 * Output — only CHANGES of the position:
 *
 *   pointer <x> <y> <mask>
 *
 * A finger that does not move must not flood the daemon log with tens of lines per second.
 *
 *   gs-pointer [--display :1] [--hz 60] [--seconds 0] [--once]
 *
 * `--seconds 0` — live until killed (runtime). Exit codes: 2 — the server did not
 * open, 3 — the connection dropped while running. Both degrade with words, not
 * with a stack trace: the daemon must survive when the game server goes away.
 */

#include <X11/Xlib.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static int on_io_error(Display *dpy)
{
	(void)dpy;
	printf("✗  connection to the server dropped: the game closed or the server went away\n");
	fflush(stdout);
	exit(3);
}

static void sleep_ns(long ns)
{
	struct timespec ts = { .tv_sec = ns / 1000000000L, .tv_nsec = ns % 1000000000L };
	nanosleep(&ts, NULL);
}

static double now_seconds(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

int main(int argc, char **argv)
{
	const char *display_name = NULL;
	int hz = 60;
	int seconds = 0;
	bool once = false;

	for (int i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--display") == 0 && i + 1 < argc) {
			display_name = argv[++i];
		} else if (strcmp(argv[i], "--hz") == 0 && i + 1 < argc) {
			hz = atoi(argv[++i]);
		} else if (strcmp(argv[i], "--seconds") == 0 && i + 1 < argc) {
			seconds = atoi(argv[++i]);
		} else if (strcmp(argv[i], "--once") == 0) {
			once = true;
		} else {
			printf("✗  unknown argument %s\n", argv[i]);
			printf("   gs-pointer [--display :1] [--hz 60] [--seconds 0] [--once]\n");
			return 2;
		}
	}

	if (hz < 1 || hz > 500) {
		printf("✗  --hz outside 1..500: %d\n", hz);
		return 2;
	}

	/* The default is the environment variable, as for any X client. The caller
	 * passes the game server: the caller knows where the cursor is (measurement #92). */
	Display *dpy = XOpenDisplay(display_name);
	if (!dpy) {
		printf("✗  cannot open server %s\n", display_name ? display_name : (getenv("DISPLAY") ? getenv("DISPLAY") : "(DISPLAY is not set)"));
		printf("   the game server can have its own Xauthority, this is not a fault of the probe\n");
		return 2;
	}
	XSetIOErrorHandler(on_io_error);

	Window root = DefaultRootWindow(dpy);
	printf("✓  pointer %s: screen %dx%d, polling %d Hz\n",
	       DisplayString(dpy), DisplayWidth(dpy, DefaultScreen(dpy)),
	       DisplayHeight(dpy, DefaultScreen(dpy)), hz);
	fflush(stdout);

	const long period_ns = 1000000000L / hz;
	const double deadline = seconds > 0 ? now_seconds() + seconds : 0;
	int last_x = -1, last_y = -1;
	unsigned int last_mask = 0;
	bool first = true;

	for (;;) {
		Window root_ret, child_ret;
		int rx = 0, ry = 0, wx = 0, wy = 0;
		unsigned int mask = 0;

		/* False — the pointer is on another screen of the same server. The Deck has
		 * one screen, but we must not stay silent: silence looks the same as "not moving". */
		if (!XQueryPointer(dpy, root, &root_ret, &child_ret, &rx, &ry, &wx, &wy, &mask)) {
			printf("⚠  pointer is on another screen, no coordinates\n");
			fflush(stdout);
		} else if (first || rx != last_x || ry != last_y || mask != last_mask) {
			printf("pointer %d %d %u\n", rx, ry, mask);
			fflush(stdout);
			last_x = rx;
			last_y = ry;
			last_mask = mask;
			first = false;
			if (once)
				break;
		}

		if (deadline > 0 && now_seconds() >= deadline)
			break;
		sleep_ns(period_ns);
	}

	XCloseDisplay(dpy);
	return 0;
}
