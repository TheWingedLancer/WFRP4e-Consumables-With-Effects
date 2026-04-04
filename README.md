# WFRP4e Consumable Effects

A Foundry VTT module for **Warhammer Fantasy Roleplay 4th Edition** that lets GMs create consumable food, drink, herb, and potion items with Active Effects — described in **plain English** rather than requiring knowledge of the WFRP4e effect data model.

## Features

- **Natural Language Effect Builder** — Type something like *"+10 Toughness and +5 Willpower for 5 rounds"* and the module generates the correct Active Effect changes automatically.
- **One-Click Consumption** — Players can consume items from their inventory. The module applies the Active Effect to their character, heals wounds if applicable, decrements quantity, and posts a chat message.
- **Derived Value Safety** — Automatically adds `calculationBonusModifier` offsets for Strength, Toughness, and Willpower to prevent temporary buffs from incorrectly changing Wounds (per Cubicle 7 FAQ).
- **Duration Tracking** — Specify duration in rounds and Foundry's built-in combat tracker handles expiration.
- **Healing Support** — "Heal 4 wounds" is supported alongside stat changes.
- **Movement Modifiers** — "+2 Movement" or "Reduce movement by 1" are supported.

---

## GitHub Setup & First Release

Follow these steps to push this module to GitHub and make it installable from FoundryVTT.

### 1. Create the GitHub Repository

```bash
# Navigate into the module folder
cd wfrp4e-consumables-with-effects

# Initialise git
git init
git branch -M main

# Create the repo on GitHub (using the gh CLI, or do it manually on github.com)
gh repo create TheWingedLancer/wfrp4e-consumables-with-effects --public --source=. --remote=origin

# Or if you created the repo manually on github.com:
git remote add origin https://github.com/TheWingedLancer/wfrp4e-consumables-with-effects.git
```

### 2. Replace TheWingedLancer in module.json

Open `module.json` and replace every instance of `TheWingedLancer` with your actual GitHub username. There are three URLs to update:

```json
"url":      "https://github.com/TheWingedLancer/wfrp4e-consumables-with-effects",
"manifest": "https://github.com/TheWingedLancer/wfrp4e-consumables-with-effects/releases/latest/download/module.json",
"download": "https://github.com/TheWingedLancer/wfrp4e-consumables-with-effects/releases/download/v1.0.0/wfrp4e-consumables-with-effects-v1.0.0.zip"
```

> **Note:** The GitHub Actions workflow (`.github/workflows/release.yml`) automatically rewrites the `download` and `manifest` URLs at release time using your repo name, so the values in the committed `module.json` are templates — but `url` should always be correct.

### 3. Push and Tag a Release

```bash
# Stage and commit all files
git add .
git commit -m "Initial release v1.0.0"

# Push to GitHub
git push -u origin main

# Create and push a version tag — this triggers the GitHub Actions workflow
git tag v1.0.0
git push origin v1.0.0
```

The GitHub Actions workflow (`.github/workflows/release.yml`) will automatically:
1. Rewrite `module.json` with the correct download/manifest URLs for this release
2. Package the module into `wfrp4e-consumables-with-effects-v1.0.0.zip`
3. Create a GitHub Release with both the zip and the updated `module.json` attached

### 4. Verify the Release

Go to `https://github.com/TheWingedLancer/wfrp4e-consumables-with-effects/releases` and confirm:
- A release named **WFRP4e Consumable Effects v1.0.0** exists
- It has two assets: `module.json` and `wfrp4e-consumables-with-effects-v1.0.0.zip`

---

## Installing in FoundryVTT from the Manifest

1. In Foundry, go to **Add-on Modules → Install Module**
2. Paste this URL into the **Manifest URL** box at the bottom:

```
https://github.com/TheWingedLancer/wfrp4e-consumables-with-effects/releases/latest/download/module.json
```

3. Click **Install**
4. In your WFRP4e world, go to **Settings → Manage Modules** and enable **WFRP4e Consumable Effects**

### How Manifest Installation Works

Foundry reads the `module.json` at the manifest URL. Inside it, the `download` field points to the `.zip` file in the same GitHub Release. Foundry downloads that zip, extracts it (expecting a folder named `wfrp4e-consumables-with-effects` inside), and copies it into `{userData}/Data/modules/`.

For future updates, Foundry checks the `manifest` URL for a newer `version` field and offers the user an update.

### Manual Installation (Alternative)

Download the zip from the Releases page, extract it into `{userData}/Data/modules/`, and restart Foundry.

---

## Usage

### Creating a Consumable (GM Only)

1. Open the **Items Directory** tab in the sidebar
2. Click the **🍴 Create Consumable** button in the header
3. Fill in the item name, description, quantity, and encumbrance
4. In the **"Describe the effect"** box, type what you want the item to do
5. Click **Generate** to preview the parsed effect
6. Click **Save Item** to create the item in your world

### Natural Language Examples

