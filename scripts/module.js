/**
 * ============================================================================
 * WFRP4e Consumables With Effects — Main Module Script (v1.1.0)
 * ============================================================================
 *
 * Complete rewrite for FoundryVTT V13 using ApplicationV2 and native DOM.
 *
 * SECTIONS:
 *   §1  Constants & Lookup Tables
 *   §2  Natural Language Parser (characteristics, conditions, healing, movement)
 *   §3  Creator Dialog (ApplicationV2 + HandlebarsApplicationMixin)
 *   §4  Consume Logic (effects, conditions, healing, quantity)
 *   §5  Hooks (init, ready, sidebar button, actor sheet consume button)
 *
 * REFERENCES:
 *   FoundryVTT V13 API    — https://foundryvtt.com/api/
 *   ApplicationV2 Guide   — https://foundryvtt.wiki/en/development/guides/applicationV2-conversion-guide
 *   WFRP4e Effects        — https://moo-man.github.io/WFRP4e-FoundryVTT/pages/effects/effects.html
 *   WFRP4e Conditions     — actor.addCondition("name") / actor.removeCondition("name")
 * ============================================================================
 */

const MODULE_ID = "wfrp4e-consumables-with-effects";


/* ═══════════════════════════════════════════════════════════════════════════
 * §1  CONSTANTS
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Maps natural-language characteristic names → WFRP4e abbreviations */
const CHAR_MAP = {
  "weapon skill": "ws", "ballistic skill": "bs", "strength": "s",
  "toughness": "t", "initiative": "i", "agility": "ag",
  "dexterity": "dex", "intelligence": "int", "willpower": "wp",
  "fellowship": "fel",
  "ws": "ws", "bs": "bs", "s": "s", "t": "t", "i": "i",
  "ag": "ag", "dex": "dex", "int": "int", "wp": "wp", "fel": "fel",
  "str": "s", "tou": "t", "tough": "t", "init": "i",
  "agi": "ag", "wil": "wp", "will": "wp", "intel": "int", "cha": "fel",
};

/** Human labels for characteristic abbreviations */
const CHAR_LABELS = {
  ws: "Weapon Skill", bs: "Ballistic Skill", s: "Strength",
  t: "Toughness", i: "Initiative", ag: "Agility",
  dex: "Dexterity", int: "Intelligence", wp: "Willpower", fel: "Fellowship",
};

/** Characteristics that feed into the Wounds formula (need calculationBonusModifier offset) */
const DERIVED_CHARS = ["s", "t", "wp"];

/** All WFRP4e condition keys recognised by actor.addCondition / actor.removeCondition */
const CONDITIONS = [
  "ablaze", "bleeding", "blinded", "broken", "deafened",
  "entangled", "fatigued", "poisoned", "prone", "stunned",
  "surprised", "unconscious",
];


/* ═══════════════════════════════════════════════════════════════════════════
 * §2  NATURAL LANGUAGE PARSER
 *
 * Converts GM text like "+10 Toughness for four hours and remove one fatigued condition"
 * into a structured object with changes, conditions, healing, and duration.
 *
 * Supported natural language patterns:
 *   "+10 Toughness"                           — single characteristic
 *   "+10 Toughness, Strength, and Agility"    — shared modifier across multiple
 *   "Increase Agility by 10"                  — verb + char + by + number
 *   "for 5 rounds" / "for four hours"         — duration (words or digits)
 *   "heal 4 wounds" / "restore two wounds"    — healing
 *   "remove fatigued" / "remove one fatigued condition" — conditions
 *   "add 2 bleeding" / "add two stunned"      — add conditions with count
 *   "cure blinded"                            — remove alias
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Convert word-numbers to integers. Returns the original string parsed as int
 * if it's already a digit string, or converts English words up to twenty.
 */
const WORD_NUMBERS = {
  zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15,
  sixteen:16, seventeen:17, eighteen:18, nineteen:19, twenty:20,
  a:1, an:1, the:1,
};

function toNum(str) {
  if (!str) return null;
  const s = str.trim().toLowerCase();
  if (/^\d+$/.test(s)) return parseInt(s);
  if (WORD_NUMBERS[s] !== undefined) return WORD_NUMBERS[s];
  return null;
}

