import { test } from "node:test";
import assert from "node:assert/strict";
import {
	decide,
	lastIsError,
	lastWasWatchdog,
	buildChildCommand,
	shellQuote,
	GUIDANCE_PROMPT,
	DEFAULT_CONFIG,
	MODEL_CHOICES,
	loadConfigFromEntries,
	CONFIG_TYPE,
} from "../lib/watchdog-core.ts";

const msg = (message) => ({ type: "message", message });
const cfgEntry = (data) => ({ type: "custom", customType: CONFIG_TYPE, data });

test("lastIsError: prázdná session není chyba", () => {
	assert.equal(lastIsError([]), false);
});

test("lastIsError: úspěšná assistant odpověď není chyba", () => {
	assert.equal(lastIsError([msg({ role: "assistant", stopReason: "stop" })]), false);
});

test("lastIsError: assistant stopReason=error je chyba", () => {
	assert.equal(lastIsError([msg({ role: "assistant", stopReason: "error" })]), true);
});

test("lastIsError: assistant stopReason=aborted je chyba", () => {
	assert.equal(lastIsError([msg({ role: "assistant", stopReason: "aborted" })]), true);
});

test("lastIsError: toolResult.isError je chyba", () => {
	assert.equal(lastIsError([msg({ role: "toolResult", isError: true })]), true);
	assert.equal(lastIsError([msg({ role: "toolResult", isError: false })]), false);
});

test("lastIsError: uživatel bez odpovědi = chyba/abort", () => {
	assert.equal(lastIsError([msg({ role: "user" })]), true);
});

test("lastIsError: vlastní zprávy se přeskakují", () => {
	assert.equal(
		lastIsError([
			msg({ role: "assistant", stopReason: "stop" }),
			msg({ role: "custom", customType: "pi-watchdog", content: "..." }),
		]),
		false,
	);
});

test("lastWasWatchdog: naše guidance = true", () => {
	assert.equal(lastWasWatchdog([msg({ role: "custom", customType: "pi-watchdog-guidance" })]), true);
});

test("lastWasWatchdog: skutečný uživatel po naší guidance = false", () => {
	assert.equal(
		lastWasWatchdog([
			msg({ role: "custom", customType: "pi-watchdog-guidance" }),
			msg({ role: "assistant", stopReason: "stop" }),
			msg({ role: "user" }),
		]),
		false,
	);
});

test("decide: chyba → jen dots (žádné volání LLM)", () => {
	assert.equal(
		decide({ enabled: true, mode: "smart", count: 0, max: 20, running: false, isError: true, lastWasWatchdog: false }),
		"dots",
	);
});

test("decide: dokončená práce → guidance", () => {
	assert.equal(
		decide({ enabled: true, mode: "smart", count: 0, max: 20, running: false, isError: false, lastWasWatchdog: false }),
		"guidance",
	);
});

test("decide: předchozí tah byl watchdog → dots (ochrana proti smyčce)", () => {
	assert.equal(
		decide({ enabled: true, mode: "smart", count: 1, max: 20, running: false, isError: false, lastWasWatchdog: true }),
		"dots",
	);
});

test("decide: enabled=false → none", () => {
	assert.equal(
		decide({ enabled: false, mode: "smart", count: 0, max: 20, running: false, isError: false, lastWasWatchdog: false }),
		"none",
	);
});

test("decide: mode=simple → dots", () => {
	assert.equal(
		decide({ enabled: true, mode: "simple", count: 0, max: 20, running: false, isError: false, lastWasWatchdog: false }),
		"dots",
	);
});

test("decide: running → none", () => {
	assert.equal(
		decide({ enabled: true, mode: "smart", count: 0, max: 20, running: true, isError: false, lastWasWatchdog: false }),
		"none",
	);
});

test("decide: max dosažen → none", () => {
	assert.equal(
		decide({ enabled: true, mode: "smart", count: 20, max: 20, running: false, isError: false, lastWasWatchdog: false }),
		"none",
	);
});

test("decide: max=0 = bez limitu → guidance i při vysokém countu", () => {
	assert.equal(
		decide({ enabled: true, mode: "smart", count: 999, max: 0, running: false, isError: false, lastWasWatchdog: false }),
		"guidance",
	);
});

test("shellQuote: bezpečně zacituje uvozovky", () => {
	assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("buildChildCommand: child MÁ tools (žádné --no-tools/--no-extensions)", () => {
	const cmd = buildChildCommand({
		promptPath: "/tmp/p.txt",
		exportPath: "/tmp/w.jsonl",
		model: "deepseek-free/deepseek-reasoner",
	});
	assert.match(cmd, /^PI_WATCHDOG_CHILD=1 pi /);
	assert.match(cmd, /@'\/tmp\/w\.jsonl'/);
	assert.match(cmd, /--model 'deepseek-free\/deepseek-reasoner'/);
	assert.match(cmd, /--no-session/);
	assert.match(cmd, /cat '\/tmp\/p\.txt'/);
	assert.doesNotMatch(cmd, /--no-tools/);
	assert.doesNotMatch(cmd, /--no-extensions/);
});

test("GUIDANCE_PROMPT obsahuje bezpečnostní a testovací pravidla + ověření", () => {
	assert.match(GUIDANCE_PROMPT, /TDD/);
	assert.match(GUIDANCE_PROMPT, /bezpečnostní/);
	assert.match(GUIDANCE_PROMPT, /ověřit/);
});

test("DEFAULT_CONFIG je rozumný", () => {
	assert.equal(DEFAULT_CONFIG.enabled, true);
	assert.equal(DEFAULT_CONFIG.mode, "smart");
	assert.equal(DEFAULT_CONFIG.max, 20);
	assert.ok(MODEL_CHOICES.includes(DEFAULT_CONFIG.model));
});

test("loadConfigFromEntries: prázdné → default", () => {
	assert.deepEqual(loadConfigFromEntries([]), DEFAULT_CONFIG);
});

test("loadConfigFromEntries: poslední config vyhrává a merguje se", () => {
	const cfg = loadConfigFromEntries([
		cfgEntry({ enabled: false }),
		cfgEntry({ mode: "simple", max: 5 }),
	]);
	assert.equal(cfg.enabled, false);
	assert.equal(cfg.mode, "simple");
	assert.equal(cfg.max, 5);
	assert.equal(cfg.model, DEFAULT_CONFIG.model);
});