| You Type | What Gets Created |
|---|---|
| `+10 Toughness for 5 rounds` | Toughness modifier +10, duration 5 rounds, with derived offset |
| `Add 20 to Weapon Skill and +10 Fellowship for 10 rounds` | WS +20, Fel +10, 10-round duration |
| `Heal 4 wounds` | Restores 4 wounds on consumption (no stat effect) |
| `+15 Strength and heal 2 wounds for 3 rounds` | S +15 for 3 rounds + heals 2 wounds |
| `Decrease Initiative by 10` | Initiative modifier −10 (permanent until removed) |
| `+2 Movement for 5 rounds` | Movement value +2 for 5 rounds |
| `Reduce movement by 1` | Movement value −1 (permanent until removed) |

### Consuming an Item (Players & GMs)

**From the Item Sheet:** Open the consumable item on the character sheet → click the **🍗 Consume** button.

**From the Item Directory (GM):** Right-click a consumable item → **Consume** (requires a selected token).

**Via Macro / API:**
```javascript
const api = game.modules.get("wfrp4e-consumables-with-effects")?.api;
const actor = canvas.tokens.controlled[0]?.actor;
const item = actor?.items.find(i => i.name === "Hearty Stew");
if (api && actor && item) await api.consumeItem(actor, item);
```

### Keyboard Shortcut

Press **Ctrl+Shift+F** to open the Consumable Creator dialog (GM only, rebindable in **Settings → Configure Controls**).

---

## Module Architecture

```
wfrp4e-consumables-with-effects/
├── .github/workflows/release.yml   ← GitHub Actions: auto-package on tag push
├── module.json                      ← FoundryVTT manifest (id, compatibility, paths)
├── scripts/
│   └── module.js                    ← All module logic (§1-§5, see below)
├── styles/
│   └── module.css                   ← WFRP-themed styling for dialog & chat cards
├── templates/
│   └── creator.html                 ← Handlebars template for the creator dialog
├── lang/
│   └── en.json                      ← English localisation strings
├── LICENSE                          ← MIT
└── README.md
```

### Code Sections (scripts/module.js)

The main script is divided into five clearly-commented sections:

| Section | Purpose |
|---|---|
| **§1 Constants** | `CHARACTERISTIC_MAP`, `CHARACTERISTIC_LABELS`, `DERIVED_CHARACTERISTICS` — lookup tables mapping English words to WFRP4e data paths |
| **§2 Natural Language Parser** | `parseNaturalLanguage(input)` — regex-based parser that converts English to ActiveEffect changes |
| **§3 Creator Application** | `ConsumableCreatorApp` — a `FormApplication` subclass providing the GM dialog |
| **§4 Consume Logic** | `consumeItem(actor, item)` — copies effects to actor, heals, decrements qty, posts chat |
| **§5 Hooks** | Lifecycle integration: init, ready, renderItemDirectory, renderItemSheet, context menus |

### How It Works (Technical)

1. **Item Creation**: Creates a standard WFRP4e `trapping` item with `trappingType: "foodAndDrink"` (or drug/herb variant). Module-specific data is stored in `item.flags["wfrp4e-consumables-with-effects"]`.

2. **Effect Storage**: An `ActiveEffect` is created as an embedded document on the Item using `item.createEmbeddedDocuments("ActiveEffect", [...])`. The effect's `transfer` property is `false` — we handle transfer manually.

3. **Consumption**: When consumed, the effect is copied from the Item to the Actor using `effect.toObject()` → `actor.createEmbeddedDocuments("ActiveEffect", [...])`. The `origin` is set to the item's UUID for tracking. Quantity is decremented via `item.update()` or the item is deleted via `item.delete()`.

4. **Derived Value Offsets**: For characteristics that feed into Wounds (S, T, WP), the parser adds a `calculationBonusModifier` change that offsets the bonus change, preventing temporary effects from altering Wounds per the Cubicle 7 FAQ.

---

## API Reference

The module exposes its API at `game.modules.get("wfrp4e-consumables-with-effects").api`:

| Method | Description |
|---|---|
| `openCreator()` | Opens the Consumable Creator dialog |
| `consumeItem(actor, item)` | Programmatically consumes an item on an actor |
| `parseNaturalLanguage(text)` | Parses a natural language string into effect data |

### `parseNaturalLanguage(text)` Return Value

```javascript
{
  changes: [
    { key: "system.characteristics.t.modifier", mode: 2, value: "10", label: "+10 Toughness" },
    { key: "system.characteristics.t.calculationBonusModifier", mode: 2, value: "-1", label: "(Toughness derived offset)" }
  ],
  duration: 5,       // rounds, or null
  heal: null,        // wound amount, or null
  effectName: "+10 Toughness"
}
```

---

## Releasing Updates

```bash
# 1. Make your changes and commit
git add .
git commit -m "Description of changes"
git push

# 2. Update the version in module.json (the workflow also does this from the tag)
# 3. Tag and push
git tag v1.1.0
git push origin v1.1.0
```

The GitHub Actions workflow handles the rest. Users who installed via manifest will see the update in Foundry's module manager.

---

## Compatibility

- **Foundry VTT**: v11+ (verified v12)
- **System**: WFRP4e (Warhammer Fantasy Roleplay 4th Edition)

## License

MIT — see [LICENSE](LICENSE).
