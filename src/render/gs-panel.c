/*
 * gs-panel — the overlay layer renderer of poe-deck.
 *
 * Reads a stream of draw commands from stdin and puts them into an RGBA window over the game.
 * This is the "small C helper on Xlib/Xft" from ADR 0001, Decision 3, and
 * the seam between it and the bun daemon is exactly this stream: one-way, text,
 * with no back channel. The renderer knows nothing about items or the trade API.
 *
 * Lineage: the X11 skeleton (connection, layer atom, event queue handling, tick)
 * is taken from docs/spikes/gamescope-overlay/gs-overlay-probe.c, which proved on a live Deck
 * that a window with GAMESCOPE_EXTERNAL_OVERLAY gets a layer over the game.
 * That probe stays an artifact of the closed overlay spike and is not touched; this is
 * the tool that lives on.
 *
 * Three commands, one per line. The price check panel did not need more:
 *
 *   rect X Y W H RRGGBBAA          fill a rectangle
 *   text X Y WRAP RRGGBBAA PX ...  a line of text; WRAP=0 — no wrapping,
 *                                  otherwise word wrap to a width of WRAP pixels
 *   show                           end of frame: show what was collected
 *
 * Coordinates are absolute, in output pixels: by F3 of the spike, gamescope stretches
 * the external overlay window over the whole output whatever geometry is requested, so
 * we have no "window", we have the screen. Color is RRGGBBAA, alpha NOT premultiplied: the
 * renderer multiplies, because the compositor needs a premultiplied buffer, and the author
 * of the commands does not need to know about it.
 *
 * All that rect commands do not cover stays fully transparent — otherwise the panel
 * would cover the whole game.
 *
 * A frame is shown on an event: as soon as `show` comes from the seam, the screen
 * updates. This is the working path (ADR 0003, Decision 3) — the item price does not
 * change between button presses, and there is no reason to redraw it on a timer.
 *
 * Run modes:
 *   --seconds N   how long to keep the window (default 30, 0 = until killed:
 *                 this is how the renderer lives under the daemon for the whole game session)
 *   --hz N        MEASUREMENT mode: redraw N times per second and measure
 *                 the cost of a frame. Showing the picture does not need it (0 = only on an event)
 *   --selfcheck   before exit, read back our own pixels and print facts
 *                 about the frame: how many are opaque, where they are, how many distinct
 *                 values. By them check.sh judges the panel without a human and without
 *                 comparing pictures.
 *   --fonts       print what fontconfig resolved "sans" to, and exit.
 *                 The answer to "which font is there at all on stock SteamOS".
 *
 * Build — src/render/build.sh (one recipe for check.sh and for Jenkins).
 */

#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/Xft/Xft.h>
#include <fontconfig/fontconfig.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/select.h>
#include <time.h>
#include <unistd.h>

#define MAX_OPS    256    /* commands per frame: the price check panel needs only a few */
#define MAX_TEXT   512    /* bytes in one line of text */
#define MAX_FONTS  8      /* distinct font sizes at the same time */
#define MAX_FRAMES 100000 /* how many frame measurements we keep for the statistics */

enum op_kind { OP_RECT, OP_TEXT };

struct op {
	enum op_kind kind;
	int x, y, w, h;      /* for OP_TEXT w is the wrap width (0 = none), h is not used */
	uint32_t rgba;
	int px;
	char text[MAX_TEXT];
};

struct frame {
	struct op ops[MAX_OPS];
	int n;
	int overflow;        /* more than MAX_OPS commands came — the frame is incomplete, and we must say so */
	int checked;         /* glyphs of this frame are already checked: at 10 Hz we would otherwise complain 10 times per second */
};

/* All draw state in one place: X connection, frame buffer, font cache. */
struct renderer {
	Display *dpy;
	int screen;
	Window win;
	Visual *visual;
	Colormap cmap;
	Pixmap buf;          /* double buffering: we build the frame here, then copy it whole */
	GC gc;
	XftDraw *draw;
	int w, h;
	struct { int px; XftFont *font; } fonts[MAX_FONTS];
	int nfonts;
};