function parseNaturalLanguage(input) {
  const result = {
    changes: [],            // { key, mode, value, label } for ActiveEffect.changes
    conditions: [],         // { name, action:"add"|"remove", count } for WFRP4e conditions
    removeAllConditions: false, // "remove all conditions"
    removeCritical: null,   // null | "all" | number — critical wounds to remove
    duration: null,         // rounds (integer) or null
    heal: null,             // wounds to restore (integer) or null
    effectName: "",         // auto-generated label
  };

  const text = input.toLowerCase().trim();

  // ---- Duration ----
  // Matches: "for 5 rounds", "for four hours", "lasting six rounds", "10 rounds"
  // Hours are converted to rounds (1 hour ≈ 600 rounds at 6-second rounds,
  // but in WFRP4e a round is ~10 seconds, so 1 hour = 360 rounds.
  // However, for practical game use we store hours as a large round count.)
  const durMatch = text.match(/(?:for|lasting|duration[:\s]*)\s+(\w+)\s+(rounds?|hours?|minutes?)/i)
                || text.match(/(\d+)\s+(rounds?|hours?|minutes?)/i);
  if (durMatch) {
    const n = toNum(durMatch[1]);
    const unit = durMatch[2].toLowerCase().replace(/s$/, "");
    if (n) {
      if (unit === "round")       result.duration = n;
      else if (unit === "hour")   result.duration = n * 360;  // ~10s per round
      else if (unit === "minute") result.duration = n * 6;    // ~10s per round
    }
  }

  // ---- Healing ----
  // "heal 4 wounds", "restore two wounds", "recover one wound"
  // Use a global match and require a numeric quantity so phrases like
  // "heal critical wounds" don't consume the heal verb (critical is handled separately).
  const healRegex = /(?:heal|restore|recover|regain)\s+(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s*wounds?/gi;
  let healM;
  while ((healM = healRegex.exec(text)) !== null) {
    // Skip if this is actually "...critical wounds" (the word before "wounds" is "critical")
    const n = toNum(healM[1]);
    if (n) { result.heal = n; break; }
  }

  // ---- Critical Wounds ----
  // "remove all critical wounds", "remove critical wounds", "heal critical wounds",
  // "remove 2 critical wounds", and shared-verb forms like
  // "remove all conditions and critical wounds" (verb applies to both).
  //
  // Strategy: if "critical wounds" appears AND there's a remove/heal verb anywhere
  // in the text, treat it as removal. Count defaults to "all" unless a number
  // directly precedes "critical wounds".
  if (/critical\s+wounds?/i.test(text)) {
    const hasRemoveVerb = /(?:remove|cure|clear|heal|restore|recover|eliminate|mend|fix|dispel)/i.test(text);
    if (hasRemoveVerb) {
      const directCount = text.match(/(all\s+|every\s+|\d+\s+|one\s+|two\s+|three\s+|four\s+|five\s+)critical\s+wounds?/i);
      if (directCount) {
        const q = directCount[1].trim();
        result.removeCritical = (q === "all" || q === "every") ? "all" : (toNum(q) || "all");
      } else {
        result.removeCritical = "all"; // default: remove all critical wounds
      }
    }
  }

  // ---- Remove ALL Conditions ----
  // "remove all conditions", "clear all conditions", "cure all conditions",
  // "remove every condition"
  if (text.match(/(?:remove|cure|clear|dispel|lift)\s+(?:all|every)\s+conditions?\b/i)) {
    result.removeAllConditions = true;
  }

  // ---- Conditions ----
  // Patterns:
  //   "add fatigued"                    → add 1 fatigued
  //   "add 2 bleeding"                  → add 2 bleeding
  //   "add one fatigued condition"      → add 1 fatigued
  //   "remove the fatigued condition"   → remove 1 fatigued
  //   "remove one fatigued"             → remove 1 fatigued
  //   "cure blinded"                    → remove 1 blinded
  //   "remove all fatigued"             → remove 99 fatigued (clear all of one type)
  //
  // Strategy: scan for verb + optional count/article + condition_name + optional "condition(s)"
  const condVerbs = "(?:add|apply|inflict|give|cause|remove|cure|clear|dispel|lift)";
  const condNames = CONDITIONS.join("|");
  const condRegex = new RegExp(
    `${condVerbs}\\s+(?:(\\w+)\\s+)?(?:the\\s+)?(${condNames})(?:\\s+conditions?)?`,
    "gi"
  );
  let condMatch;
  while ((condMatch = condRegex.exec(text)) !== null) {
    const verb = condMatch[0].trim().split(/\s/)[0].toLowerCase();
    const isAdd = ["add", "apply", "inflict", "give", "cause"].includes(verb);
    const countWord = condMatch[1]; // might be a number, "one", "all", or undefined
    const condName = condMatch[2].toLowerCase();

    let count = 1;
    if (countWord) {
      if (countWord === "all") count = 99; // "remove all fatigued"
      else {
        const n = toNum(countWord);
        if (n) count = n;
      }
    }

    result.conditions.push({
      name: condName,
      action: isAdd ? "add" : "remove",
      count,
      label: `${isAdd ? "Add" : "Remove"} ${count > 1 && count < 99 ? count + "× " : count >= 99 ? "all " : ""}${condName.charAt(0).toUpperCase() + condName.slice(1)}`,
    });
  }

  // ---- Movement ----
  const movePlus = text.match(/(?:\+\s*(\d+)\s*(?:to\s+)?movement)|(?:(?:increase|add|boost)\s+movement\s+(?:by\s+)?(\d+))/i);
  const moveMinus = text.match(/(?:-\s*(\d+)\s*(?:to\s+)?movement)|(?:(?:reduce|decrease|subtract|lower)\s+movement\s+(?:by\s+)?(\d+))/i);
  if (movePlus) {
    const val = parseInt(movePlus[1] || movePlus[2]);
    result.changes.push({ key: "system.details.move.value", mode: 2, value: String(val), label: `+${val} Movement` });
  }
  if (moveMinus) {
    const val = parseInt(moveMinus[1] || moveMinus[2]);
    result.changes.push({ key: "system.details.move.value", mode: 2, value: String(-val), label: `-${val} Movement` });
  }

  // ---- Characteristics ----
  // The word "and" appears both WITHIN a phrase ("increase DEX and AGI by 5")
  // and BETWEEN independent phrases ("lower FEL by 5 and increase DEX and AGI by 5").
  // Splitting on "and" first would destroy the internal conjunctions.
  //
  // Strategy:
  //   Phase 1 — Extract complete verb-phrases ("increase X and Y by N") using regex.
  //             These are matched as whole units before any splitting occurs.
  //   Phase 2 — Remove the matched verb-phrases from the text, then split the
  //             remainder on "and"/comma for signed-number patterns (+10 WS).

  // Strip duration/condition/heal phrases to isolate characteristic text
  let charText = text
    .replace(/(?:for|lasting)\s+\w+\s+(?:rounds?|hours?|minutes?)/gi, "")
    .replace(/(?:heal|restore|recover|regain)\s+\w+\s*wounds?/gi, "")
    .replace(new RegExp(`${condVerbs}\\s+(?:\\w+\\s+)?(?:the\\s+)?(?:${condNames})(?:\\s+conditions?)?`, "gi"), "")
    .trim();

  // Phase 1: Extract complete verb-phrases before splitting on "and".
  // Four sub-patterns:
  //   1a. "increase DEX and AGI by 5"     — VERB + char_list + by + N
  //   1b. "add 5 to Initiative"           — VERB + N + to + char
  //   1c. "lower FEL by 5"               — VERB(neg) + char_list + by + N
  //   1d. "subtract 10 from Agility"      — VERB(neg) + N + from + char
  const consumedRanges = [];
  let vpm;

  // 1a. Positive: "VERB chars by N"
  const vp1a = new RegExp("(?:add|increase|boost|raise|grant|give)\\s+(.+?)\\s+by\\s+(\\w+)", "gi");
  while ((vpm = vp1a.exec(charText)) !== null) {
    const val = toNum(vpm[2]);
    if (!val) continue;
    const names = vpm[1].split(/\s*(?:,\s*and|,|and)\s*/).map(s => s.trim()).filter(Boolean);
    const valid = names.filter(cn => CHAR_MAP[cn]);
    if (!valid.length) continue;
    for (const cn of valid) _addCharChange(result, CHAR_MAP[cn], val);
    consumedRanges.push([vpm.index, vpm.index + vpm[0].length]);
  }

  // 1b. Positive: "VERB N to char" (e.g. "add 5 to initiative")
  const vp1b = new RegExp("(?:add|increase|boost|raise|grant|give)\\s+(\\w+)\\s+to\\s+([a-z][a-z ]*?)(?:\\s*(?:and|,)|$)", "gi");
  while ((vpm = vp1b.exec(charText)) !== null) {
    const val = toNum(vpm[1]);
    if (!val) continue;
    const charName = vpm[2].trim();
    const abbrev = CHAR_MAP[charName];
    if (!abbrev) continue;
    _addCharChange(result, abbrev, val);
    consumedRanges.push([vpm.index, vpm.index + vpm[0].length]);
  }

  // 1c. Negative: "VERB chars by N"
  const vp1c = new RegExp("(?:subtract|decrease|reduce|lower|drain)\\s+(.+?)\\s+by\\s+(\\w+)", "gi");
  while ((vpm = vp1c.exec(charText)) !== null) {
    const val = toNum(vpm[2]);
    if (!val) continue;
    const names = vpm[1].split(/\s*(?:,\s*and|,|and)\s*/).map(s => s.trim()).filter(Boolean);
    const valid = names.filter(cn => CHAR_MAP[cn]);
    if (!valid.length) continue;
    for (const cn of valid) _addCharChange(result, CHAR_MAP[cn], -val);
    consumedRanges.push([vpm.index, vpm.index + vpm[0].length]);
  }

  // 1d. Negative: "VERB N from char" (e.g. "subtract 10 from agility")
  const vp1d = new RegExp("(?:subtract|decrease|reduce|lower|drain)\\s+(\\w+)\\s+(?:from|to)\\s+([a-z][a-z ]*?)(?:\\s*(?:and|,)|$)", "gi");
  while ((vpm = vp1d.exec(charText)) !== null) {
    const val = toNum(vpm[1]);
    if (!val) continue;
    const charName = vpm[2].trim();
    const abbrev = CHAR_MAP[charName];
    if (!abbrev) continue;
    _addCharChange(result, abbrev, -val);
    consumedRanges.push([vpm.index, vpm.index + vpm[0].length]);
  }

  // Phase 2: Remove consumed ranges, then parse remainder for signed patterns
  let remainder = charText;
  consumedRanges.sort((a, b) => b[0] - a[0]);
  for (const [start, end] of consumedRanges) {
    remainder = remainder.substring(0, start) + remainder.substring(end);
  }
  remainder = remainder.replace(/^\s*(?:and|,)\s*/i, "").replace(/\s*(?:and|,)\s*$/i, "").trim();

  if (remainder) {
    const segments = remainder.split(/\s*(?:,\s*and|,|and)\s*/).filter(s => s.trim());

    // Check for shared modifier: "+10 Toughness, Strength, and Agility"
    let sharedValue = null, firstCharName = null;
    if (segments.length > 1) {
      const fm = segments[0].match(/([+-]?\s*\d+)\s+(?:to\s+)?([a-z\s]+)/i);
      if (fm) {
        const bareNames = segments.slice(1).every(s => CHAR_MAP[s.trim()] !== undefined && !s.trim().match(/\d/));
        if (bareNames) {
          sharedValue = parseInt(fm[1].replace(/\s/g, ""));
          firstCharName = fm[2].trim();
        }
      }
    }

    if (sharedValue !== null && firstCharName) {
      const allNames = [firstCharName, ...segments.slice(1).map(s => s.trim())];
      for (const cn of allNames) {
        const abbrev = CHAR_MAP[cn];
        if (abbrev) _addCharChange(result, abbrev, sharedValue);
      }
    } else {
      for (const seg of segments) {
        if (seg.match(/^(?:add|remove|apply|cure|clear|heal|restore|recover|regain|dispel|lift)\s/i)) continue;
        const pA = seg.match(/([+-]?\s*\d+)\s+(?:to\s+)?([a-z\s]+?)$/i);
        if (pA) {
          const value = parseInt(pA[1].replace(/\s/g, ""));
          const charName = pA[2].trim();
          if (!charName.includes("movement") && !charName.includes("wound")) {
            const abbrev = CHAR_MAP[charName];
            if (abbrev) _addCharChange(result, abbrev, value);
          }
        }
      }
    }
  }

  // ---- Build effect name ----
  const parts = [];
  for (const c of result.changes) { if (!c.label.startsWith("(")) parts.push(c.label); }
  for (const c of result.conditions) parts.push(c.label);
  if (result.removeAllConditions) parts.push("Remove All Conditions");
  if (result.removeCritical === "all") parts.push("Remove All Critical Wounds");
  else if (result.removeCritical) parts.push(`Remove ${result.removeCritical} Critical Wound${result.removeCritical > 1 ? "s" : ""}`);
  if (result.heal) parts.push(`Heal ${result.heal} Wounds`);
  result.effectName = parts.join(", ") || "Consumable Effect";

  return result;
}

/** Helper: add a characteristic modifier change (with derived offset if needed) */
function _addCharChange(result, abbrev, value) {
  const label = CHAR_LABELS[abbrev];
  result.changes.push({
    key: `system.characteristics.${abbrev}.modifier`,
    mode: 2, value: String(value),
    label: `${value >= 0 ? "+" : ""}${value} ${label}`,
  });
  if (DERIVED_CHARS.includes(abbrev)) {
    const offset = Math.floor(Math.abs(value) / 10) * (value < 0 ? 1 : -1);
    result.changes.push({
      key: `system.characteristics.${abbrev}.calculationBonusModifier`,
      mode: 2, value: String(offset),
      label: `(${label} derived offset)`,
    });
  }
}


/* ═══════════════════════════════════════════════════════════════════════════
 * §3  CREATOR DIALOG — ApplicationV2 + HandlebarsApplicationMixin
 *
 * Uses the V13-native ApplicationV2 framework for proper UX styling.
 * The form tag is set on the application itself, template uses <section>.
 * Re-rendering preserves form state via _prepareContext.
 * ═══════════════════════════════════════════════════════════════════════════ */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class ConsumableCreatorApp extends HandlebarsApplicationMixin(ApplicationV2) {

  /** Stored form values (survive re-renders) */
  _formState = {
    itemName: "", itemDescription: "", quantity: "1", encumbrance: "0.5",
    trappingType: "foodAndDrink", effectDescription: "",
  };

  /** Parsed NL result, null until Generate is clicked */
  _parsedEffect = null;

  /* ---- V2 Configuration ---- */

  static DEFAULT_OPTIONS = {
    id: "consumable-effects-creator",
    classes: ["wfrp4e-consumables-with-effects", "standard-form"],
    tag: "form",
    position: { width: 560, height: "auto" },
    window: {
      title: "CONSUMABLE_EFFECTS.title",
      resizable: true,
    },
    form: {
      handler: ConsumableCreatorApp.#onSubmitForm,
      submitOnChange: false,
      closeOnSubmit: false,
    },
    actions: {
      generate: ConsumableCreatorApp.#onGenerate,
      saveItem: ConsumableCreatorApp.#onSaveItem,
    },
  };

  static PARTS = {
    form: {
      template: `modules/${MODULE_ID}/templates/creator.html`,
    },
  };

  /* ---- Context for template ---- */

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.form = this._formState;
    context.parsed = this._parsedEffect;
    return context;
  }

  /* ---- Actions ---- */

  /** Snapshot form state, parse NL, re-render to show preview */
  static #onGenerate(event, target) {
    event.preventDefault();
    const form = this.element;
    this._snapshotForm(form);
    const desc = this._formState.effectDescription;
    if (!desc) return;
    this._parsedEffect = parseNaturalLanguage(desc);
    this.render();
  }

  /** Read live form, create item, close */
  static async #onSaveItem(event, target) {
    event.preventDefault();
    const form = this.element;
    this._snapshotForm(form);
    await this._createItem();
  }

  /** Form submission handler (not used directly — we use action buttons) */
  static async #onSubmitForm(event, form, formData) {
    event.preventDefault();
  }

  /* ---- Helpers ---- */

  /** Read all form fields into _formState so they survive re-renders */
  _snapshotForm(form) {
    const v = (name) => form.querySelector(`[name='${name}']`)?.value ?? "";
    this._formState.itemName = v("itemName");
    this._formState.itemDescription = v("itemDescription");
    this._formState.quantity = v("quantity");
    this._formState.encumbrance = v("encumbrance");
    this._formState.trappingType = v("trappingType");
    this._formState.effectDescription = v("effectDescription");
  }

  /** Create the WFRP4e trapping item with embedded ActiveEffect */
  async _createItem() {
    const f = this._formState;
    const p = this._parsedEffect;
    if (!p || (p.changes.length === 0 && !p.heal && p.conditions.length === 0
               && !p.removeAllConditions && !p.removeCritical)) {
      ui.notifications.warn(game.i18n.localize("CONSUMABLE_EFFECTS.parseError"));
      return;
    }

    // Build GM Notes: a summary of the natural language input and parsed effects
    const gmNoteLines = [`<p><strong>Consumable Effect (auto-generated)</strong></p>`];
    gmNoteLines.push(`<p><em>Original description:</em> ${f.effectDescription}</p>`);
    gmNoteLines.push(`<hr/><p><strong>Parsed Effects:</strong></p><ul>`);
    for (const c of p.changes) {
      if (!c.label.startsWith("(")) gmNoteLines.push(`<li>${c.label}</li>`);
    }
    for (const c of p.conditions) {
      gmNoteLines.push(`<li>${c.label}</li>`);
    }
    if (p.removeAllConditions) gmNoteLines.push(`<li>Remove All Conditions</li>`);
    if (p.removeCritical === "all") gmNoteLines.push(`<li>Remove All Critical Wounds</li>`);
    else if (p.removeCritical) gmNoteLines.push(`<li>Remove ${p.removeCritical} Critical Wound(s)</li>`);
    if (p.heal) gmNoteLines.push(`<li>Heal ${p.heal} Wounds</li>`);
    gmNoteLines.push(`</ul>`);
    if (p.duration) gmNoteLines.push(`<p><strong>Duration:</strong> ${p.duration} rounds</p>`);
    const gmNotes = gmNoteLines.join("\n");

    const icon = this._getIcon(f.trappingType);
    const itemData = {
      name: f.itemName || "Consumable",
      type: "trapping",
      img: icon,
      system: {
        trappingType: { value: f.trappingType },
        description: { value: `<p>${f.itemDescription}</p>` },
        quantity: { value: parseInt(f.quantity) || 1 },
        encumbrance: { value: parseFloat(f.encumbrance) || 0 },
        gpiNotes: { value: gmNotes },
      },
      flags: {
        [MODULE_ID]: {
          isConsumable: true,
          healAmount: p.heal,
          conditions: p.conditions,
          removeAllConditions: p.removeAllConditions,
          removeCritical: p.removeCritical,
          effectName: p.effectName,
          naturalLanguage: f.effectDescription,
        },
      },
    };

    const item = await Item.create(itemData);

    // Create embedded ActiveEffect if there are stat/movement changes
    if (p.changes.length > 0) {
      const changes = p.changes.map(c => ({ key: c.key, mode: c.mode, value: c.value }));
      const effectData = {
        name: p.effectName,
        img: icon,  // V14: ActiveEffect#icon removed, use #img
        changes,
        transfer: false,
        flags: {
          wfrp4e: { effectApplication: "actor" },
          [MODULE_ID]: { consumableEffect: true },
        },
      };
      if (p.duration) effectData.duration = { rounds: p.duration };
      await item.createEmbeddedDocuments("ActiveEffect", [effectData]);
    }

    ui.notifications.info(`Created consumable: ${f.itemName || "Consumable"}`);
    this.close();
  }

  _getIcon(type) {
    switch (type) {
      case "foodAndDrink":  return "icons/consumables/food/bowl-stew-brown.webp";
      case "drugOrPoison":  return "icons/consumables/potions/bottle-round-corked-purple.webp";
      case "herbOrDraught": return "icons/consumables/potions/potion-flask-corked-green.webp";
      default:              return "icons/consumables/food/bowl-stew-brown.webp";
    }
  }
}


