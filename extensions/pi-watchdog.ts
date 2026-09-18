/**
 * pi-watchdog — démon, který hlídá, že se pi nezastavil.
 *
 * Kdykoli se agent usadí (agent_settled), vyhodnotí stav:
 *
 *   • poslední zpráva je CHYBA (error / aborted / toolResult.isError)
 *       → jen zapíše "..." do chatu. LLM se nevolá.
 *
 *   • poslední zpráva je DOKONČENÁ PRÁCE / čekání na směr
 *       → vyexportuje aktuální session do /tmp/watchdog-*.jsonl,
 *         spustí child `pi -p "<watchdog prompt>" @export --model <model> --no-session`,
 *         získá konkrétní nasměrování (child MÁ plné tools, takže si stav může ověřit),
 *         a předá ho agentovi jako zprávu s triggerTurn (probudí ho).
 *
 * Nastavení se dělá v TUI: příkaz `/watchdog` otevře okno s nastavením
 * (on/off, režim, model, max. počet zásahů). Ukládá se do session.
 *
 * Smyčka je omezená: pokud předchozí tah spustil watchdog (naše guidance),
 * další settle už jen zapíše "..." a nic nevolá.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import {
	CHILD_ENV,
	CONFIG_TYPE,
	DEFAULT_CONFIG,
	GUIDANCE_PROMPT,
	MODEL_CHOICES,
	buildChildCommand,
	decide,
	lastIsError,
	lastWasWatchdog,
	loadConfigFromEntries,
	type WatchdogConfig,
	type WatchdogMode,
} from "../lib/watchdog-core.ts";

export * from "../lib/watchdog-core.ts";

export default function (pi: ExtensionAPI) {
	// Child pi (spouštěný watchdogem) démona nenačítá → žádná rekurze.
	if (process.env[CHILD_ENV] === "1") return;

	let cfg: WatchdogConfig = { ...DEFAULT_CONFIG };
	let count = 0;
	let running = false;

	function saveConfig() {
		pi.appendEntry(CONFIG_TYPE, { ...cfg });
	}

	function sendDots() {
		try {
			pi.sendMessage({ customType: "pi-watchdog", content: "...", display: true }, {});
		} catch {
			/* když ani tohle nejde, tiše pokračuj */
		}
	}

	function sendGuidance(text: string) {
		try {
			pi.sendMessage(
				{ customType: "pi-watchdog-guidance", content: text, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			sendDots();
		}
	}

	function cleanup(p: string) {
		try {
			fs.unlinkSync(p);
		} catch {
			/* ignore */
		}
	}

	async function generateGuidance(ctx: any): Promise<string | null> {
		const sessionFile: string | undefined = ctx?.sessionManager?.getSessionFile?.();
		if (!sessionFile || !fs.existsSync(sessionFile)) return null;

		const stamp = `${Date.now()}-${process.pid}`;
		const exportPath = path.join(os.tmpdir(), `watchdog-${stamp}.jsonl`);
		const promptPath = path.join(os.tmpdir(), `watchdog-${stamp}.prompt.txt`);
		try {
			fs.copyFileSync(sessionFile, exportPath);
			fs.writeFileSync(promptPath, GUIDANCE_PROMPT, "utf-8");
		} catch {
			cleanup(exportPath);
			cleanup(promptPath);
			return null;
		}

		try {
			const res = await (pi as any).exec(
				"bash",
				["-c", buildChildCommand({ promptPath, exportPath, model: cfg.model })],
				{ timeout: 180000 },
			);
			if (res?.code !== 0) return null;
			const out = String(res?.stdout ?? "").trim();
			return out.length > 0 ? out : null;
		} catch {
			return null;
		} finally {
			cleanup(exportPath);
			cleanup(promptPath);
		}
	}

	async function fire(ctx: any) {
		if (running) return;
		let entries: any[] = [];
		try {
			entries = ctx?.sessionManager?.getEntries?.() ?? [];
		} catch {
			entries = [];
		}
		const action = decide({
			enabled: cfg.enabled,
			mode: cfg.mode,
			count,
			max: cfg.max,
			running,
			isError: lastIsError(entries),
			lastWasWatchdog: lastWasWatchdog(entries),
		});
		if (action === "none") return;

		running = true;
		count++;
		try {
			if (action === "dots") {
				sendDots();
				return;
			}
			const guidance = await generateGuidance(ctx);
			if (guidance && guidance.trim() !== "...") {
				sendGuidance(guidance.trim());
			} else {
				sendDots();
			}
		} finally {
			running = false;
		}
	}

	// ---- TUI nastavení přes /watchdog -------------------------------------

	function buildSettingsComponent(ctx: any, done: (v: unknown) => void, tui: any) {
		const items: SettingItem[] = [
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
				description: "smart = LLM směrování, simple = vždy jen '...'",
				currentValue: cfg.mode,
				values: ["smart", "simple"],
			},
			{
				id: "model",
				label: "Model pro směrování",
				description: "Kterým modelem se generuje nasměrování",
				currentValue: cfg.model,
				values: MODEL_CHOICES,
			},
			{
				id: "max",
				label: "Max. počet zásahů",
				description: "0 = bez limitu",
				currentValue: String(cfg.max),
				values: ["0", "3", "5", "10", "20", "50"],
			},
		];

		const container = new Container();
		container.addChild(new Text("🐕  pi-watchdog", 1, 1));
		const list = new SettingsList(
			items,
			items.length + 2,
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === "enabled") cfg.enabled = newValue === "on";
				else if (id === "mode") cfg.mode = newValue as WatchdogMode;
				else if (id === "model") cfg.model = newValue;
				else if (id === "max") cfg.max = Number(newValue) || 0;
				saveConfig();
				if (ctx.hasUI) {
					ctx.ui.setStatus(
						"pi-watchdog",
						cfg.enabled ? ctx.ui.theme.fg("accent", "🐕 watchdog") : undefined,
					);
				}
			},
			() => done(undefined),
		);
		container.addChild(list);
		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput?.(data);
				tui.requestRender();
			},
		};
	}

	pi.registerCommand("watchdog", {
		description: "Nastavení watchdogu (on/off, režim, model, max)",
		handler: async (_args, ctx: any) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					`watchdog: ${cfg.enabled ? "on" : "off"}, mode=${cfg.mode}, model=${cfg.model}, max=${cfg.max}`,
					"info",
				);
				return;
			}
			await ctx.ui.custom(
				(tui: any, _theme: any, _kb: any, done: (v: unknown) => void) =>
					buildSettingsComponent(ctx, done, tui),
				{ overlay: true, overlayOptions: { width: "70%", maxHeight: "80%" } },
			);
		},
	});

	// ---- životní cyklus ---------------------------------------------------

	// Agent doběhl a sám nebude pokračovat → rozhodni se (lehce odloženo)
	pi.on("agent_settled", async (_event, ctx) => {
		setTimeout(() => {
			void fire(ctx);
		}, 150);
	});

	pi.on("session_start", async (_event, ctx: any) => {
		try {
			cfg = loadConfigFromEntries(ctx?.sessionManager?.getEntries?.() ?? []);
		} catch {
			cfg = { ...DEFAULT_CONFIG };
		}
		if (ctx?.hasUI) {
			ctx.ui.setStatus(
				"pi-watchdog",
				cfg.enabled ? ctx.ui.theme.fg("accent", "🐕 watchdog") : undefined,
			);
		}
	});
}