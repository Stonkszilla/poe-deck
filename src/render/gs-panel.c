/*
 * gs-panel — рендерер слоя оверлея poe-deck.
 *
 * Читает со stdin поток команд отрисовки и кладёт их в RGBA-окно поверх игры.
 * Это тот самый «маленький C-хелпер поверх Xlib/Xft» из ADR 0001, Решение 3, и
 * шов между ним и демоном на bun — ровно этот поток: однонаправленный, текстовый,
 * без обратного канала. Рендерер ничего не знает ни про предметы, ни про trade API.
 *
 * Родословная: X11-скелет (подключение, атом слоя, разбор очереди событий, тик)
 * взят у docs/spikes/gamescope-overlay/gs-overlay-probe.c, который на живом Deck
 * доказал, что окно с GAMESCOPE_EXTERNAL_OVERLAY получает слой поверх игры.
 * Тот зонд остаётся артефактом закрытого спайка оверлея и не трогается; здесь —
 * инструмент, который живёт дальше.
 *
 * Три команды, по одной на строку. Больше в панель прайс-чека не понадобилось:
 *
 *   rect X Y W H RRGGBBAA          заливка прямоугольника
 *   text X Y WRAP RRGGBBAA PX ...  строка текста; WRAP=0 — без переносов,
 *                                  иначе перенос по словам в ширину WRAP пикселей
 *   show                           конец кадра: показать накопленное
 *
 * Координаты — абсолютные, в пикселях вывода: по Ф3 спайка gamescope растягивает
 * окно внешнего оверлея на весь вывод независимо от запрошенной геометрии, поэтому
 * «окна» у нас нет, есть экран. Цвет — RRGGBBAA, альфа НЕ предумноженная: умножает
 * рендерер, потому что композитору буфер нужен предумноженным, а автору команд про
 * это знать незачем.
 *
 * Всё, что не покрыто rect'ами, остаётся полностью прозрачным — иначе панель
 * закрыла бы игру целиком.
 *
 * Кадр показывается по событию: как только со шва пришёл `show`, экран
 * обновляется. Это рабочий путь (ADR 0003, Решение 3) — цена предмета между
 * нажатиями кнопки не меняется, и перерисовывать её по таймеру незачем.
 *
 * Режимы прогона:
 *   --seconds N   сколько держать окно (по умолчанию 30, 0 = пока не убьют:
 *                 так рендерер живёт под демоном всю игровую сессию)
 *   --hz N        ИЗМЕРИТЕЛЬНЫЙ режим: перерисовывать N раз в секунду и мерить
 *                 цену кадра. Показу картинки не нужен (0 = только по событию)
 *   --selfcheck   перед выходом прочитать свои же пиксели и напечатать факты
 *                 о кадре: сколько непрозрачных, где они, сколько различных
 *                 значений. По ним check.sh судит о панели без человека и без
 *                 сравнения картинок.
 *   --fonts       напечатать, во что фонтконфиг развернул «sans», и выйти.
 *                 Ответ на «какой шрифт вообще есть на стоковой SteamOS».
 *
 * Сборка — src/render/build.sh (один рецепт на check.sh и на Jenkins).
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

#define MAX_OPS    256    /* команд в кадре: панель прайс-чека укладывается в единицы */
#define MAX_TEXT   512    /* байт в одной строке текста */
#define MAX_FONTS  8      /* различных кеглей одновременно */
#define MAX_FRAMES 100000 /* сколько замеров кадра держим для статистики */

enum op_kind { OP_RECT, OP_TEXT };

struct op {
	enum op_kind kind;
	int x, y, w, h;      /* для OP_TEXT w — ширина переноса (0 = без), h не используется */
	uint32_t rgba;
	int px;
	char text[MAX_TEXT];
};

struct frame {
	struct op ops[MAX_OPS];
	int n;
	int overflow;        /* команд пришло больше MAX_OPS — кадр неполон, и об этом надо сказать */
	int checked;         /* глифы у этого кадра уже проверены: при 10 Гц иначе 10 жалоб в секунду */
};

