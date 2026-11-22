/*
 * gs-hotkey-probe — зонд глобального хоткея gamescope.
 *
 * Отвечает на главный риск эпика ввода: может ли ОБЫЧНЫЙ сторонний
 * Wayland-клиент забиндить `gamescope_action_binding` — или протокол на деле
 * доступен только Steam. Bash туда не достаёт: нужен настоящий клиент.
 *
 * Режимы:
 *
 *   --dump      Подключиться, выписать все глобалы сокета и выйти. Ничего не
 *               биндит и не вооружает — безопасно гонять в живой сессии с игрой.
 *               Код 0 ⟺ gamescope_action_binding_manager в списке есть.
 *   (по умолч.) Забиндить менеджер, создать привязку, зарегистрировать аккорды,
 *               вооружить и слушать `triggered` заданное число секунд, печатая
 *               каждое срабатывание с меткой времени.
 *
 * Что зонд НЕ делает и делать не может: сказать, дошла ли клавиша до игры.
 * Это видно только в самой PoE, глазами оператора. Зонд отвечает за свою
 * половину — «слышим ли мы», — и печатает, чего ждать от второй.
 *
 * Две вещи из исходников gamescope, без которых прогон читается неверно:
 *
 * 1. СРАВНЕНИЕ НАБОРОВ ТОЧНОЕ, И ПРОВЕРЯЕТСЯ ОНО НА КАЖДОМ НАЖАТИИ. Хоткей
 *    срабатывает при `setPressedKeySyms != keybind.setKeySyms` → continue
 *    (wlserver.cpp:2501, master): нажатых keysym должно быть ровно столько же
 *    и тех же, лишний зажатый Shift ломает совпадение, а привязка на {D} не
 *    сработает от Ctrl+D. Обратная сторона — промежуточные состояния тоже
 *    сравниваются, поэтому набор маркера не должен возникать по дороге к
 *    другому посылаемому аккорду.
 *
 *    Отсюда умолчание: ДВА аккорда, Ctrl+D левым и правым Control — какой из
 *    них пришлёт Steam Input, заранее неизвестно. Регистрировать несколько
 *    триггеров на одну привязку штатно: `add_keyboard_trigger` копит их
 *    в вектор.
 *
 * 2. ФЛАГ БЛОКИРОВКИ НЕ ЗНАЧИТ ТОГО, ЧТО НАПИСАНО В ПРОТОКОЛЕ, и до
 *    gamescope 3.16.12 не значил вообще ничего. Подробности — в README
 *    (§ «Блокировка: три версии правды»); зонд печатает ожидание сам, чтобы
 *    оператор знал, что смотреть в игре.
 *
 * Почему C, а не TypeScript (стек проекта): протокол приватный и wayland-only,
 * биндинга libwayland для bun в поставке SteamOS нет, а маршалинг генерируется
 * из XML одной командой wayland-scanner. Это инструмент спайка, не код приложения.
 *
 * Сборка — ./build.sh (на Deck внутри distrobox: в системе нет ни компилятора,
 * ни заголовков). Проверка без Deck — ./check.sh, поднимает мок компоновщика.
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

/* Как часто печатать строку состояния, секунд. Ровно как у gs-overlay-probe:
 * лог минутного прогона остаётся читаемым, а «зонд жив» видно без экрана. */
#define TICK_SECONDS 2

#define MAX_CHORDS 8
#define MAX_KEYS_PER_CHORD 8

struct chord {
	uint32_t keysym[MAX_KEYS_PER_CHORD];
	int count;
	char name[128];      /* как аккорд выглядит в логе */
	unsigned triggers;   /* сколько раз сработал именно он */
};

/* Порядок аргументов события `triggered`, распознанный на лету — см. on_triggered. */
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

/* Имена keysym, которых хватает для этого спайка. Полная таблица живёт в
 * libxkbcommon, но тащить рантайм-зависимость ради десятка имён не стоит:
 * всё, чего нет в таблице, пишется шестнадцатеричным кодом (0xffca). */
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

/* Обратное к keysym_parse. Буфер отдаётся вызывающему, потому что печатаемый
 * ASCII имени в таблице не имеет — «D» иначе печаталась бы как 0x44. */
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

	/* Одиночный печатаемый ASCII — сам себе keysym (латиница-1 совпадает с ASCII).
	 * gamescope всё равно нормализует регистр через xkb_keysym_to_upper, так что
	 * «d» и «D» дадут один и тот же триггер. */
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

