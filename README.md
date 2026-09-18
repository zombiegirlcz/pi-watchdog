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

Příkaz `/watchdog` otevře overlay okno (SettingsList), kde se nastavuje:

| Položka | Hodnoty |
|---|---|
| Watchdog | on / off |
| Režim | smart / simple |
| Model pro směrování | `deepseek-free/deepseek-reasoner`, `deepseek-free/deepseek-chat`, `qwen-free/qwen3-coder` |
| Max. počet zásahů | 0 (∞), 3, 5, 10, 20, 50 |

Nastavení se ukládá do session (`pi-watchdog-config` entry) a přežije reload/resume.
Stav je vidět v patičce jako `🐕 watchdog`.

## Jak funguje chytré směrování

Child příkaz (má **plné tools**, takže si smí stav ověřit přes `read`/`bash`):

```bash
PI_WATCHDOG_CHILD=1 pi -p "$(cat /tmp/watchdog-*.prompt.txt)" \
  @/tmp/watchdog-*.jsonl --model deepseek-free/deepseek-reasoner --no-session
```

- `PI_WATCHDOG_CHILD=1` → v child procesu se watchdog znovu **nenačte** (žádná rekurze).
- `--no-session` → child session se neukládá.
- Export session se po použití smaže.

Watchdog prompt (mini prompt pro child `pi`) říká:
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
npm test        # 23 testů (čistá logika v lib/watchdog-core.ts)
```

Struktura:
- `extensions/pi-watchdog.ts` — démon + `/watchdog` okno
- `lib/watchdog-core.ts` — čistá, testovatelná logika (decide, lastIsError, lastWasWatchdog, buildChildCommand, …)
- `test/watchdog.test.mjs` — node:test sada

## Licence

MIT