/* Всё состояние отрисовки в одном месте: X-соединение, буфер кадра, кеш шрифтов. */
struct renderer {
	Display *dpy;
	int screen;
	Window win;
	Visual *visual;
	Colormap cmap;
	Pixmap buf;          /* двойная буферизация: собираем кадр здесь, потом копируем целиком */
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

/* RRGGBBAA (не предумноженная) → XRenderColor (предумноженная, 16 бит на канал).
 *
 * Предумножение здесь не косметика: и Xft, и XCopyArea кладут в буфер именно те
 * биты, что мы дали, а gamescope композитит буфер как предумноженный. Отдать
 * 80FFFFFF без умножения — получить на экране пересвеченную панель, причём тем
 * сильнее, чем прозрачнее просили. */
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

/* То же самое, но как готовое 32-битное значение пикселя для XFillRectangle:
 * GC пишет сырые биты, конверсии из XRenderColor в этом пути нет. */
static unsigned long to_pixel(uint32_t rgba)
{
	unsigned r = (rgba >> 24) & 0xFF, g = (rgba >> 16) & 0xFF;
	unsigned b = (rgba >> 8) & 0xFF,  a = rgba & 0xFF;
	return ((unsigned long)a << 24) | ((r * a / 255) << 16)
	     | ((g * a / 255) << 8) | (b * a / 255);
}

/* Шрифт по кеглю в ПИКСЕЛЯХ, а не в пунктах. Пункты Xft пересчитывает через DPI
 * X-сервера, а у Xwayland под gamescope он условный — кегль поехал бы вместе с
 * ним. На 7" 1280×800 читаемость решается пикселями, и задаёт их автор команд. */
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

/* Разобрать одну UTF-8 последовательность. Возвращает длину в байтах, кодовую
 * точку кладёт в *cp. Мусор — один байт как есть, лишь бы не зациклиться. */
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

/* Назвать символы, которых в шрифте нет.
 *
 * Xft подмену шрифта НЕ делает: отсутствующий глиф уходит на экран пустым
 * квадратом и выглядит как «панель нарисовалась». Поймано на живом Deck
 * (прогон #68): «≈» в Noto Sans стоковой SteamOS отсутствует и приехало тофу.
 * Молча такое ловится только глазами, поэтому — в stderr.
 *
 * Спрашиваем FcCharSet, а не XftCharExists: последний в замере (тот же прогон,
 * разбор на mini) отвечал «есть» вообще на всё и такой проверкой не является. */
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
		fprintf(stderr, "нет глифов в шрифте, на экране будут пустые квадраты: %s"
		                "(строка «%s»)\n", missing, s);
}

static int text_width(struct renderer *r, XftFont *f, const char *s, int len)
{
	XGlyphInfo gi;
	XftTextExtentsUtf8(r->dpy, f, (const FcChar8 *)s, len, &gi);
	return gi.xOff;
}

/* Одна строка с переносом по словам. Возвращает y следующей строки.
 *
 * Перенос считает рендерер, а не демон, и это не произвол: ширину строки знает
 * только тот, у кого открыт шрифт. Отдавать метрики обратно через шов нельзя —
 * шов однонаправленный по ADR 0001. */
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
		/* Тянем, пока влезает; помним последний пробел как точку разрыва. */
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
		/* Слово длиннее строки не зацикливает: режем как есть, но не на нуле. */
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

/* Собрать кадр в буфер и показать целиком. Промежуточных состояний на экране не
 * бывает: заливка прозрачным и отрисовка идут в Pixmap, наружу уходит один XCopyArea. */
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

