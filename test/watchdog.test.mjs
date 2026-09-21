import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
	parseSkillFrontmatter,
	stripFrontmatter,
	pickSkillDirs,
	choosePromptText,
	formatModelValue,
	sortModels,
	groupModelsByProvider,
	tailByChars,
	isShimError,
	MAX_EXPORT_CHARS,
	loadPromptSkills,
	readPromptBody,
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

// ---- nové: prompt skills + mirror modelů -----------------------------------

test("DEFAULT_CONFIG má prompt = prázdný (vestavěný prompt)", () => {
	assert.equal(DEFAULT_CONFIG.prompt, "");
});

test("loadConfigFromEntries: umí načíst volbu promptu", () => {
	const cfg = loadConfigFromEntries([cfgEntry({ prompt: "kali-audit" })]);
	assert.equal(cfg.prompt, "kali-audit");
});

test("parseSkillFrontmatter: name + description ze SKILL.md", () => {
	const fm = parseSkillFrontmatter(
		["---", "name: kali-audit", "description: Hlídá bezpečnostní audit", "---", "", "Tělo"].join(
			"\n",
		),
	);
	assert.equal(fm.name, "kali-audit");
	assert.equal(fm.description, "Hlídá bezpečnostní audit");
});

test("parseSkillFrontmatter: uvozovky se odstraní", () => {
	const fm = parseSkillFrontmatter('---\nname: "x"\ndescription: \'y z\'\n---\n');
	assert.equal(fm.name, "x");
	assert.equal(fm.description, "y z");
});

test("parseSkillFrontmatter: bez frontmatteru vrátí prázdno", () => {
	assert.deepEqual(parseSkillFrontmatter("# Jen nadpis"), {});
});

test("stripFrontmatter: vrátí jen tělo bez --- bloku", () => {
	const body = stripFrontmatter("---\nname: a\ndescription: b\n---\n\nTělo promptu\nřádek 2");
	assert.equal(body, "Tělo promptu\nřádek 2");
});

test("stripFrontmatter: bez frontmatteru vrátí ořezaný text", () => {
	assert.equal(stripFrontmatter("\n  Tělo  \n"), "Tělo");
});

test("pickSkillDirs: vyhodí skryté a seřadí", () => {
	assert.deepEqual(pickSkillDirs(["b", "a", ".git", ".DS_Store"]), ["a", "b"]);
});

test("choosePromptText: custom tělo vyhraje, jinak vestavěný", () => {
	assert.equal(choosePromptText("BUILTIN", "  vlastni  "), "vlastni");
	assert.equal(choosePromptText("BUILTIN", ""), "BUILTIN");
	assert.equal(choosePromptText("BUILTIN", null), "BUILTIN");
});

test("formatModelValue: provider/id", () => {
	assert.equal(formatModelValue({ provider: "deepseek-free", id: "deepseek-reasoner" }), "deepseek-free/deepseek-reasoner");
});

test("sortModels: podle providera pak id", () => {
	const sorted = sortModels([
		{ provider: "b", id: "x" },
		{ provider: "a", id: "z" },
		{ provider: "a", id: "a" },
	]);
	assert.deepEqual(
		sorted.map((m) => `${m.provider}/${m.id}`),
		["a/a", "a/z", "b/x"],
	);
});

test("groupModelsByProvider: seskupí a seřadí", () => {
	const groups = groupModelsByProvider([
		{ provider: "b", id: "1" },
		{ provider: "a", id: "2" },
		{ provider: "a", id: "1" },
	]);
	assert.deepEqual(
		groups.map((g) => g.provider),
		["a", "b"],
	);
	assert.deepEqual(
		groups[0].models.map((m) => m.id),
		["1", "2"],
	);
});

// ---- nové: ohraničení exportu + detekce shim chyby ------------------------

test("tailByChars: krátký text vrátí celý", () => {
	assert.equal(tailByChars("a\nb\nc", 100), "a\nb\nc\n");
});

test("tailByChars: drží se od konce a jen celé řádky", () => {
	const out = tailByChars("aaaa\nbbbb\ncccc", 10);
	assert.equal(out, "bbbb\ncccc\n");
});

test("tailByChars: přeskočí obří řádek (tool output) a vezme menší starší", () => {
	const big = "x".repeat(1000);
	const out = tailByChars(`maly1\n${big}\nmaly2`, 50);
	assert.equal(out, "maly1\nmaly2\n");
});

