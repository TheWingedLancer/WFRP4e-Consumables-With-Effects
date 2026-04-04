/**
 * ============================================================================
 * WFRP4e Consumable Effects — Main Module Script
 * ============================================================================
 *
 * PURPOSE:
 *   This module lets Warhammer Fantasy Roleplay 4th Edition GMs create
 *   consumable items (food, drink, herbs, potions) whose mechanical effects
 *   are described in plain English.  The module parses that description into
 *   FoundryVTT Active Effect changes and wires up the full consume-and-apply
 *   lifecycle so players can eat/drink items directly from their inventory.
 *
 * ARCHITECTURE OVERVIEW:
 *   1. CONSTANTS          – data maps that translate human words to WFRP4e keys
 *   2. NATURAL LANGUAGE PARSER – regex-based parser: English → effect changes
 *   3. CREATOR APPLICATION – FormApplication dialog where the GM builds items
 *   4. CONSUME LOGIC      – transfers effects from Item → Actor on use
 *   5. HOOKS              – glues everything into the FoundryVTT lifecycle
 *
 * KEY FOUNDRY API SURFACES USED:
 *   • Document.create / .update / .delete  — CRUD for Items
 *   • Document.createEmbeddedDocuments     — adding ActiveEffects to Items/Actors
 *   • FormApplication                      — the creator dialog window
 *   • Hooks.on / Hooks.once                — lifecycle integration
 *   • game.settings.register               — persistent module settings
 *   • game.keybindings.register            — keyboard shortcuts
 *   • ChatMessage.create                   — posting consume notifications
 *   • game.i18n.localize                   — localised UI strings
 *
 * REFERENCES:
 *   FoundryVTT API        — https://foundryvtt.com/api/
 *   WFRP4e System Docs    — https://moo-man.github.io/WFRP4e-FoundryVTT/
 *   WFRP4e Active Effects — https://moo-man.github.io/WFRP4e-FoundryVTT/pages/effects/effects.html
 *
 * ============================================================================
 */


/* ═══════════════════════════════════════════════════════════════════════════
 * §1  CONSTANTS
 *
 *  These lookup tables sit between the human-readable text the GM types
 *  and the system.characteristics.* data paths that FoundryVTT's Active
 *  Effect engine needs.  They are intentionally over-inclusive so the
 *  parser can be forgiving about abbreviations and synonyms.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Unique package identifier — must match the "id" in module.json.
 * Used for flags, settings, keybindings, and API registration.
 * @constant {string}
 */
const MODULE_ID = "wfrp4e-consumables-with-effects";

/**
 * Maps every plausible natural-language name for a WFRP4e characteristic
 * to the two- or three-letter abbreviation used in the Actor data model.
 *
 * WFRP4e stores characteristics at  system.characteristics.<abbrev>  where
 * each object has the sub-keys:
 *   .initial                    — base species value
 *   .advances                   — XP-bought increases
 *   .modifier                   — temporary bonuses/penalties (← we write here)
 *   .calculationBonusModifier   — offset to stop temp mods affecting derived values
 *
 * @constant {Object.<string, string>}
 */
const CHARACTERISTIC_MAP = {
  /* ---- Full canonical names ---- */
  "weapon skill":     "ws",
  "ballistic skill":  "bs",
  "strength":         "s",
  "toughness":        "t",
  "initiative":       "i",
  "agility":          "ag",
  "dexterity":        "dex",
  "intelligence":     "int",
  "willpower":        "wp",
  "fellowship":       "fel",

  /* ---- Official two/three-letter abbreviations ---- */
  "ws": "ws",  "bs": "bs",  "s": "s",    "t": "t",   "i": "i",
  "ag": "ag",  "dex": "dex","int": "int", "wp": "wp", "fel": "fel",

  /* ---- Common shorthand a GM might type ---- */
  "str": "s",   "tou": "t",   "tough": "t",  "init": "i",
  "agi": "ag",  "wil": "wp",  "will": "wp",  "intel": "int",
  "cha": "fel",
};

/**
 * Human-readable labels displayed in the preview panel and chat cards.
 * One entry per canonical abbreviation.
 * @constant {Object.<string, string>}
 */
const CHARACTERISTIC_LABELS = {
  ws:  "Weapon Skill",
  bs:  "Ballistic Skill",
  s:   "Strength",
  t:   "Toughness",
  i:   "Initiative",
  ag:  "Agility",
  dex: "Dexterity",
  int: "Intelligence",
  wp:  "Willpower",
  fel: "Fellowship",
};

/**
 * Subset of characteristics that feed into the WFRP4e Wounds formula.
 *
 * Wounds = f(Strength Bonus, Toughness Bonus × 2, Willpower Bonus).
 * The Cubicle 7 FAQ states that *temporary* characteristic changes (spells,
 * miracles, consumables) must NOT alter Wounds.  To enforce this the WFRP4e
 * system provides the  .calculationBonusModifier  field: an integer that
 * offsets the bonus used in derived-value calculations.
 *
 * Example: +20 Toughness → TB rises by 2 → we add calculationBonusModifier −2
 * so Wounds sees the original TB.
 *
 * @constant {string[]}
 */
const DERIVED_CHARACTERISTICS = ["s", "t", "wp"];