/* Разбор одной строки команд. Возврат: 0 — команда принята, 1 — это `show`,
 * -1 — строка не понята (сообщаем и продолжаем: молча глотать мусор из шва
 * значит потом искать пропавшую панель в пустоте). */
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
			fprintf(stderr, "кегль должен быть больше нуля: %s\n", line);
			return -1;
		}
		snprintf(op.text, sizeof op.text, "%s", line + consumed);
	} else {
		fprintf(stderr, "не разобрал команду: %s\n", line);
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

/* Прочитать то, что уже пришло в stdin, не блокируясь. Возврат 0 = поток кончился.
 *
 * `dirty` взводится на каждом законченном кадре: по ADR 0003, Решение 3 демон
 * рисует ПО СОБЫТИЮ, а не по частоте, и без этого флага второй кадр от демона
 * (цена вслед за «ищу цену...») просто не попал бы на экран при --hz 0. */
static int drain_stdin(struct frame *next, struct frame *shown, int *has_frame, int *dirty)
{
	static char buf[8192];
	static int len = 0;

	/* Строка длиннее буфера означала бы read() нулевого размера, а это неотличимо
	 * от конца потока — оверлей молча погас бы. Режем строку и говорим об этом. */
	if (len >= (int)sizeof buf - 1) {
		fprintf(stderr, "строка длиннее %zu байт — отброшена\n", sizeof buf);
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

/* Прочитать собственное окно и напечатать факты о кадре.
 *
 * Смысл — проверяемость без глаз: check.sh на Xvfb и прогон на Deck судят по
 * одним и тем же четырём числам. Панель без текста и панель с текстом различаются
 * количеством различных значений пикселя (сглаживание даёт десятки градаций),
 * а «панель не закрыла игру» — долей прозрачных. */
static int cmp_u32(const void *a, const void *b)
{
	uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
	return (x > y) - (x < y);
}

static void selfcheck(struct renderer *r)
{
	XImage *img = XGetImage(r->dpy, r->win, 0, 0, r->w, r->h, AllPlanes, ZPixmap);
	if (!img) {
		printf("selfcheck: окно не прочиталось\n");
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

	printf("selfcheck: всего %ld, непрозрачных %ld, прозрачных %ld\n",
	       total, opaque, total - opaque);
	if (maxx >= 0)
		printf("selfcheck: bbox непрозрачных %d,%d %dx%d\n",
		       minx, miny, maxx - minx + 1, maxy - miny + 1);
	else
		printf("selfcheck: bbox непрозрачных пуст\n");
	printf("selfcheck: различных значений пикселя %ld\n", distinct);
	printf("selfcheck: пиксель 0,0 = %08x\n", (uint32_t)XGetPixel(img, 0, 0));
	XDestroyImage(img);
}

/* Во что фонтконфиг развернул «sans» на этой машине. На стоковой SteamOS ответ
 * заранее неизвестен, а от него зависит, читаема ли панель — печатаем факт. */
static void report_font(struct renderer *r, int px)
{
	XftFont *f = font_for(r, px);
	if (!f) {
		printf("шрифт: sans:pixelsize=%d НЕ открылся\n", px);
		return;
	}
	FcChar8 *file = NULL, *family = NULL;
	FcPatternGetString(f->pattern, FC_FILE, 0, &file);
	FcPatternGetString(f->pattern, FC_FAMILY, 0, &family);
	printf("шрифт: sans:pixelsize=%d → %s (%s), высота строки %d px (ascent %d, descent %d)\n",
	       px, family ? (const char *)family : "?",
	       file ? (const char *)file : "файл не назван",
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
			fprintf(stderr, "использование: %s [--seconds N] [--hz N] "
			                "[--selfcheck] [--fonts]\n", argv[0]);
			return 2;
		}
	}

	Display *dpy = XOpenDisplay(NULL);
	if (!dpy) {
		const char *d = getenv("DISPLAY");
		fprintf(stderr, "не открылся DISPLAY=%s\n", d ? d : "(не задан)");
		return 3;
	}

	struct renderer r = { .dpy = dpy, .screen = DefaultScreen(dpy) };
	r.w = DisplayWidth(dpy, r.screen);
	r.h = DisplayHeight(dpy, r.screen);

	/* 32-битный TrueColor visual — то, ради чего эта программа не может быть
	 * XCreateSimpleWindow, как зонд спайка: у визуала по умолчанию нет альфы,
	 * и прозрачного фона на нём не получится никакими атомами. */
	XVisualInfo vi;
	if (!XMatchVisualInfo(dpy, r.screen, 32, TrueColor, &vi)) {
		fprintf(stderr, "нет 32-битного TrueColor visual — прозрачный оверлей невозможен\n");
		return 4;
	}
	r.visual = vi.visual;
	r.cmap = XCreateColormap(dpy, RootWindow(dpy, r.screen), r.visual, AllocNone);

	if (fonts_only) {
		/* Шрифту X-окно не нужно, а на Deck этот режим гоняется и без Game Mode. */
		printf("вывод %dx%d, visual 32 бита есть\n", r.w, r.h);
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

	/* Атом ставится ДО XMapWindow: steamcompmgr читает его в map_win. Тот же
	 * порядок, что у зонда спайка, и по той же причине. */
	Atom overlay = XInternAtom(dpy, "GAMESCOPE_EXTERNAL_OVERLAY", False);
	uint32_t one = 1;
	XChangeProperty(dpy, r.win, overlay, XA_CARDINAL, 32, PropModeReplace,
	                (unsigned char *)&one, 1);

	r.buf = XCreatePixmap(dpy, r.win, r.w, r.h, 32);
	r.gc = XCreateGC(dpy, r.buf, 0, NULL);
	r.draw = XftDrawCreate(dpy, r.buf, r.visual, r.cmap);

	XMapWindow(dpy, r.win);
	XSync(dpy, False);
	printf("окно 0x%lx, вывод %dx%d, GAMESCOPE_EXTERNAL_OVERLAY = 1\n", r.win, r.w, r.h);
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
		/* seconds=0 — держать, пока не убьют: так рендерер живёт под демоном,
		 * всю игровую сессию, а гасит панель демон пустым кадром. */
		if (seconds > 0 && t - start >= seconds * 1000.0)
			break;

		/* Событий из этого слоя не приходит (Ф2 спайка), но очередь всё равно
		 * надо разбирать: иначе она растёт, а Expose останется необработанным
		 * там, где сервер его всё-таки шлёт. */
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
				/* Поток кончился без `show` — считаем накопленное кадром,
				 * иначе однократный пайп из shell'а не нарисовал бы ничего. */
				if (!has_frame && next.n) {
					shown = next;
					has_frame = 1;
					dirty = 1;
				}
			}
		}

		/* Рисуем по событию (новый кадр со шва) — это рабочий путь по ADR 0003,
		 * Решение 3. `--hz` поверх него остаётся измерительным режимом: он
		 * перерисовывает то же самое ради статистики, а не ради картинки.
		 * Замер цены и есть эти times[]: каждая запись — полный цикл сборки
		 * кадра до XSync, то есть то, за что платит Deck. */
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
		printf("⚠  команд в кадре больше %d — кадр показан неполным\n", MAX_OPS);
	if (!has_frame)
		printf("⚠  ни одного кадра со stdin — рисовать было нечего\n");

	double elapsed = (now_ms() - start) / 1000.0;
	printf("\nперерисовок: %d за %.1f с (запрошено %d Гц, вышло %.1f)\n",
	       nframes, elapsed, hz, nframes / (elapsed > 0 ? elapsed : 1));
	if (nframes > 0) {
		double sum = 0, max = 0;
		for (int i = 0; i < nframes; i++) {
			sum += times[i];
			if (times[i] > max)
				max = times[i];
		}
		qsort(times, (size_t)nframes, sizeof *times, cmp_double);
		printf("кадр: среднее %.2f мс, медиана %.2f мс, 95-й перцентиль %.2f мс, максимум %.2f мс\n",
		       sum / nframes, percentile(times, nframes, 0.5),
		       percentile(times, nframes, 0.95), max);
	}

	struct rusage ru;
	if (!getrusage(RUSAGE_SELF, &ru)) {
		double cpu = ru.ru_utime.tv_sec + ru.ru_utime.tv_usec / 1e6
		           + ru.ru_stime.tv_sec + ru.ru_stime.tv_usec / 1e6;
		printf("CPU процесса: %.2f с за %.1f с прогона — %.1f%% одного ядра\n",
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
	printf("убрал окно\n");
	return 0;
}