/* ═══════════════════════════════════════════════════════════════════════════
 * §4  CONSUME LOGIC
 *
 * 1. Copy ActiveEffects from Item → Actor
 * 2. Add/remove WFRP4e conditions via actor.addCondition/removeCondition
 * 3. Apply healing (clamp to max wounds)
 * 4. Decrement quantity or delete item
 * 5. Post chat message
 * ═══════════════════════════════════════════════════════════════════════════ */

async function consumeItem(actor, item) {
  if (!actor || !item) return;
  const flags = item.flags?.[MODULE_ID];
  if (!flags?.isConsumable) return;

  const qty = item.system.quantity?.value ?? 0;
  if (qty <= 0) {
    ui.notifications.warn(game.i18n.localize("CONSUMABLE_EFFECTS.noQuantity"));
    return;
  }

  // ---- 1. Copy ActiveEffects ----
  const appliedEffects = [];
  for (const effect of item.effects.contents) {
    const data = effect.toObject();
    data.origin = item.uuid;
    data.transfer = false;
    const created = await actor.createEmbeddedDocuments("ActiveEffect", [data]);
    if (created.length) appliedEffects.push(created[0]);
  }

  // ---- 2. Add/Remove Conditions ----
  const conditionMessages = [];
  if (flags.conditions?.length) {
    for (const cond of flags.conditions) {
      try {
        if (cond.action === "add") {
          for (let i = 0; i < (cond.count || 1); i++) {
            await actor.addCondition(cond.name);
          }
          conditionMessages.push(`Added ${cond.count > 1 ? cond.count + "× " : ""}${cond.name}`);
        } else if (cond.action === "remove") {
          for (let i = 0; i < (cond.count || 1); i++) {
            await actor.removeCondition(cond.name);
          }
          conditionMessages.push(`Removed ${cond.count > 1 ? cond.count + "× " : ""}${cond.name}`);
        }
      } catch (e) {
        console.warn(`${MODULE_ID} | Failed to ${cond.action} condition ${cond.name}:`, e);
      }
    }
  }

  // ---- 2b. Remove ALL Conditions ----
  if (flags.removeAllConditions) {
    try {
      // WFRP4e stores conditions as ActiveEffects with a statuses array.
      // Iterate the actor's effects and remove any that are conditions.
      const condEffects = actor.effects.filter(e =>
        e.statuses?.size > 0 || CONDITIONS.includes(e.name?.toLowerCase())
      );
      for (const e of condEffects) {
        try { await e.delete(); } catch { /* skip */ }
      }
      // Belt-and-braces: also call removeCondition for each known condition
      for (const condName of CONDITIONS) {
        try { await actor.removeCondition(condName); } catch { /* not present */ }
      }
      conditionMessages.push("Removed all conditions");
    } catch (e) {
      console.warn(`${MODULE_ID} | Failed to remove all conditions:`, e);
    }
  }

  // ---- 2c. Remove Critical Wounds ----
  let criticalMsg = "";
  if (flags.removeCritical) {
    try {
      // WFRP4e defines both "critical" (critical wounds from combat) and
      // "injury" (lingering injuries) as distinct item types. "Remove critical
      // wounds" targets the "critical" type specifically.
      const critItems = actor.items.filter(i => i.type === "critical");

      if (critItems.length > 0) {
        // Items-based: delete the critical wound items
        const toRemove = flags.removeCritical === "all"
          ? critItems.length
          : Math.min(flags.removeCritical, critItems.length);
        const idsToDelete = critItems.slice(0, toRemove).map(i => i.id);
        await actor.deleteEmbeddedDocuments("Item", idsToDelete);
        criticalMsg = `Removed ${idsToDelete.length} critical wound${idsToDelete.length > 1 ? "s" : ""}`;
      } else {
        // Counter-based fallback: decrement system.status.criticalWounds.value
        const cw = actor.system.status?.criticalWounds;
        if (cw && cw.value > 0) {
          const reduceBy = flags.removeCritical === "all" ? cw.value : Math.min(flags.removeCritical, cw.value);
          const newVal = Math.max(0, cw.value - reduceBy);
          await actor.update({ "system.status.criticalWounds.value": newVal });
          criticalMsg = `Removed ${cw.value - newVal} critical wound${(cw.value - newVal) > 1 ? "s" : ""}`;
        } else {
          criticalMsg = "No critical wounds to remove";
        }
      }
    } catch (e) {
      console.warn(`${MODULE_ID} | Failed to remove critical wounds:`, e);
    }
  }

  // ---- 3. Healing ----
  let healMsg = "";
  if (flags.healAmount) {
    const wounds = actor.system.status?.wounds;
    if (wounds) {
      const newVal = Math.min(wounds.value + flags.healAmount, wounds.max);
      const actual = newVal - wounds.value;
      await actor.update({ "system.status.wounds.value": newVal });
      if (actual > 0) healMsg = `Healed ${actual} wounds`;
    }
  }

  // ---- 4. Decrement quantity ----
  if (qty <= 1) {
    await item.delete();
  } else {
    await item.update({ "system.quantity.value": qty - 1 });
  }

  // ---- 5. Chat message ----
  let content = `<div class="ce-chat-card">`;
  content += `<h3>${actor.name} ${game.i18n.localize("CONSUMABLE_EFFECTS.consumed")} ${item.name}</h3>`;
  if (appliedEffects.length > 0) {
    content += `<p class="ce-chat-effect">${flags.effectName}</p>`;
  }
  for (const cm of conditionMessages) {
    content += `<p class="ce-chat-condition">${cm}</p>`;
  }
  if (criticalMsg) {
    content += `<p class="ce-chat-condition">${criticalMsg}</p>`;
  }
  if (healMsg) {
    content += `<p class="ce-chat-heal">${healMsg}</p>`;
  }
  content += `</div>`;

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
  });
}