/* ═══════════════════════════════════════════════════════════════════════════
 * §2  NATURAL LANGUAGE PARSER
 *
 *  The parser is the heart of the module.  It converts a freeform English
 *  string like "+10 Toughness and heal 4 wounds for 5 rounds" into a
 *  structured object the rest of the code can turn into an ActiveEffect.
 *
 *  Strategy:
 *    1. Pull out duration  ("for N rounds")   — one regex, global scope
 *    2. Pull out healing   ("heal N wounds")   — one regex, global scope
 *    3. Pull out movement  ("+N movement")     — two regexes (±), global scope
 *    4. Split remainder on  "and" / ","  into segments
 *    5. For each segment, try three patterns:
 *         A.  signed-number + characteristic   ("+10 Toughness")
 *         B.  increase-verb + number + char    ("Add 10 to WS")
 *         C.  decrease-verb + number + char    ("Reduce WS by 10")
 *    6. Look up the characteristic in CHARACTERISTIC_MAP
 *    7. If it's in DERIVED_CHARACTERISTICS, add a calculationBonusModifier
 *       offset to protect Wounds.
 *    8. Build a human-readable effect name from the labels.
 *
 *  The parser is deliberately lenient — it ignores segments it can't
 *  understand rather than erroring, so partial input still works.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Parse a natural-language effect description into structured effect data.
 *
 * @param {string} input — GM-authored description, e.g. "+10 Toughness for 5 rounds"
 *
 * @returns {{
 *   changes:    Array<{key: string, mode: number, value: string, label: string}>,
 *   duration:   number|null,
 *   heal:       number|null,
 *   effectName: string
 * }}
 *   • changes   — array ready to feed into ActiveEffect.changes
 *                  (key = WFRP4e data path, mode = ADD (2), value = signed string)
 *   • duration  — combat rounds, or null if the GM didn't specify one
 *   • heal      — wounds to restore instantly on consume, or null
 *   • effectName — auto-generated label for the ActiveEffect document
 */