/* "Control_L+Alt_L+F13" → набор keysym. Возврат false = имя не разобрано. */
static bool chord_parse(const char *spec, struct chord *out)
{
	char buf[256];
	if (strlen(spec) >= sizeof(buf)) {
		fprintf(stderr, "✗  аккорд длиннее %zu символов: %s\n", sizeof(buf) - 1, spec);
		return false;
	}
	strcpy(buf, spec);

	out->count = 0;
	for (char *tok = strtok(buf, "+"); tok; tok = strtok(NULL, "+")) {
		if (out->count == MAX_KEYS_PER_CHORD) {
			fprintf(stderr, "✗  больше %d клавиш в аккорде: %s\n", MAX_KEYS_PER_CHORD, spec);
			return false;
		}
		if (!keysym_parse(tok, &out->keysym[out->count])) {
			fprintf(stderr, "✗  не знаю клавишу «%s» — пиши кодом, например 0xffca\n", tok);
			return false;
		}
		out->count++;
	}
	return out->count > 0;
}

/* Человекочитаемое имя аккорда. Уезжает и в лог зонда, и в set_description —
 * gamescope пишет описание в свой журнал, так что «наш ли это триггер сработал»
 * можно свериться и с его стороны (journalctl -b | grep -i binding). */
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

/* ── события ─────────────────────────────────────────────────────────────── */

static void on_global(void *data, struct wl_registry *registry, uint32_t name,
                      const char *interface, uint32_t version)
{
	struct state *st = data;
	st->globals++;

	bool ours = strcmp(interface, gamescope_action_binding_manager_interface.name) == 0;
	if (st->dump)
		printf("  %-52s v%-2u%s\n", interface, version, ours ? "  ← нужный нам" : "");

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
		printf("⚠  менеджер хоткеев исчез из реестра — gamescope его отозвал\n");
}

static const struct wl_registry_listener k_registry_listener = {
	.global = on_global,
	.global_remove = on_global_remove,
};

/* Аргументы приходят под именами из XML, но верить именам нельзя: gamescope
 * ≤3.16.24 шлёт их в другом порядке, чем объявляет его же XML того же тега —
 *
 *   XML  :  sequence, time_lo, time_hi, trigger_flags
 *   ≤3.16.24: sequence, trigger_flags, time_lo, time_hi   (src/WaylandServer/
 *             GamescopeActionBinding.h, вызов send_triggered; починено в 3.16.25)
 *
 * На Deck стоит 3.16.23.4, то есть версия с расхождением: читая по XML, мы
 * получали время в 424 года и флаги 0x159b. Различаем не по версии — её из
 * протокола не спросить, — а по самому времени: у нас есть свой CLOCK_MONOTONIC
 * как эталон, и правдоподобен ровно один из двух разборов.
 */
/* Контекст листенера: событие `triggered` НЕ говорит, какой из триггеров
 * совпал — в нём только sequence, время и флаги. Поэтому на каждый аккорд
 * заводится своя привязка со своим листенером, и «какой именно сработал»
 * читается по объекту. Без этого прогон #37 дал 62 события, про которые нельзя
 * было сказать, был ли среди них хоть один Ctrl+D. */
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

	/* Событию меньше минуты от роду по построению: мы его только что получили.
	 * Секунда допуска вперёд — на случай, если метка окажется чуть впереди
	 * нашего clock_gettime: различить надо правдоподобное от 424 лет, а не
	 * ловить наносекунды. */
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
		printf("  порядок аргументов triggered: %s\n",
		       order == ORDER_XML ? "как в XML (gamescope ≥3.16.25)"
		     : order == ORDER_SWAPPED ? "как в gamescope ≤3.16.24 — флаги и время переставлены"
		     : "НЕ РАСПОЗНАН, время ниже читать нельзя");
	}

	char lag[80];
	if (order == ORDER_UNKNOWN)
		snprintf(lag, sizeof(lag), "⚠ сырые аргументы 0x%x 0x%x 0x%x",
		         time_lo, time_hi, trigger_flags);
	else
		snprintf(lag, sizeof(lag), "до нас доехало за %.2f мс",
		         (double)(now - event_ns) / 1e6);

	st->triggers++;
	ctx->chord->triggers++;
	printf("  ★ [%s] #%u  seq=%u  t=%.6f с CLOCK_MONOTONIC  %s  flags=0x%x%s\n",
	       ctx->chord->name, st->triggers, sequence, (double)event_ns / 1e9, lag, flags,
	       (flags & GAMESCOPE_ACTION_BINDING_TRIGGER_FLAG_KEYBOARD) ? " (keyboard)" : "");
	fflush(stdout);
}