/* ═══════════════════════════════════════════════════════════════════════════
 * §5  HOOKS
 * ═══════════════════════════════════════════════════════════════════════════ */

// ---- init: register settings, keybinding ----
Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);

  // Handlebars helpers for the creator template
  Handlebars.registerHelper("isOffset", (label) => typeof label === "string" && label.startsWith("("));
  Handlebars.registerHelper("eq", (a, b) => a === b);

  game.settings.register(MODULE_ID, "showHeaderButton", {
    name: game.i18n.localize("CONSUMABLE_EFFECTS.settings.showButton.name"),
    hint: game.i18n.localize("CONSUMABLE_EFFECTS.settings.showButton.hint"),
    scope: "world", config: true, type: Boolean, default: true,
  });

  game.keybindings?.register(MODULE_ID, "openCreator", {
    name: "Open Consumable Creator",
    hint: "Opens the consumable creator dialog.",
    editable: [{ key: "KeyF", modifiers: ["Control", "Shift"] }],
    onDown: () => { if (game.user.isGM) new ConsumableCreatorApp().render(true); },
    restricted: true,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
  });
});

// ---- ready: system check, expose API ----
Hooks.once("ready", () => {
  if (game.system.id !== "wfrp4e") {
    console.warn(`${MODULE_ID} | Requires the wfrp4e system.`);
    return;
  }
  console.log(`${MODULE_ID} | Ready`);

  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      openCreator: () => new ConsumableCreatorApp().render(true),
      consumeItem,
      parseNaturalLanguage,
    };
  }
});

