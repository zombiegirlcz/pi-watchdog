/**
 * pi-watchdog — démon, který hlídá, že se pi nezastavil.
 *
 * Kdykoli se agent usadí (agent_settled), vyhodnotí stav:
 *
 *   • agent zavolal `task_complete`  → práce je 100% hotová, watchdog mlčí.
 *
 *   • poslední zpráva je CHYBA (error / aborted / toolResult.isError),
 *     nebo agent na předchozí zásah nereagoval
 *       → pošle "nudge" (krátkou zprávu s triggerTurn:true). Tím se znovu
 *         pošle request na API se stávajícím kontextem — to je ta "šťouchnutí",
 *         na které agent skutečně zareaguje (na rozdíl od pouhého zápisu "...").
 *
 *   • poslední zpráva je DOKONČENÁ PRÁCE / čekání na směr
 *       → vyexportuje aktuální session do /tmp/watchdog-*.jsonl,
 *         spustí child `pi -p "<watchdog prompt>" @export --model <model> --no-session`,
 *         získá konkrétní nasměrování (child MÁ plné tools, takže si stav může ověřit),
 *         a předá ho agentovi jako zprávu s triggerTurn (probudí ho).
 *
 * Všechna selhání child pi (timeout, nenulový exit, chyba shimu) se zapisují
 * jako custom ENTRY (`pi.appendEntry`) — zobrazí se v chatu, ale NEposílají
 * se do LLM kontextu (stejně jako to pi dělá u hlášky o rate limitu).
 *
 * Nastavení se dělá v TUI: příkaz `/watchdog` otevře overlay okno:
 *   • VLEVO  — mirror pi modelů (všechny, které pi zná)
 *   • VPRAVO — Tab přepíná mezi záložkou „Prompty“ a „Nastavení“
 *              - Prompty: uživatelské prompt-skills z `prompts/<nazev>/SKILL.md`
 *              - Nastavení: on/off, režim, max. počet zásahů, timeout kontroly
 *
 * Smyčka je omezená: pokud předchozí tah spustil watchdog a agent na něj
 * zatím neodpověděl, další settle už jen "nudge" (nový request), ne další
 * child pi. `task_complete` hlídání ukončí úplně.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Key,
	matchesKey,
	SelectList,
	Text,
	type SelectItem,
	type SettingItem,
	SettingsList,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	CHILD_ENV,
	CONFIG_TYPE,
	DEFAULT_CONFIG,
	GUIDANCE_PROMPT,
	GUIDANCE_TYPE,
	LOG_TYPE,
	MAX_EXPORT_CHARS,
	MODEL_CHOICES,
	NUDGE_TEXT,
	NUDGE_TYPE,
	PROMPTS_DIR_NAME,
	TASK_COMPLETE_TYPE,
	TIMEOUT_CHOICES,
	buildChildCommand,
	choosePromptText,
	decide,
	formatTimeout,
	lastIsError,
	lastWasWatchdog,
	loadConfigFromEntries,
	loadPromptSkills,
	readPromptBody,
	parseTimeout,
	sortModels,
	tailByChars,
	taskCompleted,
	isShimError,
	type PromptSkill,
	type WatchdogConfig,
	type WatchdogMode,
} from "../lib/watchdog-core.ts";

export * from "../lib/watchdog-core.ts";

/** Data, která si vezmeme ze session SYNCHRONNĚ v momentě agent_settled.
 *  Později už na ctx nesaháme — po reloadu/změně session je ctx "stale". */
export interface SettledFacts {
	hasUI: boolean;
	sessionFile?: string;
	entries: unknown[];
}

/** Synchronně vytáhne fakta ze session; když je ctx už nedostupný, vrátí null. */
export function collectFacts(ctx: any): SettledFacts | null {
	try {
		const sm = ctx?.sessionManager;
		if (!sm) return null;
		return {
			hasUI: !!ctx?.hasUI,
			sessionFile: sm.getSessionFile?.() ?? undefined,
			entries: sm.getEntries?.() ?? [],
		};
	} catch {
		return null;
	}
}

/** Jednoduchý model pro UI (mirror pi modelů). */
interface ModelInfo {
	provider: string;
	id: string;
	name: string;
}