function parseNaturalLanguage(input) {
  const result = {
    changes:    [],   // Will contain { key, mode, value, label } objects
    duration:   null, // Rounds (integer) or null
    heal:       null, // Wounds (integer) or null
    effectName: "",   // Built at the end from all non-offset labels
  };

  // Normalise to lowercase for pattern matching
  const text = input.toLowerCase().trim();

  /* ---- 2a. Duration ----
   * Accepted forms:
   *   "for 5 rounds"  |  "lasting 10 rounds"  |  "duration: 8 rounds"  |  "5 rounds"
   */
  const durationMatch = text.match(/(?:for|lasting|duration[:\s]*)?\s*(\d+)\s*rounds?/i);
  if (durationMatch) {
    result.duration = parseInt(durationMatch[1]);
  }

  /* ---- 2b. Healing ----
   * Accepted forms:
   *   "heal 4 wounds"  |  "restore 3 wounds"  |  "recover 2 wounds"  |  "regain 1 wound"
   */
  const healMatch = text.match(/(?:heal|restore|recover|regain)\s+(\d+)\s*wounds?/i);
  if (healMatch) {
    result.heal = parseInt(healMatch[1]);
  }

  /* ---- 2c. Movement modifiers ----
   * Movement lives at  system.details.move.value  in the WFRP4e Actor model.
   * Positive: "+2 movement", "increase movement by 2", "add 1 to movement"
   * Negative: "-1 movement", "reduce movement by 1", "decrease movement by 2"
   */
  const movePlus = text.match(
    /(?:\+\s*(\d+)\s*(?:to\s+)?movement)|(?:(?:increase|add|boost)\s+movement\s+(?:by\s+)?(\d+))/i
  );
  const moveMinus = text.match(
    /(?:-\s*(\d+)\s*(?:to\s+)?movement)|(?:(?:reduce|decrease|subtract|lower)\s+movement\s+(?:by\s+)?(\d+))/i
  );

  if (movePlus) {
    const val = parseInt(movePlus[1] || movePlus[2]);
    result.changes.push({
      key:   "system.details.move.value",   // WFRP4e Actor data path for Movement
      mode:  2,                              // CONST.ACTIVE_EFFECT_MODES.ADD
      value: String(val),
      label: `+${val} Movement`,
    });
  }
  if (moveMinus) {
    const val = parseInt(moveMinus[1] || moveMinus[2]);
    result.changes.push({
      key:   "system.details.move.value",
      mode:  2,
      value: String(-val),
      label: `-${val} Movement`,
    });
  }

  /* ---- 2d. Characteristic modifiers ----
   * Split the whole string on commas and "and" so each segment contains at
   * most one characteristic reference, then run multiple patterns per segment.
   *
   * Pattern A — signed literal:       "+10 Toughness", "-5 WS", "+20 to BS"
   * Pattern B — verb + number + char: "Add 20 to Weapon Skill"
   * Pattern C — verb - number + char: "Subtract 10 from Agility"
   * Pattern D — verb + char + by + N: "Increase Agility by 10"
   * Pattern E — verb - char + by + N: "Decrease Strength by 5", "Reduce WP by 10"
   */
  const segments = text.split(/\s*(?:,\s*and|,|and)\s*/);

  for (const segment of segments) {
    // Pattern A: a number (optionally signed) followed by a characteristic name
    //   e.g. "+10 Toughness", "-5 WS", "+20 to Weapon Skill"
    const patternA = segment.match(
      /([+-]?\s*\d+)\s+(?:to\s+)?([a-z\s]+?)(?:\s+(?:for|lasting|duration)|$)/i
    );

    // Pattern B: increase-verb + NUMBER + (to)? + CHARACTERISTIC
    //   e.g. "Add 20 to Weapon Skill", "Grant 10 Toughness"
    const patternB = segment.match(
      /(?:add|increase|boost|raise|grant|give)\s+(\d+)\s+(?:to\s+)?([a-z\s]+?)(?:\s+(?:for|lasting|duration)|$)/i
    );

    // Pattern C: decrease-verb + NUMBER + (from)? + CHARACTERISTIC
    //   e.g. "Subtract 10 from Agility"
    const patternC = segment.match(
      /(?:subtract|decrease|reduce|lower|remove|drain)\s+(\d+)\s+(?:from\s+|to\s+)?([a-z\s]+?)(?:\s+(?:for|lasting|duration)|$)/i
    );

    // Pattern D: increase-verb + CHARACTERISTIC + by + NUMBER
    //   e.g. "Increase Agility by 10", "Boost Toughness by 20"
    const patternD = segment.match(
      /(?:add|increase|boost|raise|grant|give)\s+([a-z\s]+?)\s+by\s+(\d+)/i
    );

    // Pattern E: decrease-verb + CHARACTERISTIC + by + NUMBER
    //   e.g. "Decrease Strength by 5", "Reduce Fellowship by 10"
    const patternE = segment.match(
      /(?:subtract|decrease|reduce|lower|remove|drain)\s+([a-z\s]+?)\s+by\s+(\d+)/i
    );

    let charName = null;
    let value    = null;

    if (patternD) {
      // Check D before B because D is more specific ("increase X by N")
      charName = patternD[1].trim();
      value    = parseInt(patternD[2]);
    } else if (patternE) {
      // Check E before C for the same reason
      charName = patternE[1].trim();
      value    = -parseInt(patternE[2]);
    } else if (patternA) {
      value    = parseInt(patternA[1].replace(/\s/g, ""));
      charName = patternA[2].trim();
    } else if (patternB) {
      value    = parseInt(patternB[1]);
      charName = patternB[2].trim();
    } else if (patternC) {
      value    = -parseInt(patternC[1]);
      charName = patternC[2].trim();
    }

    // If we matched something, look it up in CHARACTERISTIC_MAP
    if (charName && value !== null) {
      // Guard: skip if the matched name was actually "movement" or "wounds"
      // (already handled above in their own sections)
      if (charName.includes("movement") || charName.includes("wound")) continue;

      const abbrev = CHARACTERISTIC_MAP[charName];
      if (!abbrev) continue; // Unrecognised characteristic — skip silently

      const label = CHARACTERISTIC_LABELS[abbrev];

      // Push the main modifier change
      result.changes.push({
        key:   `system.characteristics.${abbrev}.modifier`,
        mode:  2,                                       // ADD
        value: String(value),
        label: `${value >= 0 ? "+" : ""}${value} ${label}`,
      });

      /* If this characteristic feeds into Wounds, add a calculationBonusModifier
       * offset so the temporary buff doesn't change the character's Wound total.
       *
       * The offset is the negative of however many "bonus points" the modifier
       * adds.  In WFRP4e each full 10 in a characteristic = 1 bonus point.
       *   +20 Toughness → +2 TB → offset −2
       *   −10 Strength  → −1 SB → offset +1
       */
      if (DERIVED_CHARACTERISTICS.includes(abbrev)) {
        const bonusOffset = Math.floor(Math.abs(value) / 10) * (value < 0 ? 1 : -1);
        result.changes.push({
          key:   `system.characteristics.${abbrev}.calculationBonusModifier`,
          mode:  2,
          value: String(bonusOffset),
          label: `(${label} derived offset)`, // Parenthesised → hidden from preview
        });
      }
    }
  }

  /* ---- 2e. Build a human-readable name for the ActiveEffect ----
   * We concatenate all non-offset labels, e.g. "+10 Toughness, +5 Willpower".
   * Offset labels start with "(" so they're excluded.
   */
  const nameParts = [];
  for (const change of result.changes) {
    if (!change.label.startsWith("(")) nameParts.push(change.label);
  }
  if (result.heal) nameParts.push(`Heal ${result.heal} Wounds`);
  result.effectName = nameParts.join(", ") || "Consumable Effect";

  return result;
}


/* ═══════════════════════════════════════════════════════════════════════════
 * §3  CONSUMABLE CREATOR — FormApplication
 *
 *  This is the main UI dialog for GMs.  It renders a Handlebars template
 *  (templates/creator.html) inside a FoundryVTT Application window.
 *
 *  Workflow:
 *    1. GM fills in item name, description, quantity, encumbrance, type.
 *    2. GM types a natural-language effect description.
 *    3. GM clicks "Generate" → parseNaturalLanguage() runs, result is stored,
 *       the form re-renders showing the preview panel.
 *    4. GM clicks "Save Item" → _createItem() builds an Item document with
 *       an embedded ActiveEffect and persists it to the world.
 *
 *  FoundryVTT API references:
 *    FormApplication — https://foundryvtt.com/api/classes/client.FormApplication.html
 *    Item.create     — https://foundryvtt.com/api/classes/client.Item.html
 * ═══════════════════════════════════════════════════════════════════════════ */

class ConsumableCreatorApp extends FormApplication {