static double now_ms(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

/* RRGGBBAA (not premultiplied) → XRenderColor (premultiplied, 16 bits per channel).
 *
 * Premultiplication here is not cosmetic: both Xft and XCopyArea put into the buffer exactly the
 * bits we gave, and gamescope composites the buffer as premultiplied. To give
 * 80FFFFFF without multiplication is to get an overexposed panel on the screen, and the
 * more transparent the request, the worse it gets. */
static XRenderColor to_render_color(uint32_t rgba)
{
	unsigned r = (rgba >> 24) & 0xFF, g = (rgba >> 16) & 0xFF;
	unsigned b = (rgba >> 8) & 0xFF,  a = rgba & 0xFF;
	XRenderColor c = {
		.red   = (unsigned short)(r * a * 257 / 255),
		.green = (unsigned short)(g * a * 257 / 255),
		.blue  = (unsigned short)(b * a * 257 / 255),
		.alpha = (unsigned short)(a * 257),
	};
	return c;
}

/* The same, but as a ready 32-bit pixel value for XFillRectangle:
 * the GC writes raw bits, there is no conversion from XRenderColor on this path. */
static unsigned long to_pixel(uint32_t rgba)
{
	unsigned r = (rgba >> 24) & 0xFF, g = (rgba >> 16) & 0xFF;
	unsigned b = (rgba >> 8) & 0xFF,  a = rgba & 0xFF;
	return ((unsigned long)a << 24) | ((r * a / 255) << 16)
	     | ((g * a / 255) << 8) | (b * a / 255);
}

/* A font by size in PIXELS, not in points. Xft converts points through the DPI
 * of the X server, and under gamescope Xwayland has a nominal one — the size would drift
 * with it. On a 7" 1280×800 screen, pixels decide readability, and the author of the commands sets them. */
static XftFont *font_for(struct renderer *r, int px)
{
	for (int i = 0; i < r->nfonts; i++)
		if (r->fonts[i].px == px)
			return r->fonts[i].font;

	char pattern[64];
	snprintf(pattern, sizeof pattern, "sans:pixelsize=%d", px);
	XftFont *f = XftFontOpenName(r->dpy, r->screen, pattern);
	if (!f)
		return NULL;

	if (r->nfonts < MAX_FONTS) {
		r->fonts[r->nfonts].px = px;
		r->fonts[r->nfonts].font = f;
		r->nfonts++;
	}
	return f;
}

/* Parse one UTF-8 sequence. Returns the length in bytes and puts the code
 * point into *cp. Garbage — one byte as is, only so that we do not loop. */
static int utf8_next(const char *s, uint32_t *cp)
{
	unsigned char c = (unsigned char)s[0];
	if (c < 0x80)                       { *cp = c;          return 1; }
	if ((c & 0xE0) == 0xC0 && s[1])     { *cp = ((c & 0x1Fu) << 6) | (s[1] & 0x3F); return 2; }
	if ((c & 0xF0) == 0xE0 && s[1] && s[2]) {
		*cp = ((c & 0x0Fu) << 12) | ((s[1] & 0x3F) << 6) | (s[2] & 0x3F);
		return 3;
	}
	if ((c & 0xF8) == 0xF0 && s[1] && s[2] && s[3]) {
		*cp = ((c & 0x07u) << 18) | ((s[1] & 0x3F) << 12)
		    | ((s[2] & 0x3F) << 6) | (s[3] & 0x3F);
		return 4;
	}
	*cp = c;
	return 1;
}

/* Name the characters that the font does not have.
 *
 * Xft does NOT substitute fonts: a missing glyph goes to the screen as an empty
 * box and looks like "the panel was drawn". Caught on a live Deck
 * (run #68): Noto Sans on stock SteamOS has no "≈", and it came out as tofu.
 * Silently this is caught only by eye, so it goes to stderr.
 *
 * We ask FcCharSet, not XftCharExists: in the measurement (the same run,
 * analysis on mini) the latter answered "present" for everything and is not a check. */
static void warn_missing_glyphs(struct renderer *r, XftFont *f, const char *s)
{
	(void)r;
	FcCharSet *cs = NULL;
	if (FcPatternGetCharSet(f->pattern, FC_CHARSET, 0, &cs) != FcResultMatch || !cs)
		return;

	char missing[128];
	int n = 0;
	for (const char *p = s; *p && n < (int)sizeof missing - 12; ) {
		uint32_t cp = 0;
		p += utf8_next(p, &cp);
		if (cp < 0x20 || FcCharSetHasChar(cs, cp))
			continue;
		n += snprintf(missing + n, sizeof missing - n, "U+%04X ", cp);
	}
	if (n)
		fprintf(stderr, "missing glyphs in the font, the screen will show empty boxes: %s"
		                "(line \"%s\")\n", missing, s);
}

static int text_width(struct renderer *r, XftFont *f, const char *s, int len)
{
	XGlyphInfo gi;
	XftTextExtentsUtf8(r->dpy, f, (const FcChar8 *)s, len, &gi);
	return gi.xOff;
}

/* One line with word wrap. Returns y of the next line.
 *
 * The renderer computes the wrap, not the daemon, and this is not arbitrary: only the one
 * that has the font open knows the line width. The metrics must not go back over the seam —
 * the seam is one-way by ADR 0001. */
static int draw_wrapped(struct renderer *r, XftFont *f, XftColor *color,
                        int x, int y, int wrap, const char *s)
{
	int len = (int)strlen(s);
	int line_h = f->ascent + f->descent;

	if (wrap <= 0 || text_width(r, f, s, len) <= wrap) {
		XftDrawStringUtf8(r->draw, color, f, x, y + f->ascent,
		                  (const FcChar8 *)s, len);
		return y + line_h;
	}

	int start = 0;
	while (start < len) {
		int fit = start, last_space = -1;
		/* Extend while it fits; remember the last space as the break point. */
		while (fit < len) {
			int next = fit + 1;
			if (text_width(r, f, s + start, next - start) > wrap)
				break;
			if (s[fit] == ' ')
				last_space = fit;
			fit = next;
		}
		int end = fit;
		if (fit < len && last_space > start)
			end = last_space;
		/* A word longer than the line does not loop: cut it as is, but not at zero. */
		if (end == start)
			end = start + 1;

		XftDrawStringUtf8(r->draw, color, f, x, y + f->ascent,
		                  (const FcChar8 *)(s + start), end - start);
		y += line_h;

		start = end;
		while (start < len && s[start] == ' ')
			start++;
	}
	return y;
}

/* Build the frame in the buffer and show it whole. There are no intermediate states on the
 * screen: the transparent fill and the drawing go to a Pixmap, one XCopyArea goes out. */
static void render(struct renderer *r, struct frame *fr)
{
	XSetForeground(r->dpy, r->gc, 0x00000000);
	XFillRectangle(r->dpy, r->buf, r->gc, 0, 0, r->w, r->h);

	for (int i = 0; i < fr->n; i++) {
		const struct op *op = &fr->ops[i];
		if (op->kind == OP_RECT) {
			XSetForeground(r->dpy, r->gc, to_pixel(op->rgba));
			XFillRectangle(r->dpy, r->buf, r->gc, op->x, op->y, op->w, op->h);
			continue;
		}

		XftFont *f = font_for(r, op->px);
		if (!f)
			continue;
		if (!fr->checked)
			warn_missing_glyphs(r, f, op->text);
		XRenderColor rc = to_render_color(op->rgba);
		XftColor color;
		if (!XftColorAllocValue(r->dpy, r->visual, r->cmap, &rc, &color))
			continue;
		draw_wrapped(r, f, &color, op->x, op->y, op->w, op->text);
		XftColorFree(r->dpy, r->visual, r->cmap, &color);
	}

	fr->checked = 1;
	XCopyArea(r->dpy, r->buf, r->win, r->gc, 0, 0, r->w, r->h, 0, 0);
}

/* Parse one command line. Returns: 0 — command accepted, 1 — it is `show`,
 * -1 — the line is not understood (we report it and continue: to swallow garbage from the seam silently
 * means to search later for a lost panel in the void). */
static int parse_line(char *line, struct frame *fr)
{
	while (*line == ' ' || *line == '\t')
		line++;
	if (!*line || *line == '#')
		return 0;

	if (!strcmp(line, "show"))
		return 1;

	struct op op = { 0 };
	unsigned rgba = 0;
	int consumed = 0;

	if (sscanf(line, "rect %d %d %d %d %8x", &op.x, &op.y, &op.w, &op.h, &rgba) == 5) {
		op.kind = OP_RECT;
	} else if (sscanf(line, "text %d %d %d %8x %d %n",
	                  &op.x, &op.y, &op.w, &rgba, &op.px, &consumed) == 5 && consumed > 0) {
		op.kind = OP_TEXT;
		if (op.px <= 0) {
			fprintf(stderr, "font size must be greater than zero: %s\n", line);
			return -1;
		}
		snprintf(op.text, sizeof op.text, "%s", line + consumed);
	} else {
		fprintf(stderr, "cannot parse command: %s\n", line);
		return -1;
	}

	op.rgba = rgba;
	if (fr->n >= MAX_OPS) {
		fr->overflow = 1;
		return -1;
	}
	fr->ops[fr->n++] = op;
	return 0;
}

/* Read what already came to stdin, without blocking. Returns 0 = the stream ended.
 *
 * `dirty` is set on each finished frame: by ADR 0003, Decision 3 the daemon
 * draws ON AN EVENT, not at a rate, and without this flag the second frame from the daemon
 * (the price after "looking up price...") would never reach the screen at --hz 0. */
static int drain_stdin(struct frame *next, struct frame *shown, int *has_frame, int *dirty)
{
	static char buf[8192];
	static int len = 0;

	/* A line longer than the buffer would mean a read() of zero size, and that looks the same
	 * as the end of the stream — the overlay would silently go out. We cut the line and say so. */
	if (len >= (int)sizeof buf - 1) {
		fprintf(stderr, "line longer than %zu bytes, dropped\n", sizeof buf);
		len = 0;
	}

	ssize_t got = read(STDIN_FILENO, buf + len, sizeof buf - len - 1);
	if (got <= 0)
		return 0;
	len += (int)got;
	buf[len] = 0;

	char *start = buf, *nl;
	while ((nl = strchr(start, '\n'))) {
		*nl = 0;
		if (parse_line(start, next) == 1) {
			*shown = *next;
			*has_frame = 1;
			*dirty = 1;
			memset(next, 0, sizeof *next);
		}
		start = nl + 1;
	}
	len = (int)strlen(start);
	memmove(buf, start, len + 1);
	return 1;
}

/* Read our own window and print facts about the frame.
 *
 * The point is to check without eyes: check.sh on Xvfb and the run on the Deck judge by
 * the same four numbers. A panel without text and a panel with text differ
 * by the number of distinct pixel values (antialiasing gives tens of levels),
 * and "the panel did not cover the game" by the share of transparent ones. */
static int cmp_u32(const void *a, const void *b)
{
	uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
	return (x > y) - (x < y);
}

static void selfcheck(struct renderer *r)
{
	XImage *img = XGetImage(r->dpy, r->win, 0, 0, r->w, r->h, AllPlanes, ZPixmap);
	if (!img) {
		printf("selfcheck: cannot read the window\n");
		return;
	}

	long total = (long)r->w * r->h, opaque = 0;
	int minx = r->w, miny = r->h, maxx = -1, maxy = -1;
	uint32_t *vals = malloc((size_t)total * sizeof *vals);
	long nvals = 0;

	for (int y = 0; y < r->h; y++) {
		for (int x = 0; x < r->w; x++) {
			uint32_t p = (uint32_t)XGetPixel(img, x, y);
			if (vals)
				vals[nvals++] = p;
			if ((p >> 24) == 0)
				continue;
			opaque++;
			if (x < minx) minx = x;
			if (y < miny) miny = y;
			if (x > maxx) maxx = x;
			if (y > maxy) maxy = y;
		}
	}

	long distinct = 0;
	if (vals) {
		qsort(vals, (size_t)nvals, sizeof *vals, cmp_u32);
		for (long i = 0; i < nvals; i++)
			if (i == 0 || vals[i] != vals[i - 1])
				distinct++;
		free(vals);
	}

	printf("selfcheck: total %ld, opaque %ld, transparent %ld\n",
	       total, opaque, total - opaque);
	if (maxx >= 0)
		printf("selfcheck: opaque bbox %d,%d %dx%d\n",
		       minx, miny, maxx - minx + 1, maxy - miny + 1);
	else
		printf("selfcheck: opaque bbox empty\n");
	printf("selfcheck: distinct pixel values %ld\n", distinct);
	printf("selfcheck: pixel 0,0 = %08x\n", (uint32_t)XGetPixel(img, 0, 0));
	XDestroyImage(img);
}

/* What fontconfig resolved "sans" to on this machine. On stock SteamOS the answer
 * is not known in advance, and the readability of the panel depends on it, so we print the fact. */
static void report_font(struct renderer *r, int px)
{
	XftFont *f = font_for(r, px);
	if (!f) {
		printf("font: sans:pixelsize=%d did NOT open\n", px);
		return;
	}
	FcChar8 *file = NULL, *family = NULL;
	FcPatternGetString(f->pattern, FC_FILE, 0, &file);
	FcPatternGetString(f->pattern, FC_FAMILY, 0, &family);
	printf("font: sans:pixelsize=%d → %s (%s), line height %d px (ascent %d, descent %d)\n",
	       px, family ? (const char *)family : "?",
	       file ? (const char *)file : "file not named",
	       f->ascent + f->descent, f->ascent, f->descent);
}

static double percentile(double *sorted, int n, double p)
{
	if (n <= 0)
		return 0;
	int i = (int)(p * (n - 1));
	return sorted[i];
}

static int cmp_double(const void *a, const void *b)
{
	double x = *(const double *)a, y = *(const double *)b;
	return (x > y) - (x < y);
}

int main(int argc, char **argv)
{
	int seconds = 30, hz = 0, want_selfcheck = 0, fonts_only = 0;

	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "--seconds") && i + 1 < argc)
			seconds = atoi(argv[++i]);
		else if (!strcmp(argv[i], "--hz") && i + 1 < argc)
			hz = atoi(argv[++i]);
		else if (!strcmp(argv[i], "--selfcheck"))
			want_selfcheck = 1;
		else if (!strcmp(argv[i], "--fonts"))
			fonts_only = 1;
		else {
			fprintf(stderr, "usage: %s [--seconds N] [--hz N] "
			                "[--selfcheck] [--fonts]\n", argv[0]);
			return 2;
		}
	}

	Display *dpy = XOpenDisplay(NULL);
	if (!dpy) {
		const char *d = getenv("DISPLAY");
		fprintf(stderr, "cannot open DISPLAY=%s\n", d ? d : "(not set)");
		return 3;
	}

	struct renderer r = { .dpy = dpy, .screen = DefaultScreen(dpy) };
	r.w = DisplayWidth(dpy, r.screen);
	r.h = DisplayHeight(dpy, r.screen);

	/* A 32-bit TrueColor visual is the reason this program cannot be
	 * XCreateSimpleWindow, as the spike probe is: the default visual has no alpha,
	 * and no atoms can give a transparent background on it. */
	XVisualInfo vi;
	if (!XMatchVisualInfo(dpy, r.screen, 32, TrueColor, &vi)) {
		fprintf(stderr, "no 32-bit TrueColor visual, a transparent overlay is impossible\n");
		return 4;
	}
	r.visual = vi.visual;
	r.cmap = XCreateColormap(dpy, RootWindow(dpy, r.screen), r.visual, AllocNone);

	if (fonts_only) {
		/* A font does not need an X window, and on the Deck this mode also runs outside Game Mode. */
		printf("output %dx%d, 32-bit visual present\n", r.w, r.h);
		for (int px = 16; px <= 28; px += 4)
			report_font(&r, px);
		XCloseDisplay(dpy);
		return 0;
	}

	XSetWindowAttributes attrs = {
		.colormap = r.cmap,
		.border_pixel = 0,
		.background_pixel = 0,
		.event_mask = ExposureMask | StructureNotifyMask,
	};
	r.win = XCreateWindow(dpy, RootWindow(dpy, r.screen), 0, 0, r.w, r.h, 0,
	                      32, InputOutput, r.visual,
	                      CWColormap | CWBorderPixel | CWBackPixel | CWEventMask, &attrs);
	XStoreName(dpy, r.win, "gs-panel");

	/* The atom is set BEFORE XMapWindow: steamcompmgr reads it in map_win. The same
	 * order as in the spike probe, and for the same reason. */
	Atom overlay = XInternAtom(dpy, "GAMESCOPE_EXTERNAL_OVERLAY", False);
	uint32_t one = 1;
	XChangeProperty(dpy, r.win, overlay, XA_CARDINAL, 32, PropModeReplace,
	                (unsigned char *)&one, 1);

	r.buf = XCreatePixmap(dpy, r.win, r.w, r.h, 32);
	r.gc = XCreateGC(dpy, r.buf, 0, NULL);
	r.draw = XftDrawCreate(dpy, r.buf, r.visual, r.cmap);

	XMapWindow(dpy, r.win);
	XSync(dpy, False);
	printf("window 0x%lx, output %dx%d, GAMESCOPE_EXTERNAL_OVERLAY = 1\n", r.win, r.w, r.h);
	report_font(&r, 22);
	fflush(stdout);

	struct frame next = { 0 }, shown = { 0 };
	int has_frame = 0, stdin_open = 1, dirty = 0;
	double *times = malloc(MAX_FRAMES * sizeof *times);
	int nframes = 0;
	double start = now_ms();
	double next_draw = start;
	double interval = hz > 0 ? 1000.0 / hz : 0;

	for (;;) {
		double t = now_ms();
		/* seconds=0 — keep until killed: this is how the renderer lives under the daemon
		 * for the whole game session, and the daemon hides the panel with an empty frame. */
		if (seconds > 0 && t - start >= seconds * 1000.0)
			break;

		/* No events come from this layer (F2 of the spike), but the queue still
		 * must be drained: otherwise it grows, and an Expose stays unhandled
		 * where the server does send it. */
		while (XPending(dpy)) {
			XEvent ev;
			XNextEvent(dpy, &ev);
			if (ev.type == Expose && has_frame)
				render(&r, &shown);
		}

		if (stdin_open) {
			fd_set rfds;
			FD_ZERO(&rfds);
			FD_SET(STDIN_FILENO, &rfds);
			struct timeval zero = { 0, 0 };
			if (select(STDIN_FILENO + 1, &rfds, NULL, NULL, &zero) > 0
			    && !drain_stdin(&next, &shown, &has_frame, &dirty)) {
				stdin_open = 0;
				/* The stream ended without `show` — we take what was collected as a frame,
				 * otherwise a one-shot pipe from a shell would draw nothing. */
				if (!has_frame && next.n) {
					shown = next;
					has_frame = 1;
					dirty = 1;
				}
			}
		}

		/* We draw on an event (a new frame from the seam) — the working path by ADR 0003,
		 * Decision 3. `--hz` on top of it stays a measurement mode: it
		 * redraws the same thing for the statistics, not for the picture.
		 * The cost measurement is these times[]: each entry is a full cycle of building
		 * the frame up to XSync, that is, what the Deck pays for. */
		if (has_frame && (dirty || nframes == 0 || (hz > 0 && now_ms() >= next_draw))) {
			double d0 = now_ms();
			render(&r, &shown);
			XSync(dpy, False);
			dirty = 0;
			if (nframes < MAX_FRAMES)
				times[nframes++] = now_ms() - d0;
			next_draw = d0 + interval;
		}

		usleep(1000);
	}

	if (next.overflow)
		printf("⚠  more than %d commands in the frame, the frame is shown incomplete\n", MAX_OPS);
	if (!has_frame)
		printf("⚠  no frame on stdin, nothing to draw\n");

	double elapsed = (now_ms() - start) / 1000.0;
	printf("\nredraws: %d in %.1f s (requested %d Hz, got %.1f)\n",
	       nframes, elapsed, hz, nframes / (elapsed > 0 ? elapsed : 1));
	if (nframes > 0) {
		double sum = 0, max = 0;
		for (int i = 0; i < nframes; i++) {
			sum += times[i];
			if (times[i] > max)
				max = times[i];
		}
		qsort(times, (size_t)nframes, sizeof *times, cmp_double);
		printf("frame: mean %.2f ms, median %.2f ms, 95th percentile %.2f ms, max %.2f ms\n",
		       sum / nframes, percentile(times, nframes, 0.5),
		       percentile(times, nframes, 0.95), max);
	}

	struct rusage ru;
	if (!getrusage(RUSAGE_SELF, &ru)) {
		double cpu = ru.ru_utime.tv_sec + ru.ru_utime.tv_usec / 1e6
		           + ru.ru_stime.tv_sec + ru.ru_stime.tv_usec / 1e6;
		printf("process CPU: %.2f s in %.1f s of run, %.1f%% of one core\n",
		       cpu, elapsed, elapsed > 0 ? 100.0 * cpu / elapsed : 0);
	}

	if (want_selfcheck)
		selfcheck(&r);

	free(times);
	XftDrawDestroy(r.draw);
	XFreeGC(dpy, r.gc);
	XFreePixmap(dpy, r.buf);
	XDestroyWindow(dpy, r.win);
	XCloseDisplay(dpy);
	printf("window removed\n");
	return 0;
}