/** Kořen balíčku (o úroveň výš než `extensions/`). */
function packageRoot(): string {
	try {
		return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	} catch {
		return process.cwd();
	}
}

function promptsDir(): string {
	return path.join(packageRoot(), PROMPTS_DIR_NAME);
}



/** Mirror pi modelů: nejdřív ty s nakonfigurovaným auth, jinak celý katalog. */
function listModels(ctx: any): ModelInfo[] {
	try {
		const reg = ctx?.modelRegistry;
		if (!reg) return [];
		let models: any[] = [];
		if (typeof reg.getAvailable === "function") models = reg.getAvailable() ?? [];
		if ((!models || models.length === 0) && typeof reg.getAll === "function") {
			models = reg.getAll() ?? [];
		}
		return sortModels(
			models.map((m) => ({
				provider: String(m?.provider ?? "?"),
				id: String(m?.id ?? "?"),
				name: String(m?.name ?? m?.id ?? "?"),
			})),
		);
	} catch {
		return [];
	}
}

/** Je nakonfigurovaný `--model` použitelný? Když ne, zkusíme první dostupný. */
function resolveModel(cfgModel: string, models: ModelInfo[]): string | null {
	if (models.length === 0) return cfgModel || null;
	if (cfgModel && models.some((m) => `${m.provider}/${m.id}` === cfgModel)) return cfgModel;
	return models.length > 0 ? `${models[0].provider}/${models[0].id}` : null;
}