// ---- Sidebar: "Create Consumable" button in Items Directory ----
Hooks.on("renderItemDirectory", (app, html, data) => {
  if (!game.user.isGM) return;
  if (!game.settings.get(MODULE_ID, "showHeaderButton")) return;

  const element = html instanceof HTMLElement ? html : html[0];
  if (!element) return;

  const button = document.createElement("button");
  button.type = "button";
  button.innerHTML = `<i class="fas fa-utensils"></i> ${game.i18n.localize("CONSUMABLE_EFFECTS.createItem")}`;
  button.addEventListener("click", (ev) => {
    ev.preventDefault();
    new ConsumableCreatorApp().render(true);
  });

  const target = element.querySelector(".directory-header .action-buttons")
              || element.querySelector(".header-actions")
              || element.querySelector(".action-buttons")
              || element.querySelector("header");
  if (target) target.appendChild(button);
  else element.prepend(button);
});

// ---- Actor Sheet: inject consume button on consumable inventory items ----
// WFRP4e V13 uses ApplicationV2 actor sheets which fire "renderActorSheetV2"
// and "renderActorSheetWFRP4eCharacter" — NOT "renderActorSheet".
// We hook into multiple names so it works on both V12 and V13.

/**
 * Shared handler: scans the actor sheet DOM for WFRP4e inventory rows
 * (div.list-row[data-uuid]) and injects a consume button on any that
 * are our consumable items.
 */
