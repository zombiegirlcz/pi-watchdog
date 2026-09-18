/**
 * watchdog-core — čistá logika pi-watchdogu (bez závislosti na pi API).
 * Testovatelné samostatně přes node --experimental-strip-types.
 */

/** V child procesu (které watchdog sám spouští) se démon neaktivuje → žádná rekurze. */
export const CHILD_ENV = "PI_WATCHDOG_CHILD";
export const CONFIG_TYPE = "pi-watchdog-config";

export const GUIDANCE_PROMPT = [
	"Jsi watchdog, který právě čte session log jiného agenta (pi).",
	"Agent dokončil práci nebo čeká na další směr. Tvým úkolem je nasměrovat ho správným směrem.",
	"",
	"Pravidla:",
	"- Neřeš jazyk odpovědi, jde o obsah.",
	"- Než něco doporučíš, můžeš si stav ověřit pomocí nástrojů (read, bash) — ověřuj, netvrď naslepo.",
	"- Vyber to, co je pro daný cíl a kontext NEJUŽITEČNĚJŠÍ — další konkrétní krok, na který agent sám nepřišel.",
	"- Upozorni ho na testovací a bezpečnostní pravidla, pokud je v kontextu porušuje nebo ignoruje (TDD, žádné destruktivní operace, ověření před tvrzením „hotovo\").",
	"- Buď konkrétní a stručný: max 3 věty, imperativ, žádné omáčky.",
	'- Pokud je práce skutečně hotová a není co dodat, odpověz pouze "...".',
	"",
	"Session log agenta je přiložený jako JSONL soubor. Odpověz jen textem, nic jiného.",
].join("\n");

export type WatchdogMode = "smart" | "simple";

export interface WatchdogConfig {
	enabled: boolean;
	mode: WatchdogMode;
	model: string;
	max: number;
}

export const DEFAULT_CONFIG: WatchdogConfig = {
	enabled: true,
	mode: "smart",
	model: "deepseek-free/deepseek-reasoner",
	max: 20,
};

export const MODEL_CHOICES = [
	"deepseek-free/deepseek-reasoner",
	"deepseek-free/deepseek-chat",
	"qwen-free/qwen3-coder",
];

export type WatchdogAction = "none" | "dots" | "guidance";

export interface DecideInput {
	enabled: boolean;
	mode: string;
	count: number;
	max: number;
	running: boolean;
	isError: boolean;
	lastWasWatchdog: boolean;
}

/** Čisté rozhodnutí, co démon udělá. */
export function decide(i: DecideInput): WatchdogAction {
	if (!i.enabled) return "none";
	if (i.running) return "none";
	if (i.mode === "off") return "none";
	if (i.max > 0 && i.count >= i.max) return "none";
	if (i.mode === "simple" || i.isError) return "dots";
	if (i.lastWasWatchdog) return "dots";
	return "guidance";
}

function messageOf(entry: unknown): any | undefined {
	const e = entry as any;
	if (e?.type !== "message" || !e.message) return undefined;
	return e.message;
}

/** Projde session od konce a řekne, jestli poslední relevantní zpráva znamená chybu. */
export function lastIsError(entries: readonly unknown[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const m = messageOf(entries[i]);
		if (!m) continue;
		if (m.role === "custom") continue; // naše vlastní zprávy přeskoč
		if (m.role === "assistant") {
			if (m.error) return true;
			return m.stopReason === "error" || m.stopReason === "aborted";
		}
		if (m.role === "toolResult") return m.isError === true;
		if (m.role === "user") return true; // uživatel poslal zprávu a agent nic neudělal
	}
	return false;
}

/** Byl poslední "lidský" vstup náš watchdog (a ne skutečný uživatel)? */
export function lastWasWatchdog(entries: readonly unknown[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const m = messageOf(entries[i]);
		if (!m) continue;
		if (m.role === "custom") {
			if (m.customType === "pi-watchdog-guidance") return true;
			continue;
		}
		if (m.role === "user") return false;
	}
	return false;
}

export function shellQuote(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Sestaví příkaz pro child pi, který vygeneruje nasměrování.
 * Child MÁ plné tools (read/bash), aby si stav mohl ověřit — žádné --no-tools.
 * Rekurzi watchdogu brání guard PI_WATCHDOG_CHILD=1, ne --no-extensions.
 */
export function buildChildCommand(opts: {
	promptPath: string;
	exportPath: string;
	model: string;
}): string {
	return [
		`${CHILD_ENV}=1 pi`,
		`-p "$(cat ${shellQuote(opts.promptPath)})"`,
		`@${shellQuote(opts.exportPath)}`,
		`--model ${shellQuote(opts.model)}`,
		"--no-session",
	].join(" ");
}

/** Poskládá konfiguraci z custom entries v session (poslední vyhrává). */
export function loadConfigFromEntries(entries: readonly unknown[]): WatchdogConfig {
	let cfg = { ...DEFAULT_CONFIG };
	for (const entry of entries) {
		const e = entry as any;
		if (e?.type === "custom" && e.customType === CONFIG_TYPE && e.data) {
			cfg = { ...cfg, ...e.data };
		}
	}
	return cfg;
}