test("tailByChars: prázdný vstup → prázdný výstup", () => {
	assert.equal(tailByChars("", 100), "");
	assert.equal(tailByChars("\n\n", 100), "");
});

test("MAX_EXPORT_CHARS je rozumný a menší než limit shimu", () => {
	assert.ok(MAX_EXPORT_CHARS > 0);
	assert.ok(MAX_EXPORT_CHARS <= 400000);
});

test("isShimError: rozpozná chybu shimu (limit délky)", () => {
	assert.equal(
		isShimError("[CHYBA SHIMU: chat/completion: Dosažen limit délky. Začněte nový chat. — není to odpověď modelu]"),
		true,
	);
});

test("isShimError: rozpozná prázdnou odpověď", () => {
	assert.equal(isShimError("[chyba: chat/completion: prazdna odpoved (zadne data:)]"), true);
});

test("isShimError: normální guidance není chyba", () => {
	assert.equal(isShimError("Dokonči testy a pak commitni."), false);
	assert.equal(isShimError("..."), false);
	assert.equal(isShimError(""), false);
});

// ---- nové: ověření přepínání reálných promptů ---------------------------

test("reálné prompty: každý skill vrací své tělo, ne GUIDANCE_PROMPT", () => {
	const promptsDir = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"prompts",
	);
	if (!fs.existsSync(promptsDir)) {
		// skip if no prompts dir
		return;
	}

	const skillDirs = pickSkillDirs(fs.readdirSync(promptsDir));
	assert.ok(skillDirs.length > 0, "měl by existovat alespoň jeden skill v prompts/");

	for (const dir of skillDirs) {
		const skillPath = path.join(promptsDir, dir, "SKILL.md");
		if (!fs.existsSync(skillPath)) continue;

		const text = fs.readFileSync(skillPath, "utf-8");
		const body = stripFrontmatter(text);
		const result = choosePromptText(GUIDANCE_PROMPT, body);

		assert.ok(
			body.length > 0,
			`skill '${dir}' by měl mít neprázdné tělo po stripFrontmatter`,
		);

		assert.ok(
			result !== GUIDANCE_PROMPT,
			`skill '${dir}' by měl vracet své tělo, ne GUIDANCE_PROMPT (tělo má ${body.length} znaků)`,
		);

		assert.equal(
			result,
			body,
			`skill '${dir}' by měl vracet přesně své tělo`,
		);
	}
});

test("přepínání promptů: cfg.prompt='elf' a 'security-audit' vrací různá těla", () => {
	const promptsDir = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"prompts",
	);
	if (!fs.existsSync(promptsDir)) {
		// skip if no prompts dir
		return;
	}

	const skills = loadPromptSkills(promptsDir);
	assert.ok(skills.length >= 2, "měly by existovat alespoň 2 skilly pro test přepínání");

	const elfBody = readPromptBody(skills, "elf");
	const securityBody = readPromptBody(skills, "security-audit");

	assert.ok(elfBody, "elf by měl mít tělo (readPromptBody nevrátil null)");
	assert.ok(securityBody, "security-audit by měl mít tělo (readPromptBody nevrátil null)");

	assert.ok(elfBody.length > 0, "elf by měl mít neprázdné tělo");
	assert.ok(securityBody.length > 0, "security-audit by měl mít neprázdné tělo");

	// Ověření, že výstupem je právě tělo skillu (ne GUIDANCE_PROMPT)
	assert.notEqual(
		elfBody,
		GUIDANCE_PROMPT,
		"elf nesmí vracet GUIDANCE_PROMPT (měl by vracet své vlastní tělo)",
	);
	assert.notEqual(
		securityBody,
		GUIDANCE_PROMPT,
		"security-audit nesmí vracet GUIDANCE_PROMPT (měl by vracet své vlastní tělo)",
	);

	// Ověření, že se prompty liší navzájem
	assert.notEqual(
		elfBody,
		securityBody,
		"elf a security-audit musí vracet různá těla (přepínání musí fungovat)",
	);

	// Ověření, že choosePromptText vrací tělo skillu (ne fallback na builtin)
	const elfResult = choosePromptText(GUIDANCE_PROMPT, elfBody);
	const securityResult = choosePromptText(GUIDANCE_PROMPT, securityBody);

	assert.equal(
		elfResult,
		elfBody,
		"choosePromptText by měl vracet elf tělo, ne GUIDANCE_PROMPT",
	);
	assert.equal(
		securityResult,
		securityBody,
		"choosePromptText by měl vracet security-audit tělo, ne GUIDANCE_PROMPT",
	);
});