async function _injectConsumeButtons(app, html, data) {
  const actor = app.document ?? app.object ?? app.actor;
  if (!actor) return;

  // V13 ApplicationV2 passes the element directly; V12 may pass jQuery
  const element = html instanceof HTMLElement ? html
    : (app.element instanceof HTMLElement ? app.element : html?.[0]);
  if (!element) return;

  // Find all WFRP4e inventory rows
  const rows = element.querySelectorAll("div.list-row[data-uuid]");

  for (const row of rows) {
    const uuid = row.dataset.uuid;
    if (!uuid) continue;

    // Resolve UUID to the Item document
    let item;
    try { item = await fromUuid(uuid); } catch { continue; }
    if (!item?.flags?.[MODULE_ID]?.isConsumable) continue;

    // Don't add duplicate buttons
    if (row.querySelector("[data-action='ce-consume']")) continue;

    // Create consume button
    const btn = document.createElement("a");
    btn.dataset.action = "ce-consume";
    btn.title = game.i18n.localize("CONSUMABLE_EFFECTS.consume");
    btn.classList.add("ce-consume-btn");
    btn.innerHTML = `<i class="fas fa-plate-utensils"></i>`;

    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await consumeItem(actor, item);
      app.render(false);
    });

    row.appendChild(btn);
  }
}