  /**
   * @param {object} options — passed through to FormApplication
   */
  constructor(options = {}) {
    super({}, options);

    /**
     * The result of parseNaturalLanguage(), stored between render cycles
     * so the preview panel can display it.  Null until the user clicks Generate.
     * @type {object|null}
     */
    this._parsedEffect = null;

    /**
     * Preserved form field values.  When the user clicks "Generate" the form
     * re-renders (to show the preview), which would wipe all inputs.  We
     * snapshot them here before re-rendering and feed them back via getData().
     * @type {object}
     */
    this._formState = {
      itemName: "",
      itemDescription: "",
      quantity: "1",
      encumbrance: "0.5",
      trappingType: "foodAndDrink",
      effectDescription: "",
    };
  }

  /* ---------- defaultOptions ----------
   * Static getter that FoundryVTT reads once to configure the window.
   * We set a fixed width, auto height, point at our Handlebars template,
   * and tell Foundry not to close the window on form submit (we submit
   * manually via button click, not a native <form> submit event).
   */
  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:            "consumable-effects-creator",
      title:         game.i18n.localize("CONSUMABLE_EFFECTS.title") + " — "
                   + game.i18n.localize("CONSUMABLE_EFFECTS.createItem"),
      template:      `modules/${MODULE_ID}/templates/creator.html`,
      classes:       ["consumable-effects-app"],
      width:         560,
      height:        "auto",
      resizable:     true,
      closeOnSubmit: false,
    });
  }

  /* ---------- getData ----------
   * Called by FoundryVTT before each render.  The returned object becomes
   * the Handlebars template context.  We pass:
   *   • parsed   — the most recent parse result (or null)
   *   • form     — preserved form field values (survive re-renders)
   *   • i18n     — a shortcut helper to localise strings inside the template
   */
  /** @override */
  getData() {
    return {
      parsed: this._parsedEffect,
      form:   this._formState,
      i18n:   (key) => game.i18n.localize(`CONSUMABLE_EFFECTS.${key}`),
    };
  }

  /* ---------- activateListeners ----------
   * Called after each render.  We bind click handlers to our three buttons:
   *   • Generate — snapshots form values, parses NL text, then re-renders
   *   • Save    — calls _createItem() reading from the *current* live DOM
   *   • Cancel  — closes the dialog
   *
   * V13 COMPATIBILITY: Uses native DOM methods throughout.
   */
  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    // Normalise: get the raw HTMLElement regardless of jQuery or native
    const el = html instanceof HTMLElement ? html : html[0] ?? html;

    // "Generate" button — snapshot form state, parse, and re-render
    el.querySelector(".ce-generate-btn")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      // Snapshot all form values BEFORE re-render wipes the DOM
      this._snapshotFormState(el);
      const desc = this._formState.effectDescription;
      if (!desc) return;
      this._parsedEffect = parseNaturalLanguage(desc);
      this.render(false); // Re-renders template; getData() feeds _formState back in
    });

    // "Save Item" button — read from the LIVE DOM (not the stale closure `el`)
    el.querySelector(".ce-save-btn")?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      // Get the current live form element from Foundry's element reference
      const liveEl = this.element instanceof HTMLElement
        ? this.element
        : this.element?.[0] ?? el;
      await this._createItem(liveEl);
    });

    // "Cancel" button — close without saving
    el.querySelector(".ce-cancel-btn")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      this.close();
    });
  }

  /**
   * Read all form field values from the DOM and store them in _formState
   * so they survive the re-render triggered by "Generate".
   * @param {HTMLElement} el — the form's root element
   */
  _snapshotFormState(el) {
    this._formState.itemName         = el.querySelector("[name='itemName']")?.value ?? "";
    this._formState.itemDescription  = el.querySelector("[name='itemDescription']")?.value ?? "";
    this._formState.quantity         = el.querySelector("[name='quantity']")?.value ?? "1";
    this._formState.encumbrance      = el.querySelector("[name='encumbrance']")?.value ?? "0.5";
    this._formState.trappingType     = el.querySelector("[name='trappingType']")?.value ?? "foodAndDrink";
    this._formState.effectDescription = el.querySelector("[name='effectDescription']")?.value ?? "";
  }

  /* ---------- _createItem ----------
   * Reads every form field, assembles a WFRP4e "trapping" Item document,
   * persists it via Item.create(), then adds an embedded ActiveEffect
   * containing the parsed stat changes.
   *
   * WFRP4e item type "trapping" is the catch-all for equipment that isn't
   * a weapon, armour, spell, or talent.  Its trappingType sub-field
   * distinguishes food/drink, drugs, herbs, etc.
   *
   * Module-specific data (isConsumable flag, heal amount, original NL text)
   * is stored on item.flags[MODULE_ID] so consume logic can find it later.
   */
  async _createItem(el) {
    // ---- Read form values using native DOM ----
    // el is now always an HTMLElement (normalised in activateListeners)
    const name         = el.querySelector("[name='itemName']")?.value || "Consumable";
    const description  = el.querySelector("[name='itemDescription']")?.value || "";
    const quantity     = parseInt(el.querySelector("[name='quantity']")?.value) || 1;
    const encumbrance  = parseFloat(el.querySelector("[name='encumbrance']")?.value) || 0;
    const trappingType = el.querySelector("[name='trappingType']")?.value || "foodAndDrink";

    // ---- Validate: we must have at least one change or a heal amount ----
    if (!this._parsedEffect
        || (this._parsedEffect.changes.length === 0 && !this._parsedEffect.heal)) {
      ui.notifications.warn(game.i18n.localize("CONSUMABLE_EFFECTS.parseError"));
      return;
    }

    // ---- Assemble the Item document data ----
    // type:"trapping" tells the WFRP4e system this is generic equipment.
    // The system sub-object follows WFRP4e's data model for trappings.
    // flags[MODULE_ID] holds our custom data outside the system's model.
    const itemData = {
      name,
      type: "trapping",
      img:  this._getItemIcon(trappingType),
      system: {
        trappingType:  { value: trappingType },
        description:   { value: `<p>${description}</p>` },
        quantity:      { value: quantity },
        encumbrance:   { value: encumbrance },
      },
      flags: {
        [MODULE_ID]: {
          isConsumable:    true,                // Marks this item for our consume logic
          healAmount:      this._parsedEffect.heal,       // Wounds to restore (or null)
          effectName:      this._parsedEffect.effectName,  // Human-readable summary
          naturalLanguage: el.querySelector("[name='effectDescription']")?.value, // Original GM text
        },
      },
    };

    // ---- Persist the Item to the world via the Foundry Document API ----
    // Item.create() returns the newly created Item document instance.
    // See: https://foundryvtt.com/api/classes/client.Item.html#create
    const item = await Item.create(itemData);

    // ---- Create an embedded ActiveEffect on the Item ----
    // We only create an effect if there are stat/movement changes.
    // Heal-only items don't need an ActiveEffect; healing is applied
    // imperatively in consumeItem().
    if (this._parsedEffect.changes.length > 0) {

      // Strip our cosmetic "label" field — ActiveEffect.changes only
      // accepts { key, mode, value }.
      const changes = this._parsedEffect.changes.map(c => ({
        key:   c.key,
        mode:  c.mode,
        value: c.value,
      }));

      // Build the ActiveEffect data object.
      // transfer:false means the effect won't automatically apply when the
      // item is added to an actor — we handle that manually in consumeItem().
      const effectData = {
        name:     this._parsedEffect.effectName || name,
        icon:     this._getItemIcon(trappingType),
        changes,
        transfer: false,
        flags: {
          wfrp4e: {
            effectApplication: "actor",             // WFRP4e: this effect targets an Actor
            effectData: { description },
          },
          [MODULE_ID]: {
            consumableEffect: true,                  // Our marker for identification
          },
        },
      };

      // Attach duration if the GM specified one
      if (this._parsedEffect.duration) {
        effectData.duration = { rounds: this._parsedEffect.duration };
      }

      // createEmbeddedDocuments() adds an ActiveEffect as a child of the Item.
      // See: https://foundryvtt.com/api/classes/client.Document.html#createEmbeddedDocuments
      await item.createEmbeddedDocuments("ActiveEffect", [effectData]);
    }

    // ---- Notify and close ----
    ui.notifications.info(`Created consumable: ${name}`);
    this.close();
  }

  /* ---------- _getItemIcon ----------
   * Returns a sensible default icon path from Foundry's built-in icon set
   * based on the trapping sub-type the GM selected.
   */
  _getItemIcon(trappingType) {
    switch (trappingType) {
      case "foodAndDrink":  return "icons/consumables/food/bowl-stew-brown.webp";
      case "drugOrPoison":  return "icons/consumables/potions/bottle-round-corked-purple.webp";
      case "herbOrDraught": return "icons/consumables/potions/potion-flask-corked-green.webp";
      default:              return "icons/consumables/food/bowl-stew-brown.webp";
    }
  }

  /* ---------- _updateObject ----------
   * Required override for FormApplication.  We don't use native form
   * submission (our buttons call _createItem directly), so this is a no-op.
   */
  /** @override */
  async _updateObject(event, formData) { /* no-op */ }
}


