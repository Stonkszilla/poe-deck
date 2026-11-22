/*
 * gs-pointer — координаты указателя X-сервера строками в stdout.
 *
 * Замер [#92] нашёл аналоговый канал панели: курсор от левого тачпада
 * живёт на сервере ИГРЫ (`:1`) — 270 движений за 30 с, X 0..967, Y 0..799, —
 * тогда как на сессионном `:0` он всё это время стоял в углу (ADR 0002, Ф11).
 * Значит рисуем по-прежнему на своём сервере, а координаты берём с чужого.
 *
 * ── Почему отдельный бинарь, а не флаг у gs-panel ───────────────────────────
 *
 * Форма взята у `gs-hotkey-probe`: маленький C-клиент читает то, чего не может
 * bun, и печатает строки, которые разбирает демон. Рендерер при этом остаётся
 * с односторонним швом ADR 0003 (`rect`, `text`, `show` внутрь, ничего наружу),
 * и соединение к чужому серверу не примешивается к рисованию на своём.
 *
 * ── Что здесь намеренно не делается ─────────────────────────────────────────
 *
 *  - **никакого XTEST и синтетического ввода**: мы читаем, а не двигаем. Синтез
 *    до игры всё равно не доходит (ADR 0002, Ф6);
 *  - **никакого захвата** (`XGrabPointer`): указатель принадлежит игре, отбирать
 *    его нельзя — иначе сломается сама игра;
 *  - **никакой подписки на события**: `XQueryPointer` спрашивает состояние, и
 *    ему не нужны ни фокус, ни доставка событий в наше окно. Ровно поэтому
 *    инвариант «ввод из слоя оверлея не приходит никогда» остаётся в силе.
 *
 * Вывод — только ИЗМЕНЕНИЯ позиции:
 *
 *   pointer <x> <y> <mask>
 *
 * Неподвижный палец не должен заливать журнал демона десятками строк в секунду.
 *
 *   gs-pointer [--display :1] [--hz 60] [--seconds 0] [--once]
 *
 * `--seconds 0` — жить, пока не убьют (рантайм). Коды выхода: 2 — сервер не
 * открылся, 3 — соединение оборвалось на ходу. Оба — деградация со словами, а
 * не стектрейс: демон обязан пережить исчезновение сервера игры.
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
	printf("✗  соединение с сервером оборвалось — игра закрылась или сервер ушёл\n");
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
			printf("✗  не знаю аргумент %s\n", argv[i]);
			printf("   gs-pointer [--display :1] [--hz 60] [--seconds 0] [--once]\n");
			return 2;
		}
	}

	if (hz < 1 || hz > 500) {
		printf("✗  --hz вне 1..500: %d\n", hz);
		return 2;
	}

	/* Умолчание — переменная окружения, как у любого X-клиента. Сервер игры
	 * подставляется вызывающим: он знает, где курсор (замер #92). */
	Display *dpy = XOpenDisplay(display_name);
	if (!dpy) {
		printf("✗  сервер %s не открылся\n", display_name ? display_name : (getenv("DISPLAY") ? getenv("DISPLAY") : "(DISPLAY не задан)"));
		printf("   у сервера игры может быть свой Xauthority — это не поломка зонда\n");
		return 2;
	}
	XSetIOErrorHandler(on_io_error);

	Window root = DefaultRootWindow(dpy);
	printf("✓  указатель %s: экран %dx%d, опрос %d Гц\n",
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

		/* False — указатель на другом экране того же сервера. У Deck экран
		 * один, но молчать об этом нельзя: молчание неотличимо от «стоит». */
		if (!XQueryPointer(dpy, root, &root_ret, &child_ret, &rx, &ry, &wx, &wy, &mask)) {
			printf("⚠  указатель на другом экране — координат нет\n");
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
