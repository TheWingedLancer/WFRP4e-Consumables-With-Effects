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
 * Converts GM text like "+10 Toughness and remove fatigued for 5 rounds"
 * into a structured object with changes, conditions, healing, and duration.
 * ═══════════════════════════════════════════════════════════════════════════ */

function parseNaturalLanguage(input) {
  const result = {
    changes: [],        // { key, mode, value, label } for ActiveEffect.changes
    conditions: [],     // { name, action:"add"|"remove", count } for actor.addCondition/removeCondition
    duration: null,     // rounds (integer) or null
    heal: null,         // wounds to restore (integer) or null
    effectName: "",     // auto-generated label
  };

  const text = input.toLowerCase().trim();

  // ---- Duration: "for 5 rounds", "lasting 10 rounds", "5 rounds" ----
  const durMatch = text.match(/(?:for|lasting|duration[:\s]*)?\s*(\d+)\s*rounds?/i);
  if (durMatch) result.duration = parseInt(durMatch[1]);

  // ---- Healing: "heal 4 wounds", "restore 3 wounds" ----
  const healMatch = text.match(/(?:heal|restore|recover|regain)\s+(\d+)\s*wounds?/i);
  if (healMatch) result.heal = parseInt(healMatch[1]);

  // ---- Conditions: "add fatigued", "remove stunned", "add 2 bleeding" ----
  // Also: "remove 1 fatigued", "apply poisoned", "cure blinded"
  const condRegex = /(?:add|apply|inflict|give|cause)\s+(?:(\d+)\s+)?(\w+)|(?:remove|cure|clear|dispel)\s+(?:(\d+)\s+)?(\w+)/gi;
  let condMatch;
  while ((condMatch = condRegex.exec(text)) !== null) {
    const isAdd = condMatch[0].match(/^(?:add|apply|inflict|give|cause)/i);
    const count = parseInt(condMatch[1] || condMatch[3] || "1");
    const name = (condMatch[2] || condMatch[4]).toLowerCase();
    if (CONDITIONS.includes(name)) {
      result.conditions.push({
        name,
        action: isAdd ? "add" : "remove",
        count,
        label: `${isAdd ? "Add" : "Remove"} ${count > 1 ? count + "× " : ""}${name.charAt(0).toUpperCase() + name.slice(1)}`,
      });
    }
  }

  // ---- Movement: "+2 movement", "reduce movement by 1" ----
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
  // Split on comma/and, then try 5 regex patterns per segment.
  // Patterns D/E ("increase X by N") must be checked BEFORE A/B/C to avoid false matches.
  const segments = text.split(/\s*(?:,\s*and|,|and)\s*/);

  for (const seg of segments) {
    // Skip segments that are purely condition or heal matches (already handled)
    if (seg.match(/^(?:add|remove|apply|cure|clear|heal|restore|recover|regain)\s/i)) continue;

    // Pattern D: "Increase Agility by 10"
    const pD = seg.match(/(?:add|increase|boost|raise|grant|give)\s+([a-z\s]+?)\s+by\s+(\d+)/i);
    // Pattern E: "Decrease Strength by 5"
    const pE = seg.match(/(?:subtract|decrease|reduce|lower|remove|drain)\s+([a-z\s]+?)\s+by\s+(\d+)/i);
    // Pattern A: "+10 Toughness" or "-5 WS"
    const pA = seg.match(/([+-]?\s*\d+)\s+(?:to\s+)?([a-z\s]+?)(?:\s+(?:for|lasting|duration)|$)/i);
    // Pattern B: "Add 20 to Weapon Skill"
    const pB = seg.match(/(?:add|increase|boost|raise|grant|give)\s+(\d+)\s+(?:to\s+)?([a-z\s]+?)(?:\s+(?:for|lasting|duration)|$)/i);
    // Pattern C: "Subtract 10 from Agility"
    const pC = seg.match(/(?:subtract|decrease|reduce|lower|drain)\s+(\d+)\s+(?:from\s+|to\s+)?([a-z\s]+?)(?:\s+(?:for|lasting|duration)|$)/i);

    let charName = null, value = null;
    if (pD)      { charName = pD[1].trim(); value = parseInt(pD[2]); }
    else if (pE) { charName = pE[1].trim(); value = -parseInt(pE[2]); }
    else if (pA) { value = parseInt(pA[1].replace(/\s/g, "")); charName = pA[2].trim(); }
    else if (pB) { value = parseInt(pB[1]); charName = pB[2].trim(); }
    else if (pC) { value = -parseInt(pC[1]); charName = pC[2].trim(); }

    if (charName && value !== null) {
      if (charName.includes("movement") || charName.includes("wound")) continue;
      const abbrev = CHAR_MAP[charName];
      if (!abbrev) continue;

      const label = CHAR_LABELS[abbrev];
      result.changes.push({
        key: `system.characteristics.${abbrev}.modifier`,
        mode: 2, value: String(value),
        label: `${value >= 0 ? "+" : ""}${value} ${label}`,
      });

      // Derived offset for Wounds protection
      if (DERIVED_CHARS.includes(abbrev)) {
        const offset = Math.floor(Math.abs(value) / 10) * (value < 0 ? 1 : -1);
        result.changes.push({
          key: `system.characteristics.${abbrev}.calculationBonusModifier`,
          mode: 2, value: String(offset),
          label: `(${label} derived offset)`,
        });
      }
    }
  }

  // ---- Build effect name ----
  const parts = [];
  for (const c of result.changes) { if (!c.label.startsWith("(")) parts.push(c.label); }
  for (const c of result.conditions) parts.push(c.label);
  if (result.heal) parts.push(`Heal ${result.heal} Wounds`);
  result.effectName = parts.join(", ") || "Consumable Effect";

  return result;
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
    if (!p || (p.changes.length === 0 && !p.heal && p.conditions.length === 0)) {
      ui.notifications.warn(game.i18n.localize("CONSUMABLE_EFFECTS.parseError"));
      return;
    }

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
      },
      flags: {
        [MODULE_ID]: {
          isConsumable: true,
          healAmount: p.heal,
          conditions: p.conditions,
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
        icon,
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
// WFRP4e uses DIV.list-row[data-uuid] for inventory items.
// We resolve each UUID to check for our isConsumable flag.
Hooks.on("renderActorSheet", async (app, html, data) => {
  const actor = app.document ?? app.object;
  if (!actor) return;

  const element = html instanceof HTMLElement ? html : html[0];
  if (!element) return;

  // Find all list-row elements with a data-uuid attribute (WFRP4e inventory items)
  const rows = element.querySelectorAll("div.list-row[data-uuid]");

  for (const row of rows) {
    const uuid = row.dataset.uuid;
    if (!uuid) continue;

    // Resolve the UUID to get the actual Item document
    let item;
    try { item = await fromUuid(uuid); } catch { continue; }
    if (!item?.flags?.[MODULE_ID]?.isConsumable) continue;

    // Don't add duplicate buttons
    if (row.querySelector("[data-action='ce-consume']")) continue;

    // Create consume button icon
    const btn = document.createElement("a");
    btn.dataset.action = "ce-consume";
    btn.title = game.i18n.localize("CONSUMABLE_EFFECTS.consume");
    btn.classList.add("ce-consume-btn");
    btn.innerHTML = `<i class="fas fa-drumstick-bite"></i>`;

    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await consumeItem(actor, item);
      app.render(false);
    });

    // Append to the row — WFRP4e list-rows are flex containers
    row.appendChild(btn);
  }
});

// ---- Item Sheet: inject consume button on consumable item sheets ----
Hooks.on("renderItemSheet", (app, html, data) => {
  const item = app.document ?? app.object;
  if (!item?.flags?.[MODULE_ID]?.isConsumable) return;

  const element = html instanceof HTMLElement ? html : html[0];
  if (!element) return;
  if (element.querySelector("[data-action='ce-consume']")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.action = "ce-consume";
  btn.innerHTML = `<i class="fas fa-drumstick-bite"></i> ${game.i18n.localize("CONSUMABLE_EFFECTS.consume")}`;

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
});