/* ═══════════════════════════════════════════════════════════════════════════
 * §4  CONSUME LOGIC
 *
 *  When a player "uses" a consumable item, this function:
 *    1. Validates the item is marked as a consumable and has quantity > 0
 *    2. Copies every ActiveEffect from the Item onto the Actor
 *    3. Applies instant healing (if any) by updating the Actor's wound value
 *    4. Decrements the item's quantity (or deletes it if it was the last one)
 *    5. Posts a descriptive ChatMessage so the table sees what happened
 *
 *  The effect-copy technique is the standard Foundry pattern:
 *    effect.toObject() → plain data → actor.createEmbeddedDocuments()
 *  This creates a new, independent ActiveEffect owned directly by the Actor.
 *  Because all Actor-owned effects are considered "applied" in WFRP4e, the
 *  stat changes take effect immediately.
 *
 *  Duration tracking is handled by Foundry's combat system: when the
 *  effect's duration.rounds expires, Foundry automatically disables it.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Consume one serving of a consumable item, applying its effects.
 *
 * @param {Actor} actor — the character who is eating/drinking
 * @param {Item}  item  — the consumable Item (must have MODULE_ID flags)
 * @returns {Promise<void>}
 */
async function consumeItem(actor, item) {
  // ---- Guard clauses ----
  if (!actor || !item) return;

  const flags = item.flags?.[MODULE_ID];
  if (!flags?.isConsumable) {
    ui.notifications.warn("This item is not a consumable.");
    return;
  }

  const qty = item.system.quantity?.value ?? 0;
  if (qty <= 0) {
    ui.notifications.warn(game.i18n.localize("CONSUMABLE_EFFECTS.noQuantity"));
    return;
  }

  /* ---- 4a. Copy ActiveEffects from the Item to the Actor ----
   *
   * item.effects is an EmbeddedCollection of ActiveEffect documents.
   * We iterate it, serialise each effect to a plain object with toObject(),
   * set the origin to the item's UUID (so Foundry can trace where it came
   * from), and create a new ActiveEffect directly on the Actor.
   *
   * Because we set transfer:false on creation, these effects don't auto-apply
   * when the item sits in inventory — they only apply when we explicitly
   * create them on the Actor here.
   *
   * API ref: https://foundryvtt.com/api/classes/client.ActiveEffect.html
   */
  const effects        = item.effects.contents; // Array<ActiveEffect>
  const appliedEffects = [];

  for (const effect of effects) {
    const effectData    = effect.toObject(); // Plain JS object, safe to mutate
    effectData.origin   = item.uuid;         // Provenance tracking
    effectData.transfer = false;             // Redundant but explicit

    const created = await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
    if (created.length) appliedEffects.push(created[0]);
  }

  /* ---- 4b. Apply instant healing ----
   *
   * WFRP4e stores current and max wounds at:
   *   actor.system.status.wounds.value  (current)
   *   actor.system.status.wounds.max    (maximum)
   *
   * We clamp the new value to max so we don't overheal.
   */
  let healMsg = "";
  if (flags.healAmount) {
    const wounds = actor.system.status?.wounds;
    if (wounds) {
      const currentWounds = wounds.value;
      const maxWounds     = wounds.max;
      const newWounds     = Math.min(currentWounds + flags.healAmount, maxWounds);
      const actualHeal    = newWounds - currentWounds;

      // Persist the new wound total via the Document update API
      await actor.update({ "system.status.wounds.value": newWounds });
      healMsg = game.i18n.format("CONSUMABLE_EFFECTS.healWounds", { amount: actualHeal });
    }
  }

  /* ---- 4c. Decrement (or delete) the Item ----
   *
   * If this was the last serving, remove the item entirely with delete().
   * Otherwise, reduce quantity by 1 with update().
   *
   * API ref: https://foundryvtt.com/api/classes/client.Document.html#update
   */
  if (qty <= 1) {
    await item.delete();
  } else {
    await item.update({ "system.quantity.value": qty - 1 });
  }

  /* ---- 4d. Post a ChatMessage ----
   *
   * Builds an HTML card styled by our CSS (styles/module.css) and posts it
   * so the whole table can see who consumed what and what happened.
   *
   * API ref: https://foundryvtt.com/api/classes/client.ChatMessage.html
   */
  const effectSummary = flags.effectName || "Unknown Effect";

  let content = `<div class="ce-chat-card">`;
  content += `<h3>${actor.name} ${game.i18n.localize("CONSUMABLE_EFFECTS.consumed")} ${item.name}</h3>`;
  if (appliedEffects.length > 0) {
    content += `<p class="ce-chat-effect">${game.i18n.localize("CONSUMABLE_EFFECTS.effectApplied")} ${effectSummary}</p>`;
  }
  if (healMsg) {
    content += `<p class="ce-chat-heal">${healMsg}</p>`;
  }
  if (item.system.description?.value) {
    content += `<p><em>${item.system.description.value}</em></p>`;
  }
  content += `</div>`;

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    type: CONST.CHAT_MESSAGE_TYPES?.IC ?? 2, // In-Character message type
  });
}