export default function (pi: ExtensionAPI) {
	// Child pi (spouštěný watchdogem) démona nenačítá → žádná rekurze.
	if (process.env[CHILD_ENV] === "1") return;

	let cfg: WatchdogConfig = { ...DEFAULT_CONFIG };
	let count = 0;
	let running = false;

	function saveConfig() {
		pi.appendEntry(CONFIG_TYPE, { ...cfg });
	}

	/** Log do chatu, ale MIMO LLM kontext (custom entry). */
	function log(level: "info" | "warn" | "error", text: string) {
		try {
			pi.appendEntry(LOG_TYPE, { level, text, at: Date.now() });
		} catch {
			/* ignore */
		}
	}

	/**
	 * Nudge — znovu pošle request na API se stávajícím kontextem.
	 * Na rozdíl od `...` (které se jen zapíše do chatu) tohle spustí nový
	 * LLM turn (`triggerTurn: true`), takže agent skutečně zareaguje.
	 */
	function sendNudge() {
		try {
			pi.sendMessage(
				{ customType: NUDGE_TYPE, content: NUDGE_TEXT, display: true },
				{ triggerTurn: true, deliverAs: "steer" },
			);
		} catch (err) {
			log("error", `nudge selhal: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	function sendGuidance(text: string) {
		try {
			pi.sendMessage(
				{ customType: GUIDANCE_TYPE, content: text, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch (err) {
			log("error", `guidance selhala: ${err instanceof Error ? err.message : String(err)}`);
			sendNudge();
		}
	}

	function cleanup(p: string) {
		try {
			fs.unlinkSync(p);
		} catch {
			/* ignore */
		}
	}

	async function generateGuidance(
		sessionFile: string | undefined,
		promptText: string,
		models: ModelInfo[],
	): Promise<string | null> {
		if (!sessionFile || !fs.existsSync(sessionFile)) {
			log("warn", "guidance: není session file");
			return null;
		}
		const model = resolveModel(cfg.model, models);
		if (!model) {
			log("warn", "guidance: žádný použitelný model");
			return null;
		}
		if (model !== cfg.model) {
			log("warn", `guidance: model "${cfg.model}" není dostupný, používám "${model}"`);
		}

		const stamp = `${Date.now()}-${process.pid}`;
		const exportPath = path.join(os.tmpdir(), `watchdog-${stamp}.jsonl`);
		const promptPath = path.join(os.tmpdir(), `watchdog-${stamp}.prompt.txt`);
		try {
			// Exportujeme jen ohraničený ocas session (celá session by přetekla
			// limit shimu → child by vrátil "Dosažen limit délky").
			const raw = fs.readFileSync(sessionFile, "utf-8");
			fs.writeFileSync(exportPath, tailByChars(raw, MAX_EXPORT_CHARS), "utf-8");
			fs.writeFileSync(promptPath, promptText, "utf-8");
		} catch (err) {
			log("error", `guidance: příprava souborů selhala: ${err instanceof Error ? err.message : String(err)}`);
			cleanup(exportPath);
			cleanup(promptPath);
			return null;
		}

		const timeout = cfg.timeout > 0 ? cfg.timeout : undefined;
		try {
			const res = await (pi as any).exec(
				"bash",
				["-c", buildChildCommand({ promptPath, exportPath, model })],
				timeout ? { timeout } : {},
			);
			if (res?.code !== 0) {
				log(
					"error",
					`guidance: child pi skončil s kódem ${res?.code} (timeout=${formatTimeout(cfg.timeout)})`,
				);
				return null;
			}
			const out = String(res?.stdout ?? "").trim();
			// Chybová zpráva shimu není nasměrování → ber jako selhání.
			if (out.length === 0) {
				log("warn", "guidance: child pi vrátil prázdný výstup");
				return null;
			}
			if (isShimError(out)) {
				log("error", `guidance: chyba shimu: ${out.slice(0, 200)}`);
				return null;
			}
			return out;
		} catch (err) {
			log("error", `guidance: child pi selhal: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		} finally {
			cleanup(exportPath);
			cleanup(promptPath);
		}
	}

	async function fire(facts: SettledFacts, models: ModelInfo[]) {
		if (running) return;
		if (!facts.hasUI) return;

		const action = decide({
			enabled: cfg.enabled,
			mode: cfg.mode,
			count,
			max: cfg.max,
			running,
			isError: lastIsError(facts.entries),
			lastWasWatchdog: lastWasWatchdog(facts.entries),
			taskComplete: taskCompleted(facts.entries),
		});
		if (action === "none") return;

		running = true;
		count++;
		try {
			if (action === "nudge") {
				sendNudge();
				return;
			}
			const skills = loadPromptSkills(promptsDir());
			const promptText = choosePromptText(GUIDANCE_PROMPT, readPromptBody(skills, cfg.prompt));
			const guidance = await generateGuidance(facts.sessionFile, promptText, models);
			if (guidance && guidance.trim() !== "...") {
				sendGuidance(guidance.trim());
			} else {
				sendNudge();
			}
		} finally {
			running = false;
		}
	}

	// ---- registrace rendererů a toolu -------------------------------------

	// Log v chatu, ale mimo LLM kontext.
	pi.registerEntryRenderer(LOG_TYPE, (entry: any, { expanded }, theme: any) => {
		const d = entry?.data as { level?: string; text?: string; at?: number } | undefined;
		const level = d?.level ?? "info";
		const color = level === "error" ? "error" : level === "warn" ? "warning" : "muted";
		const label = level === "error" ? "ERROR" : level === "warn" ? "WARN" : "INFO";
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		let text = `${theme.fg(color, `[watchdog ${label}]`)} ${d?.text ?? ""}`;
		if (expanded && d?.at) {
			text += `\n${theme.fg("dim", new Date(d.at).toLocaleTimeString())}`;
		}
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	// Tool `task_complete` — agent jím potvrdí, že je práce 100% hotová.
	pi.registerTool({
		name: "task_complete",
		label: "Task complete",
		description:
			"Potvrď, že zadaný úkol je 100% hotový a ověřený — teprve pak zavolej tento tool. " +
			"Ukončí automatické hlídání (watchdog). Nevolej, dokud nejsou splněny všechny " +
			"požadavky zadání a ověřené (testy, build, běh).",
		parameters: Type.Object({
			summary: Type.Optional(
				Type.String({ description: "Krátké shrnutí, co je hotové a jak je to ověřené." }),
			),
		}),
		async execute(_toolCallId, params: any, _signal, _onUpdate, _ctx) {
			try {
				pi.appendEntry(TASK_COMPLETE_TYPE, {
					summary: params?.summary ?? "",
					at: Date.now(),
				});
			} catch {
				/* ignore */
			}
			return {
				content: [
					{
						type: "text",
						text: `Úkol označen jako 100% hotový. Watchdog ukončen.${params?.summary ? `\n\n${params.summary}` : ""}`,
					},
				],
				details: { taskComplete: true },
			};
		},
	});

	// ---- TUI overlay přes /watchdog ---------------------------------------

	function refreshStatus(ctx: any) {
		if (!ctx?.hasUI) return;
		try {
			ctx.ui.setStatus(
				"pi-watchdog",
				cfg.enabled ? ctx.ui.theme.fg("accent", "🐕 watchdog") : undefined,
			);
		} catch {
			/* ignore */
		}
	}

	function buildOverlay(
		ctx: any,
		tui: any,
		theme: any,
		done: (v: unknown) => void,
		models: ModelInfo[],
		skills: PromptSkill[],
	) {
		// --- levý sloupec: mirror pi modelů ---------------------------------
		const modelItems: SelectItem[] =
			models.length > 0
				? models.map((m) => ({
						value: `${m.provider}/${m.id}`,
						label: m.id,
						description: m.provider,
					}))
				: MODEL_CHOICES.map((v) => {
						const [p, ...rest] = v.split("/");
						return { value: v, label: rest.join("/") || v, description: p };
					});

		const modelsSelect = new SelectList(modelItems, 16, getSelectListTheme());
		// předvyber aktuální model
		{
			const idx = modelItems.findIndex((it) => it.value === cfg.model);
			if (idx >= 0) modelsSelect.setSelectedIndex(idx);
		}
		modelsSelect.onSelect = (item) => {
			cfg.model = item.value;
			saveConfig();
			refreshStatus(ctx);
			tui.requestRender();
		};

		// --- pravý sloupec, záložka Prompty ---------------------------------
		const promptItems: SelectItem[] = [
			{ value: "", label: "(vestavěný prompt)", description: "výchozí watchdog prompt" },
			...skills.map((s) => ({
				value: s.dir,
				label: s.name,
				description: s.description,
			})),
		];
		const promptsSelect = new SelectList(promptItems, 16, getSelectListTheme());
		{
			const idx = promptItems.findIndex((it) => it.value === cfg.prompt);
			if (idx >= 0) promptsSelect.setSelectedIndex(idx);
		}
		promptsSelect.onSelect = (item) => {
			cfg.prompt = item.value;
			saveConfig();
			tui.requestRender();
		};

		// --- pravý sloupec, záložka Nastavení -------------------------------
		const timeoutLabels = TIMEOUT_CHOICES.map((ms) => formatTimeout(Number(ms)));
		const settingItems: SettingItem[] = [
			{
				id: "enabled",
				label: "Watchdog",
				description: "Zapnout/vypnout démona",
				currentValue: cfg.enabled ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "mode",
				label: "Režim",
				description: "smart = LLM směrování, simple = vždy jen nudge",
				currentValue: cfg.mode,
				values: ["smart", "simple"],
			},
			{
				id: "max",
				label: "Max. počet zásahů",
				description: "0 = bez limitu",
				currentValue: String(cfg.max),
				values: ["0", "3", "5", "10", "20", "50"],
			},
			{
				id: "timeout",
				label: "Timeout kontroly",
				description: "jak dlouho smí běžet child pi při generování nasměrování",
				currentValue: formatTimeout(cfg.timeout),
				values: timeoutLabels,
			},
		];
		const settingsList = new SettingsList(
			settingItems,
			settingItems.length + 2,
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === "enabled") cfg.enabled = newValue === "on";
				else if (id === "mode") cfg.mode = newValue as WatchdogMode;
				else if (id === "max") cfg.max = Number(newValue) || 0;
				else if (id === "timeout") cfg.timeout = parseTimeout(newValue);
				saveConfig();
				refreshStatus(ctx);
				tui.requestRender();
			},
			() => {
				/* Esc řeší naše handleInput */
			},
		);

		// --- stav -----------------------------------------------------------
		let focus: "models" | "right" = "models";
		let rightTab: "prompts" | "settings" = "prompts";

		function render(width: number): string[] {
			const w = Math.max(40, width);
			const gap = " │ ";
			const leftW = Math.max(22, Math.floor(w * 0.4));
			const rightW = Math.max(18, w - leftW - visibleWidth(gap));

			const out: string[] = [];

			// nadpis
			out.push(theme.fg("accent", theme.bold("🐕  pi-watchdog")));
			out.push("");

			// hlavičky sloupců
			const leftHead =
				(focus === "models" ? theme.fg("accent", "▸ ") : "  ") +
				theme.fg(focus === "models" ? "text" : "muted", "Modely (mirror pi)");
			const tabStyle = (label: string, active: boolean) =>
				active
					? theme.bg("selectedBg", theme.fg("text", ` ${label} `))
					: theme.fg("muted", ` ${label} `);
			const rightHead =
				tabStyle("Prompty", rightTab === "prompts") +
				" " +
				tabStyle("Nastavení", rightTab === "settings");
			out.push(joinCols(leftHead, rightHead, leftW, rightW, theme, gap));

			// obsah sloupců
			const leftLines = modelsSelect.render(leftW);
			const rightComp = rightTab === "prompts" ? promptsSelect : settingsList;
			const rightLines = rightComp.render(rightW);
			const rows = Math.max(leftLines.length, rightLines.length);
			for (let i = 0; i < rows; i++) {
				out.push(
					joinCols(leftLines[i] ?? "", rightLines[i] ?? "", leftW, rightW, theme, gap),
				);
			}

			out.push("");
			out.push(
				theme.fg(
					"dim",
					"←→ panel • Tab záložka • ↑↓ výběr • Enter potvrdit • Esc zavřít",
				),
			);
			return out;
		}

		function joinCols(
			left: string,
			right: string,
			leftW: number,
			rightW: number,
			theme: any,
			gap: string,
		): string {
			return (
				padLine(left, leftW) +
				theme.fg("dim", gap) +
				truncateToWidth(right, rightW)
			);
		}

		function padLine(line: string, width: number): string {
			const vis = visibleWidth(line);
			if (vis > width) return truncateToWidth(line, width);
			return line + " ".repeat(width - vis);
		}

		function handleInput(data: string) {
			if (matchesKey(data, Key.escape)) {
				done(undefined);
				return;
			}
			if (matchesKey(data, Key.tab)) {
				rightTab = rightTab === "prompts" ? "settings" : "prompts";
				focus = "right";
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.left)) {
				focus = "models";
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.right)) {
				focus = "right";
				tui.requestRender();
				return;
			}
			if (focus === "models") modelsSelect.handleInput(data);
			else if (rightTab === "prompts") promptsSelect.handleInput(data);
			else settingsList.handleInput(data);
			tui.requestRender();
		}

		return {
			render,
			invalidate: () => {
				modelsSelect.invalidate();
				promptsSelect.invalidate();
				settingsList.invalidate();
			},
			handleInput,
		};
	}

	pi.registerCommand("watchdog", {
		description: "Nastavení watchdogu (modely, prompty, on/off, režim, max, timeout)",
		handler: async (_args, ctx: any) => {
			if (ctx.mode !== "tui") {
				const skills = loadPromptSkills(promptsDir());
				ctx.ui.notify(
					`watchdog: ${cfg.enabled ? "on" : "off"}, mode=${cfg.mode}, model=${cfg.model}, max=${cfg.max}, timeout=${formatTimeout(cfg.timeout)}, prompt=${cfg.prompt || "(vestavěný)"}, promptů=${skills.length}`,
					"info",
				);
				return;
			}
			const models = listModels(ctx);
			const skills = loadPromptSkills(promptsDir());
			await ctx.ui.custom(
				(tui: any, theme: any, _kb: any, done: (v: unknown) => void) =>
					buildOverlay(ctx, tui, theme, done, models, skills),
				{ overlay: true, overlayOptions: { width: "88%", maxHeight: "85%" } },
			);
		},
	});

	// ---- životní cyklus ---------------------------------------------------

	// Agent doběhl a sám nebude pokračovat → vezmi fakta TEĎ a rozhodni se.
	pi.on("agent_settled", async (_event, ctx) => {
		const facts = collectFacts(ctx);
		if (!facts) return; // ctx je nedostupný (reload / zavírání session)
		const models = listModels(ctx);
		setTimeout(() => {
			void fire(facts, models);
		}, 150);
	});

	pi.on("session_start", async (_event, ctx: any) => {
		try {
			cfg = loadConfigFromEntries(ctx?.sessionManager?.getEntries?.() ?? []);
		} catch {
			cfg = { ...DEFAULT_CONFIG };
		}
		count = 0; // nová session → nový rozpočet zásahů
		refreshStatus(ctx);
	});
}