static const struct gamescope_action_binding_listener k_binding_listener = {
	.triggered = on_triggered,
};

/* ── цикл ────────────────────────────────────────────────────────────────── */

/* Один проход: дождаться событий или таймаута. Возврат false = соединение
 * порвалось (gamescope ушёл), и это отдельный от «нажатий не было» исход. */
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
	    "gs-hotkey-probe [--dump] [--seconds N] [--no-block] [--display СОКЕТ]\n"
	    "                [--keys Control_L+Alt_L+F13]…\n"
	    "\n"
	    "  --dump      выписать глобалы сокета и выйти; код 0 = менеджер хоткеев есть\n"
	    "  --seconds   сколько слушать, по умолчанию 60\n"
	    "  --no-block  выставить бит no_block протокола (см. README, § блокировка)\n"
	    "  --keys      аккорд, можно повторять; по умолчанию Ctrl+D левым\n"
	    "              и правым Control\n"
	    "  --display   имя сокета; по умолчанию GAMESCOPE_WAYLAND_DISPLAY,\n"
	    "              затем WAYLAND_DISPLAY, затем gamescope-0\n");
}

int main(int argc, char **argv)
{
	struct state st = { .order = ORDER_UNSET };
	int seconds = 60;
	uint32_t arm_flags = 0;
	const char *socket_name = NULL;
	/* Обнуляем: счётчик срабатываний и имя аккорда живут прямо здесь, а
	 * chord_parse их не трогает. Мусор в них уехал бы в итоговую разбивку. */
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
				fprintf(stderr, "✗  больше %d аккордов не поддерживается\n", MAX_CHORDS);
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

	/* Умолчание: все четыре сочетания левых и правых модификаторов. Какой из них
	 * пришлёт Steam Input, до прогона на железе неизвестно, а сравнение точное.
	 *
	 * Клавиша — «D», а не «F13», как предлагала разведка ввода: F13–F24 Steam
	 * Input отправлять НЕ УМЕЕТ (конфигуратор их не показывает — проверено по
	 * обсуждениям Valve, README § «Чем жать»).
	 *
	 * Аккорд — Ctrl+D, две клавиши, а не три. Число клавиш роли не играет: важно,
	 * чтобы набор маркера не возникал по дороге к другому посылаемому аккорду, и
	 * {Ctrl,D} этому удовлетворяет — «D» не входит в Ctrl+Alt+C, который уходит
	 * в игру. Ровно эту пару можно назначить на два задних курка Deck и нажать
	 * руками уже сегодня; Ctrl+D же использует awakened-poe-trade.
	 * Занимает ли «D» сама PoE — отдельный вопрос, его закрывает MODE=GAMEKEY. */
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

	printf("сокет: %s (XDG_RUNTIME_DIR=%s)\n", socket_name,
	       getenv("XDG_RUNTIME_DIR") ? getenv("XDG_RUNTIME_DIR") : "не задан");

	struct wl_display *display = wl_display_connect(socket_name);
	if (!display) {
		printf("✗  не подключился к сокету %s: %s\n", socket_name, strerror(errno));
		printf("   в Game Mode имя сокета лежит в /run/user/<uid>/gamescope-environment\n");
		return 1;
	}
	printf("✓  подключились к сокету обычным клиентом, без всяких прав\n");

	struct wl_registry *registry = wl_display_get_registry(display);
	wl_registry_add_listener(registry, &k_registry_listener, &st);
	if (wl_display_roundtrip(display) < 0) {
		printf("✗  реестр не отдался: %s\n", strerror(errno));
		return 1;
	}

	if (st.dump) {
		printf("\nвсего глобалов: %d\n", st.globals);
		if (!st.manager_version) {
			printf("✗  gamescope_action_binding_manager в реестре НЕТ — "
			       "либо это не gamescope, либо протокол закрыт от нас\n");
			return 1;
		}
		printf("✓  gamescope_action_binding_manager есть, версия %u — "
		       "протокол доступен стороннему клиенту\n", st.manager_version);
		return 0;
	}

	if (!st.manager) {
		printf("✗  gamescope_action_binding_manager в реестре НЕТ. Всего глобалов: %d.\n",
		       st.globals);
		printf("   ОТВЕТ СПАЙКА: НЕТ. Основной путь ввода отпадает, идти в запасные.\n");
		return 1;
	}
	printf("✓  менеджер хоткеев забинден: версия глобала %u, взяли %u\n",
	       st.manager_version, gamescope_action_binding_manager_interface.version);

	/* ОДНА ПРИВЯЗКА НА АККОРД, а не один объект со списком триггеров.
	 * Событие `triggered` не сообщает, какой из триггеров совпал, поэтому
	 * различить их можно только по объекту-получателю. Менеджер создаёт
	 * привязки без ограничения по числу. */
	struct gamescope_action_binding *bindings[MAX_CHORDS];
	struct binding_ctx ctxs[MAX_CHORDS];

	for (int i = 0; i < chord_count; i++) {
		chord_name(&chords[i]);

		bindings[i] = gamescope_action_binding_manager_create_action_binding(st.manager);
		if (!bindings[i]) {
			printf("✗  create_action_binding не отдал объект для аккорда %s\n",
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
				printf("✗  не хватило памяти под массив keysym\n");
				return 1;
			}
			*slot = chords[i].keysym[k];
		}
		gamescope_action_binding_add_keyboard_trigger(bindings[i], &keysyms);
		wl_array_release(&keysyms);

		gamescope_action_binding_arm(bindings[i], arm_flags);
		printf("  триггер %d: %s\n", i + 1, chords[i].name);
	}

	if (wl_display_roundtrip(display) < 0) {
		printf("✗  сервер отверг привязку: %s\n", strerror(errno));
		printf("   ОТВЕТ СПАЙКА: НЕТ, протокол закрыт для сторонних клиентов.\n");
		return 1;
	}
	printf("✓  привязка вооружена, arm_flags=0x%x (%s)\n", arm_flags,
	       (arm_flags & GAMESCOPE_ACTION_BINDING_ARM_FLAG_NO_BLOCK)
	           ? "бит no_block ВЫСТАВЛЕН" : "бит no_block не выставлен");

	/* Единственное, чего зонд не измеряет сам, — дошла ли клавиша до игры.
	 * Поэтому он называет, что смотреть, и почему ответ неочевиден. */
	printf("\nЧТО СМОТРЕТЬ В ИГРЕ. Протокол обещает: без no_block клавиша\n"
	       "перехватывается и до приложения не доходит. Исходники говорят иначе —\n"
	       "с 3.16.12 блокирует как раз ВЫСТАВЛЕННЫЙ no_block, а до 3.16.12\n"
	       "блокировки нет вовсе. Разбор — README, § «Блокировка: три версии правды».\n"
	       "Прогнать надо оба раза и посмотреть, реагирует ли PoE на клавишу-маркер.\n");

	printf("\nслушаю %d с. Жми назначенную кнопку — и в игре, и в QAM.\n", seconds);
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
			printf("  [%3llu с] жив, срабатываний %u\n",
			       (unsigned long long)((now - started) / 1000000000ull), st.triggers);
			fflush(stdout);
			next_tick = now + (uint64_t)TICK_SECONDS * 1000000000ull;
		}
	}

	printf("\n");
	if (!alive) {
		printf("✗  соединение с gamescope порвалось до конца прогона "
		       "(срабатываний собрано: %u)\n", st.triggers);
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
		printf("ИТОГ: привязка ПРИНЯТА, но за %d с не сработала ни разу.\n", seconds);
		printf("      аккорды, которые слушались:");
		for (int i = 0; i < chord_count; i++)
			printf(" %s", chords[i].name);
		printf("\n");
		printf("      Это НЕ ответ «нет»: биндиться сторонний клиент смог.\n");
		printf("      Дальше две развилки — либо клавиша не доехала до gamescope\n");
		printf("      (проверять Steam Input), либо набор keysym не совпал точно\n");
		printf("      (пробовать --keys с другими сочетаниями).\n");
		return 1;
	}

	printf("ИТОГ: ДА. Сторонний клиент биндит gamescope_action_binding и получает\n");
	printf("      события — их %u за %d с. Осталось глазами подтвердить,\n",
	       st.triggers, seconds);
	printf("      дошла ли клавиша при этом до игры.\n\n");

	/* Разбивка по аккордам — то, ради чего заведена привязка на каждый.
	 * «62 события» без неё не отвечают на вопрос, сработал ли нужный аккорд
	 * или всё набил один одиночный модификатор. */
	printf("      по аккордам:\n");
	for (int i = 0; i < chord_count; i++)
		printf("        %-28s %u%s\n", chords[i].name, chords[i].triggers,
		       chords[i].triggers ? "" : "   ← ни разу");
	return 0;
}