/* ═══════════════════════════════════════════════════════════════════════════
 * §5  HOOKS — FoundryVTT Lifecycle Integration
 *
 *  Hooks are FoundryVTT's event system.  We use:
 *    • "init"  (once)  — register settings, keybindings, Handlebars helpers
 *    • "ready" (once)  — system check, expose public API
 *    • "renderItemDirectory" — inject "Create Consumable" button into sidebar
 *    • "renderItemSheet"     — inject "Consume" button onto item sheets
 *    • "getItemDirectoryEntryContext" — add right-click "Consume" option
 *
 *  API ref: https://foundryvtt.com/api/classes/client.Hooks.html
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ---------- init ----------
 * Fires once during Foundry startup, before the world is fully loaded.
 * We use it for things that don't need world data:
 *   • Handlebars helpers (used by our template)
 *   • Module settings (persisted in the world DB)
 *   • Keybinding registration
 */
Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing WFRP4e Consumable Effects`);

  // ---- Handlebars helpers ----
  // "isOffset" hides calculationBonusModifier entries (labelled with "(" prefix)
  // from the effect preview so the GM only sees the meaningful stat changes.
  Handlebars.registerHelper("isOffset", function (label) {
    return typeof label === "string" && label.startsWith("(");
  });

  // "modeLabel" converts the numeric ACTIVE_EFFECT_MODES constant to a word.
  Handlebars.registerHelper("modeLabel", function (mode) {
    return mode === 2 ? "Add" : mode === 5 ? "Override" : `Mode ${mode}`;
  });

  // "eq" compares two values — used for preserving <select> state across re-renders.
  Handlebars.registerHelper("eq", function (a, b) {
    return a === b;
  });

  // ---- Module settings ----
  // A single boolean: whether to show the "Create Consumable" button in the
  // Items Directory sidebar header.  Stored per-world (scope: "world").
  // See: https://foundryvtt.com/api/classes/client.ClientSettings.html#register
  game.settings.register(MODULE_ID, "showHeaderButton", {
    name:    game.i18n.localize("CONSUMABLE_EFFECTS.settings.showButton.name"),
    hint:    game.i18n.localize("CONSUMABLE_EFFECTS.settings.showButton.hint"),
    scope:   "world",
    config:  true,   // Show in the module settings UI
    type:    Boolean,
    default: true,
  });

  // ---- Keybinding ----
  // Ctrl+Shift+F opens the creator dialog.  GM-restricted.
  // See: https://foundryvtt.com/api/classes/client.ClientKeybindings.html#register
  game.keybindings?.register(MODULE_ID, "openCreator", {
    name:       "Open Consumable Creator",
    hint:       "Opens the Consumable Effects creator dialog.",
    editable:   [{ key: "KeyF", modifiers: ["Control", "Shift"] }],
    onDown:     () => { if (game.user.isGM) new ConsumableCreatorApp().render(true); },
    restricted: true,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
  });
});

/* ---------- ready ----------
 * Fires once after the world is fully loaded and all documents are available.
 * We check that the active system is WFRP4e, then expose the module's public
 * API on  game.modules.get(MODULE_ID).api  — the Foundry community convention
 * for inter-module and macro access.
 */
Hooks.once("ready", () => {
  if (game.system.id !== "wfrp4e") {
    console.warn(`${MODULE_ID} | This module requires the wfrp4e system.`);
    return;
  }

  console.log(`${MODULE_ID} | WFRP4e Consumable Effects ready.`);

  // Expose public API for macros and other modules
  const moduleData = game.modules.get(MODULE_ID);
  if (moduleData) {
    moduleData.api = {
      openCreator:        () => new ConsumableCreatorApp().render(true),
      consumeItem:        consumeItem,
      parseNaturalLanguage: parseNaturalLanguage,
    };
  }
});

/* ---------- renderItemDirectory ----------
 * Fires every time the Items sidebar tab renders.  We inject a styled
 * "Create Consumable" button into the header's action-buttons row.
 * Only shown to GMs, and only if the "showHeaderButton" setting is true.
 *
 * V13 COMPATIBILITY: In Foundry V13, the `html` parameter passed to render
 * hooks is a native HTMLElement, not a jQuery object.  We use native DOM
 * methods (querySelector, createElement, addEventListener) instead of
 * jQuery's .find(), $(), and .click() to support both V12 and V13.
 */
Hooks.on("renderItemDirectory", (app, html, data) => {
  if (!game.user.isGM) return;
  if (!game.settings.get(MODULE_ID, "showHeaderButton")) return;

  // Normalise: V12 passes jQuery, V13 passes HTMLElement
  const element = html instanceof HTMLElement ? html : html[0];
  if (!element) return;

  // Build the button using native DOM — no jQuery dependency.
  // We do NOT apply our custom "ce-use-button" class here; instead we leave
  // the button unstyled so it inherits Foundry V13's native sidebar button
  // appearance (same look as "Create Item", "Create Folder", etc.).
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = "ce-create-consumable"; // For identification only
  button.innerHTML = `<i class="fas fa-utensils"></i> ${game.i18n.localize("CONSUMABLE_EFFECTS.createItem")}`;
  button.addEventListener("click", (ev) => {
    ev.preventDefault();
    new ConsumableCreatorApp().render(true);
  });

  // Try multiple selectors to find the right insertion point across V12/V13.
  // V12 uses ".directory-header .action-buttons", V13 may use ".header-actions"
  // or just ".action-buttons" at a different nesting level.
  const target = element.querySelector(".directory-header .action-buttons")
              || element.querySelector(".header-actions")
              || element.querySelector(".action-buttons")
              || element.querySelector("header");
  if (target) {
    target.appendChild(button);
  } else {
    // Last resort: prepend to the element itself so the button still appears
    element.prepend(button);
  }
});

/* ---------- renderItemSheet ----------
 * Fires every time any Item sheet renders (world-level or actor-owned).
 * If the item has our isConsumable flag, we inject a "Consume" button.
 *
 * V13 COMPATIBILITY: Uses native DOM.  Also hooks the WFRP4e-specific
 * sheet names since WFRP4e may use its own sheet class (e.g. "ItemSheetWfrp4e").
 */
Hooks.on("renderItemSheet", (app, html, data) => {
  const item = app.document ?? app.object;
  if (!item?.flags?.[MODULE_ID]?.isConsumable) return;

  const element = html instanceof HTMLElement ? html : html[0];
  if (!element) return;

  // Don't add duplicate buttons on re-render
  if (element.querySelector("[data-action='ce-consume']")) return;

  const consumeBtn = document.createElement("button");
  consumeBtn.type = "button";
  consumeBtn.dataset.action = "ce-consume";
  consumeBtn.innerHTML = `<i class="fas fa-drumstick-bite"></i> ${game.i18n.localize("CONSUMABLE_EFFECTS.consume")}`;

  consumeBtn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    const actor = item.parent;
    if (!actor) {
      const token = canvas.tokens.controlled[0];
      if (!token) {
        ui.notifications.warn(game.i18n.localize("CONSUMABLE_EFFECTS.noToken"));
        return;
      }
      await consumeItem(token.actor, item);
    } else {
      await consumeItem(actor, item);
    }
  });

  // Insert into the sheet — try multiple locations for V12/V13 and WFRP4e compat
  const target = element.querySelector(".sheet-header .item-controls")
              || element.querySelector(".sheet-header")
              || element.querySelector(".window-header")
              || element.querySelector("header");
  if (target) {
    target.prepend(consumeBtn);
  }
});

/* ---------- Actor sheet: "Consume" on right-click inventory items ----------
 * WFRP4e renders its own actor sheet with inventory sections.  We hook into
 * every possible actor sheet render hook to inject right-click context menu
 * options onto inventory items that are our consumables.
 *
 * We also listen for the WFRP4e-specific hook if available.
 */

// Generic: works for any system's actor sheet
Hooks.on("getActorSheetItemContext", (app, options) => {
  _addConsumeContextOption(options, "actorSheet");
});

// WFRP4e-specific: the system fires its own context menu hooks
Hooks.on("getItemListContextOptions", (app, options) => {
  _addConsumeContextOption(options, "wfrp4eItemList");
});

// Fallback: standard Foundry actor directory context
Hooks.on("getActorDirectoryEntryContext", (html, options) => {
  // Not used for consume — actors aren't consumables
});

// World-level Items Directory right-click
Hooks.on("getItemDirectoryEntryContext", (html, options) => {
  options.push({
    name: game.i18n.localize("CONSUMABLE_EFFECTS.consume"),
    icon: '<i class="fas fa-drumstick-bite"></i>',
    condition: (li) => {
      const el     = li instanceof HTMLElement ? li : li[0];
      const itemId = el?.dataset?.documentId || el?.dataset?.entityId;
      const item   = game.items.get(itemId);
      return item?.flags?.[MODULE_ID]?.isConsumable;
    },
    callback: async (li) => {
      const el     = li instanceof HTMLElement ? li : li[0];
      const itemId = el?.dataset?.documentId || el?.dataset?.entityId;
      const item   = game.items.get(itemId);
      const token  = canvas.tokens.controlled[0];
      if (!token) {
        ui.notifications.warn(game.i18n.localize("CONSUMABLE_EFFECTS.noToken"));
        return;
      }
      const actorItem = token.actor.items.find(
        i => i.name === item.name && i.flags?.[MODULE_ID]?.isConsumable
      );
      if (!actorItem) {
        ui.notifications.warn(game.i18n.localize("CONSUMABLE_EFFECTS.noItem"));
        return;
      }
      await consumeItem(token.actor, actorItem);
    },
  });
});

/**
 * Helper: adds a "Consume" option to any context menu options array.
 * Works for both actor sheet item contexts and WFRP4e-specific contexts.
 * @param {Array} options — the context menu options array to push onto
 * @param {string} source — debug label for which hook called this
 */
function _addConsumeContextOption(options, source) {
  options.push({
    name: game.i18n.localize("CONSUMABLE_EFFECTS.consume"),
    icon: '<i class="fas fa-drumstick-bite"></i>',
    condition: (li) => {
      const el = li instanceof HTMLElement ? li : li[0];
      const itemId = el?.dataset?.documentId || el?.dataset?.entityId || el?.dataset?.itemId;
      if (!itemId) return false;
      // Try to find the item — could be on any actor
      for (const actor of game.actors) {
        const item = actor.items.get(itemId);
        if (item?.flags?.[MODULE_ID]?.isConsumable) return true;
      }
      return false;
    },
    callback: async (li) => {
      const el = li instanceof HTMLElement ? li : li[0];
      const itemId = el?.dataset?.documentId || el?.dataset?.entityId || el?.dataset?.itemId;
      if (!itemId) return;
      // Find the item and its owning actor
      for (const actor of game.actors) {
        const item = actor.items.get(itemId);
        if (item?.flags?.[MODULE_ID]?.isConsumable) {
          await consumeItem(actor, item);
          return;
        }
      }
      ui.notifications.warn(game.i18n.localize("CONSUMABLE_EFFECTS.noItem"));
    },
  });
}

/* ---------- Actor sheet: inject a "Consume" button next to consumable items ----------
 * This renders a small consume button directly in the actor's inventory list
 * next to any item flagged as one of our consumables.  This is the most
 * reliable way to give players access to the consume action regardless of
 * which sheet class or context menu hooks the WFRP4e system provides.
 */
Hooks.on("renderActorSheet", (app, html, data) => {
  const actor = app.document ?? app.object;
  if (!actor) return;

  const element = html instanceof HTMLElement ? html : html[0];
  if (!element) return;

  // Find all inventory item entries in the actor sheet
  const itemEntries = element.querySelectorAll("[data-item-id], [data-document-id]");

  for (const entry of itemEntries) {
    const itemId = entry.dataset.itemId || entry.dataset.documentId;
    if (!itemId) continue;

    const item = actor.items.get(itemId);
    if (!item?.flags?.[MODULE_ID]?.isConsumable) continue;

    // Don't add duplicate buttons on re-render
    if (entry.querySelector("[data-action='ce-consume-inline']")) continue;

    // Create a small consume button and append it to the item row
    const btn = document.createElement("a");
    btn.dataset.action = "ce-consume-inline";
    btn.title = game.i18n.localize("CONSUMABLE_EFFECTS.consume");
    btn.classList.add("ce-inline-consume-btn");
    btn.innerHTML = `<i class="fas fa-drumstick-bite"></i>`;

    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation(); // Don't open the item sheet
      await consumeItem(actor, item);
      // Re-render the actor sheet to reflect quantity change
      app.render(false);
    });

    // Try to insert near the item's controls/buttons area
    const controls = entry.querySelector(".item-controls")
                  || entry.querySelector(".item-buttons")
                  || entry;
    controls.appendChild(btn);
  }
});
