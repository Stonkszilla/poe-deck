/*
 * gs-clip — содержимое X11 CLIPBOARD в stdout.
 *
 * До него буфер читался `xclip` внутри distrobox `gs-probe`: на
 * стоковой SteamOS xclip нет, а контейнера и тулчейна у игрока нет тем более.
 * Этот бинарь — та же форма, что у `gs-pointer`: маленький Xlib-клиент читает
 * то, чего не может bun, и отдаёт демону байты. Собирается тем же `build.sh`
 * и линкуется только с libX11 — она есть на стоковом rootfs.
 *
 * Читается ровно то, что читал xclip: `xclip -o -selection clipboard`, то есть
 * цель UTF8_STRING с откатом на STRING. Игра под Proton отдаёт UTF8_STRING;
 * откат нужен на случай владельца, который знает только Latin-1.
 *
 * ── Что здесь намеренно не делается ─────────────────────────────────────────
 *
 *  - **никакого владения селекшеном**: мы только просим копию. Владеть буфером
 *    значит жить, пока буфер нужен, — на этом xclip уже подводил на Deck
 *    (tools/probe-deck-input.sh, прогон #52);
 *  - **никакого ожидания смены**: один запрос — один ответ. Свежесть буфера
 *    решает демон (`clipboardAfterTrigger` в src/slice.ts), он и зовёт нас
 *    повторно.
 *
 * Большой буфер владелец отдаёт по протоколу INCR кусками — он поддержан: текст
 * предмета короток, но читалка, молча обрезающая длинный буфер, хуже никакой.
 *
 *   gs-clip [--display :0] [--timeout-ms 2000] [--selection CLIPBOARD|PRIMARY] [--trace]
 *
 * `--trace` называет в stderr передачу кусками — для проверки, что INCR
 * действительно был, а не только что байты сошлись.
 *
 * Коды выхода: 0 — байты в stdout (пустой буфер — тоже 0 и пустой вывод);
 * 1 — у селекшена нет владельца или владелец отказал; 2 — сервер не открылся
 * или аргументы не разобраны; 3 — владелец не ответил за отведённое время;
 * 4 — ответ пришёл, но не прочитался (отказ XGetWindowProperty или памяти)
 * или не записался в stdout.
 * Причина каждого ненулевого кода — одной строкой в stderr.
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

/* Ошибки протокола (BadWindow у умершего владельца и т. п.) не должны убивать
 * процесс стандартным обработчиком Xlib: исход и так виден по ответу. */
static int on_error(Display *dpy, XErrorEvent *ev)
{
	(void)dpy;
	(void)ev;
	return 0;
}

/*
 * Ждёт событие, для которого `match` вернёт true, но не дольше `deadline`.
 * Опрос сокета, а не голый XNextEvent: тот висит вечно, если владелец молчит, —
 * ровно та грабля, из-за которой xclip в демоне был обёрнут в `timeout`.
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

/* Читает свойство целиком и удаляет его — удаление и есть сигнал владельцу
 * INCR «давай следующий кусок». Тип свойства — в `type`, байты — в `out`.
 *
 * false — свойство не прочиталось или байты некуда положить. Это отдельный
 * исход, а не пустой буфер: иначе сбой выглядел бы как «скопировано пусто», а
 * посреди INCR — как штатный конец передачи, и вывод молча обрезался бы. */
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
		/* format 32 у Xlib — массив long, но текстовые цели всегда 8-битные. */
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

	/* Окно не показывается никогда: оно нужно только как адрес для ответа.
	 * PropertyChangeMask — заранее, до запроса: иначе первый кусок INCR может
	 * прийти раньше, чем мы на него подписались. */
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
		/* property == None — владелец этой цели не знает; пробуем следующую. */
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
		/* INCR: свойство уже удалено чтением выше — это «начинай». Дальше каждый
		 * кусок приходит новым значением свойства, пустой кусок — конец. */
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
