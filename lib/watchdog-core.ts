/**
 * watchdog-core — čistá logika pi-watchdogu (bez závislosti na pi API).
 * Testovatelné samostatně přes node --experimental-strip-types.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** V child procesu (které watchdog sám spouští) se démon neaktivuje → žádná rekurze. */
export const CHILD_ENV = "PI_WATCHDOG_CHILD";
export const CONFIG_TYPE = "pi-watchdog-config";

/** Název složky v balíčku, kde žijí uživatelské prompty (formát skillu). */
export const PROMPTS_DIR_NAME = "prompts";

/**
 * Maximální velikost exportu session (ve znacích), který se posílá child pi.
 * Musí zůstat pod limitem shimu (~400000 znaků), jinak child vrátí
 * "Dosažen limit délky" a watchdog spadne na "...".
 */
export const MAX_EXPORT_CHARS = 200000;

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
	/** Název zvoleného prompt-skills z `prompts/`. Prázdné = vestavěný GUIDANCE_PROMPT. */
	prompt: string;
}

export const DEFAULT_CONFIG: WatchdogConfig = {
	enabled: true,
	mode: "smart",
	model: "deepseek-free/deepseek-reasoner",
	max: 20,
	prompt: "",
};

/** Záložní seznam, když se modely nepodaří načíst z pi (mirror se plní za běhu). */
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

// ---------------------------------------------------------------------------
// Prompt skills (formát skillu: <prompts>/<nazev>/SKILL.md s frontmatter)
// ---------------------------------------------------------------------------

export interface PromptSkill {
	/** Název složky (slug). */
	dir: string;
	/** `name` z frontmatteru (fallback = dir). */
	name: string;
	description: string;
	/** Absolutní cesta k SKILL.md. */
	path: string;
}

export interface SkillFrontmatter {
	name?: string;
	description?: string;
}

/**
 * Vyparsuje YAML frontmatter (mezi prvními dvěma `---`) ze SKILL.md.
 * Záměrně jednoduché — čte jen skalární `name:` a `description:`.
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
	const out: SkillFrontmatter = {};
	const norm = text.replace(/\r\n/g, "\n");
	if (!norm.startsWith("---")) return out;
	const end = norm.indexOf("\n---", 3);
	if (end === -1) return out;
	const block = norm.slice(3, end);
	for (const rawLine of block.split("\n")) {
		const line = rawLine.trim();
		const m = /^(name|description)\s*:\s*(.*)$/.exec(line);
		if (!m) continue;
		let value = m[2].trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (m[1] === "name") out.name = value;
		else out.description = value;
	}
	return out;
}

/** Vrátí tělo SKILL.md bez frontmatteru (to, co se posílá jako prompt). */
export function stripFrontmatter(text: string): string {
	const norm = text.replace(/\r\n/g, "\n");
	if (!norm.startsWith("---")) return norm.trim();
	const end = norm.indexOf("\n---", 3);
	if (end === -1) return norm.trim();
	return norm.slice(end + 4).replace(/^\n+/, "").trim();
}

/**
 * Ze seznamu souborů (výstup fs.readdirSync) vybere ty, které vypadají jako
 * prompt-skill: `<dir>/SKILL.md`. Čistě kvůli testovatelnosti bez fs.
 */
export function pickSkillDirs(entries: readonly string[]): string[] {
	return entries.filter((name) => !name.startsWith(".")).sort();
}

/** Načte prompt-skills z `prompts/<nazev>/SKILL.md` (formát skillu). */
export function loadPromptSkills(dir: string): PromptSkill[] {
	const out: PromptSkill[] = [];
	let names: string[] = [];
	try {
		if (!fs.existsSync(dir)) return out;
		names = pickSkillDirs(fs.readdirSync(dir));
	} catch {
		return out;
	}
	for (const name of names) {
		const file = path.join(dir, name, "SKILL.md");
		try {
			if (!fs.existsSync(file)) continue;
			const text = fs.readFileSync(file, "utf-8");
			const fm = parseSkillFrontmatter(text);
			out.push({
				dir: name,
				name: fm.name || name,
				description: fm.description || "",
				path: file,
			});
		} catch {
			/* přeskoč rozbitý prompt */
		}
	}
	return out;
}

/** Tělo zvoleného prompt-skills (nebo null, když není vybrán / nejde přečíst). */
export function readPromptBody(skills: readonly PromptSkill[], chosen: string): string | null {
	if (!chosen) return null;
	const skill = skills.find((s) => s.dir === chosen || s.name === chosen);
	if (!skill) return null;
	try {
		return stripFrontmatter(fs.readFileSync(skill.path, "utf-8"));
	} catch {
		return null;
	}
}

/** Text, který se zapíše do prompt souboru pro child pi. */
export function choosePromptText(builtin: string, customBody: string | null | undefined): string {
	const body = (customBody ?? "").trim();
	return body.length > 0 ? body : builtin;
}

/**
 * Vrátí ocas textu (po celých řádcích) tak, aby se vešel do `maxChars`.
 * Bere řádky od konce; obří řádky (např. výstup toolu) přeskočí, aby se
 * do limitu vešlo co nejvíc relevantních (posledních) zpráv.
 * Vždy končí `\n`, když něco vrátí.
 */
export function tailByChars(text: string, maxChars: number): string {
	if (!text) return "";
	const lines = text.split("\n");
	const taken: string[] = [];
	let size = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		const lineSize = line.length + 1; // +1 za \n
		// prázdné řádky na konci přeskoč
		if (line.trim() === "" && taken.length === 0) continue;
		if (size + lineSize > maxChars) {
			// obří řádek přeskoč a zkus menší starší
			continue;
		}
		taken.push(line);
		size += lineSize;
	}
	if (taken.length === 0) return "";
	return taken.reverse().join("\n") + "\n";
}

/**
 * Rozpozná, že výstup z child pi není skutečné nasměrování, ale chybová
 * zpráva shimu (limit délky / prázdná odpověď). Takovou zprávu neposílat
 * jako guidance.
 */
export function isShimError(text: string): boolean {
	const t = (text ?? "").trim();
	if (t === "") return false;
	if (/CHYBA SHIMU/i.test(t)) return true;
	if (/Dosažen limit délky/i.test(t)) return true;
	if (/prazdna odpoved|prázdná odpověď/i.test(t)) return true;
	return false;
}

/**
 * Popisek modelu pro picker — přesně to, co pi bere pro `--model`
 * (`provider/id`). Mirro pi modelů se plní z `ctx.modelRegistry`.
 */
export function formatModelValue(model: { provider?: string; id: string }): string {
	return `${model.provider ?? "?"}/${model.id}`;
}

/** Seřadí modely jako pi: nejdřív podle providera, pak podle id. */
export function sortModels<T extends { provider?: string; id: string }>(models: readonly T[]): T[] {
	return [...models].sort((a, b) => {
		const pa = a.provider ?? "";
		const pb = b.provider ?? "";
		if (pa !== pb) return pa < pb ? -1 : 1;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}

/** Seskupí modely podle providera (pro vykreslení do sloupců/skupin). */
export function groupModelsByProvider<T extends { provider?: string; id: string }>(
	models: readonly T[],
): Array<{ provider: string; models: T[] }> {
	const map = new Map<string, T[]>();
	for (const m of sortModels(models)) {
		const p = m.provider ?? "?";
		const arr = map.get(p);
		if (arr) arr.push(m);
		else map.set(p, [m]);
	}
	return [...map.entries()].map(([provider, list]) => ({ provider, models: list }));
}