// V13 ApplicationV2 hooks (WFRP4e-specific and generic)
Hooks.on("renderActorSheetWFRP4eCharacter", _injectConsumeButtons);
Hooks.on("renderActorSheetWFRP4eNPC", _injectConsumeButtons);
Hooks.on("renderActorSheetWFRP4eCreature", _injectConsumeButtons);
Hooks.on("renderActorSheetV2", _injectConsumeButtons);
// V12 fallback
Hooks.on("renderActorSheet", _injectConsumeButtons);

// ---- Item Sheet: inject consume button on consumable item sheets ----
// V13 fires renderItemSheetWFRP4e / renderDocumentSheetV2, not renderItemSheet
function _injectItemSheetConsumeButton(app, html, data) {
  const item = app.document ?? app.object;
  if (!item?.flags?.[MODULE_ID]?.isConsumable) return;

  const element = html instanceof HTMLElement ? html
    : (app.element instanceof HTMLElement ? app.element : html?.[0]);
  if (!element) return;
  if (element.querySelector("[data-action='ce-consume']")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.action = "ce-consume";
  btn.innerHTML = `<i class="fas fa-plate-utensils"></i> ${game.i18n.localize("CONSUMABLE_EFFECTS.consume")}`;

  btn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    const actor = item.parent;
    if (!actor) {
      const token = canvas.tokens.controlled[0];
      if (!token) { ui.notifications.warn(game.i18n.localize("CONSUMABLE_EFFECTS.noToken")); return; }
      await consumeItem(token.actor, item);
    } else {
      await consumeItem(actor, item);
    }
  });

  const target = element.querySelector(".sheet-header")
              || element.querySelector(".window-header")
              || element.querySelector("header");
  if (target) target.prepend(btn);
}

// Register for all possible item sheet hook names across V12/V13
Hooks.on("renderItemSheet", _injectItemSheetConsumeButton);
Hooks.on("renderItemSheetV2", _injectItemSheetConsumeButton);
Hooks.on("renderDocumentSheetV2", _injectItemSheetConsumeButton);
