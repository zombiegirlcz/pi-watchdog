# pi-watchdog

Watchdog daemon pro [pi](https://pi.dev). Hlídá, že se agent nezastavil, a když se usadí,
buď ho jen šťouchne `...`, nebo (v chytrém režimu) nechá child `pi` přečíst session a vrátí
agentovi konkrétní, bezpečnostně-uvědomé nasměrování.

## Instalace

```bash
pi install git:github.com/zombiegirlcz/pi-watchdog
```

Pak v běžícím pi spusť `/reload`.

## Co to dělá

Po každém `agent_settled` (agent doběhl a sám nebude pokračovat) watchdog rozhodne:

| Stav | Akce |
|---|---|
| Poslední zpráva je **chyba / abort / `toolResult.isError`** | zapíše `...` do chatu. **LLM se nevolá.** |
| Poslední zpráva je **dokončená práce / čekání na směr** | vyexportuje session, spustí child `pi` s watchdog promptem, vygeneruje nasměrování a předá ho agentovi se `triggerTurn` (probudí ho) |
| Předchozí tah spustil watchdog | jen `...` (ochrana proti smyčce) |

## Nastavení — `/watchdog`

Příkaz `/watchdog` otevře overlay okno, rozdělené na dva panely:

```
┌─ Modely (mirror pi) ──────────┐ │ ┌─ Prompty ── Nastavení ────────┐
│ ▸ deepseek-reasoner           │ │ │  (vestavěný prompt)            │
│   deepseek-chat               │ │ │  security-audit                │
│   qwen3-coder                 │ │ │  ...                           │
│   …všechny modely, které pi   │ │ │                                │
│   zná (provider/id)           │ │ │                                │
└───────────────────────────────┘ │ └────────────────────────────────┘
   ←→ panel • Tab záložka • ↑↓ výběr • Enter potvrdit • Esc zavřít
```

| Panel | Obsah |
|---|---|
| **Vlevo** | Mirror pi modelů — úplně stejný seznam, jaký zná pi (`ctx.modelRegistry`). Enter nastaví model pro směrování. |
| **Vpravo / Prompty** | Uživatelské prompty ze složky [`prompts/`](#vlastní-prompty). Enter vybere prompt pro child `pi`. |
| **Vpravo / Nastavení** | on/off, režim (smart/simple), max. počet zásahů. |

Tab přepíná záložky v pravém panelu, `←`/`→` přepíná fokus mezi panely.

Nastavení (včetně zvoleného modelu a promptu) se ukládá do session
(`pi-watchdog-config` entry) a přežije reload/resume.
Stav je vidět v patičce jako `🐕 watchdog`.

## Vlastní prompty

Složka `prompts/` obsahuje uživatelské prompty ve **formátu skillu** — každý prompt je
složka s `SKILL.md`:

```
prompts/
└── security-audit/
    └── SKILL.md
```

`SKILL.md` má YAML frontmatter a tělo, které se pošle child `pi` jako systémový prompt:

```markdown
---
name: security-audit
description: Hlídá bezpečnostní a destruktivní operace — použij, když projekt pracuje s rootem, mounty nebo produkčními daty.
---

Jsi watchdog, který čte session log jiného agenta (pi)…

Pravidla:
- Než něco doporučíš, ověř si stav nástroji (read, bash) — netvrď naslepo.
- …
```

- `name` a `description` se zobrazí v záložce **Prompty** v `/watchdog`.
- Tělo (bez frontmatteru) se použije jako prompt pro child `pi`.
- Když není vybrán žádný vlastní prompt, použije se vestavěný `GUIDANCE_PROMPT`.
- Formát je kompatibilní se [Agent Skills standardem](https://agentskills.io/specification).

Přidání dalšího promptu = vytvořit `prompts/<nazev>/SKILL.md` a dát `/reload`.

## Jak funguje chytré směrování

Child příkaz (má **plné tools**, takže si smí stav ověřit přes `read`/`bash`):

```bash
PI_WATCHDOG_CHILD=1 pi -p "$(cat /tmp/watchdog-*.prompt.txt)" \
  @/tmp/watchdog-*.jsonl --model deepseek-free/deepseek-reasoner --no-session
```

- `PI_WATCHDOG_CHILD=1` → v child procesu se watchdog znovu **nenačte** (žádná rekurze).
- `--no-session` → child session se neukládá.
- Export session se po použití smaže.

Vestavěný watchdog prompt říká:
- jsi watchdog, čteš session log jiného agenta
- než něco doporučíš, **můžeš si stav ověřit** (read, bash) — ověřuj, netvrď naslepo
- vyber pro daný cíl a kontext **nejužitečnější** další krok
- upozorni na **testovací (TDD) a bezpečnostní pravidla**, pokud je agent porušuje
- max 3 věty, imperativ; když není co dodat, odpověz jen `...`

## Bezpečnost

- Rozšíření běží s plnými právy pi. Instaluj jen z důvěryhodných zdrojů.
- Child `pi` má plné tools — může číst a spouštět. To je záměr (aby si ověřil stav).
- Rekurze je vyloučena env guardem `PI_WATCHDOG_CHILD=1`.

## Vývoj

```bash
npm test        # 35 testů (čistá logika v lib/watchdog-core.ts)
```

Struktura:
- `extensions/pi-watchdog.ts` — démon + `/watchdog` okno (dva panely + záložky)
- `lib/watchdog-core.ts` — čistá, testovatelná logika (decide, lastIsError, lastWasWatchdog, buildChildCommand, parsování prompt-skills, model picker, …)
- `test/watchdog.test.mjs` — node:test sada
- `prompts/` — uživatelské prompty ve formátu skillu

## Licence

MIT