/*
 * gs-clip — the content of the X11 CLIPBOARD on stdout.
 *
 * Before it, the clipboard was read by `xclip` inside the distrobox `gs-probe`: stock
 * SteamOS has no xclip, and the player has no container and no toolchain at all.
 * This binary has the same shape as `gs-pointer`: a small Xlib client reads
 * what bun cannot, and gives the bytes to the daemon. The same `build.sh` builds it,
 * and it links only with libX11, which the stock rootfs has.
 *
 * It reads exactly what xclip read: `xclip -o -selection clipboard`, that is
 * the UTF8_STRING target with a fallback to STRING. The game under Proton gives UTF8_STRING;
 * the fallback is for an owner that knows only Latin-1.
 *
 * ── What this deliberately does not do ──────────────────────────────────────
 *
 *  - **no selection ownership**: we only ask for a copy. To own the clipboard
 *    means to live while the clipboard is needed, and xclip already failed on that on the Deck
 *    (tools/probe-deck-input.sh, run #52);
 *  - **no wait for a change**: one request, one answer. The daemon decides
 *    if the clipboard is fresh (`clipboardAfterTrigger` in src/slice.ts), and it calls us
 *    again.
 *
 * The owner gives a large clipboard in chunks by the INCR protocol, and it is supported: item
 * text is short, but a reader that silently cuts a long clipboard is worse than none.
 *
 *   gs-clip [--display :0] [--timeout-ms 2000] [--selection CLIPBOARD|PRIMARY] [--trace]
 *
 * `--trace` names the chunked transfer in stderr, to check that INCR
 * really happened, and not only that the bytes match.
 *
 * Exit codes: 0 — bytes on stdout (an empty clipboard is also 0 with empty output);
 * 1 — the selection has no owner or the owner refused; 2 — the server did not open
 * or the arguments did not parse; 3 — the owner did not answer in the given time;
 * 4 — the answer came but could not be read (XGetWindowProperty or memory failed)
 * or could not be written to stdout.
 * The cause of each non-zero code is one line in stderr.
 */

#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <errno.h>
#include <limits.h>
#include <poll.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static long now_ms(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (long)ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

/* Protocol errors (BadWindow from a dead owner and the like) must not kill
 * the process with the default Xlib handler: the result is visible from the answer anyway. */
static int on_error(Display *dpy, XErrorEvent *ev)
{
	(void)dpy;
	(void)ev;
	return 0;
}

/*
 * Waits for an event for which `match` returns true, but not longer than `deadline`.
 * It polls the socket, not a bare XNextEvent: that one hangs forever if the owner is silent —
 * exactly the pitfall that made the daemon wrap xclip in `timeout`.
 */
static bool wait_event(Display *dpy, XEvent *ev, long deadline,
		       bool (*match)(const XEvent *, const void *), const void *arg)
{
	for (;;) {
		while (XPending(dpy) > 0) {
			XNextEvent(dpy, ev);
			if (match(ev, arg))
				return true;
		}
		long left = deadline - now_ms();
		if (left <= 0)
			return false;
		struct pollfd pfd = { .fd = ConnectionNumber(dpy), .events = POLLIN };
		if (poll(&pfd, 1, (int)left) < 0 && errno != EINTR)
			return false;
	}
}

struct selection_wait {
	Window win;
	Atom selection;
};

static bool is_selection_notify(const XEvent *ev, const void *arg)
{
	const struct selection_wait *w = arg;
	return ev->type == SelectionNotify && ev->xselection.requestor == w->win &&
	       ev->xselection.selection == w->selection;
}

struct property_wait {
	Window win;
	Atom property;
};

static bool is_new_value(const XEvent *ev, const void *arg)
{
	const struct property_wait *w = arg;
	return ev->type == PropertyNotify && ev->xproperty.window == w->win &&
	       ev->xproperty.atom == w->property && ev->xproperty.state == PropertyNewValue;
}

/* Reads the whole property and deletes it — the delete is the signal to the INCR
 * owner "send the next chunk". The property type goes to `type`, the bytes to `out`.
 *
 * false — the property could not be read or the bytes have nowhere to go. This is a separate
 * result, not an empty clipboard: otherwise a failure would look like "copied empty", and
 * in the middle of INCR like a normal end of transfer, and the output would be silently cut. */
static bool take_property(Display *dpy, Window win, Atom prop, Atom *type,
			  unsigned char **out, unsigned long *len)
{
	int format = 0;
	unsigned long items = 0, after = 0;
	unsigned char *data = NULL;
	bool ok = true;

	*type = None;
	*out = NULL;
	*len = 0;
	if (XGetWindowProperty(dpy, win, prop, 0, LONG_MAX / 4, True, AnyPropertyType,
			       type, &format, &items, &after, &data) != Success)
		return false;
	if (data && items > 0) {
		/* format 32 in Xlib is an array of long, but text targets are always 8-bit. */
		*len = items * (unsigned long)(format == 32 ? sizeof(long) : (unsigned long)format / 8);
		*out = malloc(*len);
		if (*out) {
			memcpy(*out, data, *len);
		} else {
			*len = 0;
			ok = false;
		}
	}
	if (data)
		XFree(data);
	return ok;
}

static bool write_all(const unsigned char *buf, unsigned long len)
{
	return len == 0 || fwrite(buf, 1, len, stdout) == len;
}

int main(int argc, char **argv)
{
	const char *display_name = NULL;
	const char *selection_name = "CLIPBOARD";
	long timeout_ms = 2000;
	bool trace = false;

	for (int i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--display") == 0 && i + 1 < argc) {
			display_name = argv[++i];
		} else if (strcmp(argv[i], "--timeout-ms") == 0 && i + 1 < argc) {
			timeout_ms = atol(argv[++i]);
		} else if (strcmp(argv[i], "--selection") == 0 && i + 1 < argc) {
			selection_name = argv[++i];
		} else if (strcmp(argv[i], "--trace") == 0) {
			trace = true;
		} else {
			fprintf(stderr, "gs-clip: unknown argument %s\n", argv[i]);
			fprintf(stderr, "usage: gs-clip [--display :0] [--timeout-ms 2000] [--selection CLIPBOARD|PRIMARY] [--trace]\n");
			return 2;
		}
	}
	if (timeout_ms < 1 || timeout_ms > 60000) {
		fprintf(stderr, "gs-clip: --timeout-ms outside 1..60000: %ld\n", timeout_ms);
		return 2;
	}

	Display *dpy = XOpenDisplay(display_name);
	if (!dpy) {
		const char *name = display_name ? display_name : getenv("DISPLAY");
		fprintf(stderr, "gs-clip: cannot open display %s\n", name ? name : "(DISPLAY is not set)");
		return 2;
	}
	XSetErrorHandler(on_error);

	const long deadline = now_ms() + timeout_ms;
	const Atom selection = XInternAtom(dpy, selection_name, False);
	const Atom utf8 = XInternAtom(dpy, "UTF8_STRING", False);
	const Atom incr = XInternAtom(dpy, "INCR", False);
	const Atom prop = XInternAtom(dpy, "GS_CLIP", False);

	if (XGetSelectionOwner(dpy, selection) == None) {
		fprintf(stderr, "gs-clip: %s has no owner — nothing was copied\n", selection_name);
		XCloseDisplay(dpy);
		return 1;
	}

	/* The window is never shown: it is only an address for the answer.
	 * PropertyChangeMask is set before the request: otherwise the first INCR chunk can
	 * arrive before we subscribe to it. */
	Window win = XCreateSimpleWindow(dpy, DefaultRootWindow(dpy), 0, 0, 1, 1, 0, 0, 0);
	XSelectInput(dpy, win, PropertyChangeMask);

	const Atom targets[] = { utf8, XA_STRING };
	const struct selection_wait sw = { win, selection };
	XEvent ev;
	bool converted = false;

	for (size_t t = 0; t < sizeof targets / sizeof targets[0] && !converted; t++) {
		XConvertSelection(dpy, selection, targets[t], prop, win, CurrentTime);
		XFlush(dpy);
		if (!wait_event(dpy, &ev, deadline, is_selection_notify, &sw)) {
			fprintf(stderr, "gs-clip: owner of %s did not answer in %ld ms\n", selection_name, timeout_ms);
			XCloseDisplay(dpy);
			return 3;
		}
		/* property == None — the owner does not know this target; try the next one. */
		converted = ev.xselection.property != None;
	}
	if (!converted) {
		fprintf(stderr, "gs-clip: owner of %s refused both UTF8_STRING and STRING\n", selection_name);
		XCloseDisplay(dpy);
		return 1;
	}

	unsigned char *buf = NULL;
	unsigned long len = 0;
	Atom type = None;
	int rc = 0;

	if (!take_property(dpy, win, prop, &type, &buf, &len)) {
		fprintf(stderr, "gs-clip: could not read the %s answer\n", selection_name);
		rc = 4;
	} else if (type != incr) {
		if (!write_all(buf, len))
			rc = 4;
		free(buf);
	} else {
		/* INCR: the read above already deleted the property — that means "start". Then each
		 * chunk arrives as a new property value, an empty chunk is the end. */
		free(buf);
		const struct property_wait pw = { win, prop };
		unsigned long chunks = 0, total = 0;
		for (;;) {
			if (!wait_event(dpy, &ev, deadline, is_new_value, &pw)) {
				fprintf(stderr, "gs-clip: INCR transfer of %s stalled after %ld ms\n", selection_name, timeout_ms);
				rc = 3;
				break;
			}
			if (!take_property(dpy, win, prop, &type, &buf, &len)) {
				fprintf(stderr, "gs-clip: INCR chunk %lu of %s could not be read\n", chunks + 1, selection_name);
				rc = 4;
				break;
			}
			if (len == 0) {
				free(buf);
				if (trace)
					fprintf(stderr, "gs-clip: INCR transfer, %lu chunks, %lu bytes\n", chunks, total);
				break;
			}
			chunks++;
			total += len;
			const bool ok = write_all(buf, len);
			free(buf);
			if (!ok) {
				rc = 4;
				break;
			}
		}
	}

	if (fflush(stdout) != 0)
		rc = 4;
	XDestroyWindow(dpy, win);
	XCloseDisplay(dpy);
	return rc;
}
