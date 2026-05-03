import { FLAG_STATE, localize, MODULE_ID } from "./config.mjs";
import { executeMutation } from "./socket.mjs";
import { extractReactiveRollResult } from "./operations.mjs";
import { userCanApplyForMessage } from "./permissions.mjs";
import { getMessageState, hasModuleState, mutateMessageState, setMessageState } from "./state.mjs";
import {
  collectCurrentTargets,
  computePowerRollSummary,
  computeTierFromDice,
  findDamageRollPart,
  findResultPartForTier,
  findTargetPart,
  getAbilityItem,
  getAbilityUuid,
  getMessageAuthorId,
  getPartId,
  getParts,
  getRenderableTargets,
  getSpeakerTokenDocument,
  getTargetKey,
  getTierGlyph,
  hasDamageRolls,
  hasPowerRolls,
  isAbilityMessage,
  isPowerRoll,
  isRollResultPart,
  isReactiveAbilityMessage,
  makeOperationId,
  normalizeTargetToken,
  readNaturalRoll,
  resolveTarget,
  shouldManageMessage,
} from "./target-utils.mjs";

const PANEL_CLASS = `${MODULE_ID}-panel`;
const APPLY_EFFECT_SELECTOR = `.roll-link[data-type="status"], .roll-link[data-type="custom"]`;

const DAMAGE_TYPE_ICONS = {
  acid: "fa-solid fa-flask-vial",
  cold: "fa-solid fa-snowflake",
  corruption: "fa-brands fa-galactic-republic",
  fire: "fa-solid fa-fire",
  holy: "fa-solid fa-sun",
  lightning: "fa-solid fa-bolt",
  poison: "fa-solid fa-skull-crossbones",
  psychic: "fa-solid fa-brain",
  sonic: "fa-solid fa-volume-high",
};

const HIDDEN_SYSTEM_DIVIDER_CLASS = `${MODULE_ID}-hidden-system-divider`;
const HIDDEN_SYSTEM_RESULT_CLASS = `${MODULE_ID}-hidden-system-result`;
const HIDDEN_SYSTEM_WRAPPER_CLASS = `${MODULE_ID}-hidden-system-wrapper`;
const TRIM_SYSTEM_DIVIDER_CLASS = `${MODULE_ID}-trim-system-divider`;
const collapseStateByMessageId = new Map();
const localStateByMessageId = new Map();

/* ============================================================ */
/* Hooks                                                        */
/* ============================================================ */

export function initializeChatTargeting() {
  Hooks.on("preCreateChatMessage", (message, _data, _options, userId) => {
    if (game.user.id !== userId) return;
    if (!shouldManageMessage(message)) return;
    initializeMessageSource(message);
  });

  Hooks.on("createChatMessage", (message, _options, userId) => {
    if (game.user.id !== userId) return;
    if (!shouldManageMessage(message)) return;
    initializeMessageState(message);
  });

  Hooks.on("renderChatMessage", (message, html) => renderChatMessageTargets(message, html));
  Hooks.on("renderChatMessageHTML", (message, html) => renderChatMessageTargets(message, html));
  Hooks.on("renderChatLog", () => refreshExistingChatMessages());

  Hooks.on("updateChatMessage", (message, changed) => {
    const changedState = foundry.utils.hasProperty(changed, `flags.${MODULE_ID}.${FLAG_STATE}`)
      || foundry.utils.hasProperty(changed, `flags.${MODULE_ID}`)
      || foundry.utils.hasProperty(changed, "flags");
    const changedRolls = foundry.utils.hasProperty(changed, "system") || foundry.utils.hasProperty(changed, "rolls");

    if (changedRolls) {
      syncReactiveResultFromTestMessage(message).catch(error => {
        console.warn(`${MODULE_ID} | Could not sync reactive reroll`, error);
      });
    }

    if (changedState) reconcileLocalState(message);

    if (changedState || changedRolls) rerenderMessage(message);
  });

  window.setTimeout(refreshExistingChatMessages, 0);
  window.setTimeout(refreshExistingChatMessages, 250);
}

export function refreshExistingChatMessages() {
  for (const message of game.messages ?? []) {
    const root = document.querySelector(`li.chat-message[data-message-id="${message.id}"]`);
    if (!root) continue;
    if (!canRenderTargetPanel(message, root)) {
      root.querySelector(`.${PANEL_CLASS}`)?.remove();
      continue;
    }
    renderChatMessageTargets(message, root);
  }
}

export function getChatTargetingDebugInfo(message = game.messages.contents.at(-1)) {
  if (!message) return { moduleActive: true, message: null };

  const state = hasModuleState(message) || localStateByMessageId.has(message.id) ? getEffectiveMessageState(message) : null;
  return {
    moduleActive: true,
    messageId: message.id,
    messageType: message.type,
    authorId: getMessageAuthorId(message),
    isAbilityMessage: isAbilityMessage(message),
    shouldManageMessage: shouldManageMessage(message),
    abilityUuid: getAbilityUuid(message),
    hasTargetState: !!state,
    targetCount: state?.targets?.length ?? 0,
    parts: getParts(message).map(part => ({
      id: getPartId(part),
      type: part.type,
      tier: part.tier ?? null,
      abilityUuid: part.abilityUuid ?? null,
      rollCount: part.rolls?.length ?? 0,
      rollTypes: Array.from(part.rolls ?? []).map(roll => roll.constructor?.name ?? typeof roll),
      rollTargets: Array.from(part.rolls ?? []).map(roll => roll?.options?.target ?? null),
    })),
    panelInDom: !!document.querySelector(`[data-message-id="${message.id}"] .${PANEL_CLASS}`),
  };
}

/* ============================================================ */
/* Render entry                                                 */
/* ============================================================ */

function rerenderMessage(message) {
  const li = document.querySelector(`li.chat-message[data-message-id="${message.id}"]`);
  if (!li) return;
  renderChatMessageTargets(message, li);
}

function renderChatMessageTargets(message, html) {
  const root = getHtmlRoot(html);
  if (!root) return;
  const state = getRenderState(message, root);
  renderTargetPanel(message, root, state ?? null);
}

function getHtmlRoot(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.jquery) return html[0] ?? null;
  return html?.[0] instanceof HTMLElement ? html[0] : null;
}

function hasApplyEffectLinks(root) {
  return !!root?.querySelector?.(APPLY_EFFECT_SELECTOR);
}

function buildApplyActionsFromHtml(root) {
  return Array.from(root?.querySelectorAll?.(APPLY_EFFECT_SELECTOR) ?? []).map((link, index) => {
    const effectId = link.dataset.status ?? link.dataset.uuid ?? `apply-${index}`;
    const effectUuid = link.dataset.uuid ?? "";
    const label = link.textContent.trim() || getStatusEffectLabel(effectId, effectUuid);
    const status = CONFIG.statusEffects?.find(effect => effect.id === effectId);
    const customEffect = safeFromUuidSync(effectUuid);
    return {
      partId: "apply",
      tier: 0,
      effectId,
      effectUuid,
      label,
      icon: (status?.img || status?.icon || customEffect?.img) ? null : "fa-solid fa-person-rays",
      iconImg: status?.img ?? status?.icon ?? customEffect?.img ?? null,
    };
  });
}

function getStatusEffectLabel(effectId, effectUuid) {
  const status = CONFIG.statusEffects?.find(effect => effect.id === effectId);
  if (status?.name) return game.i18n.localize(status.name);
  const effect = safeFromUuidSync(effectUuid);
  return effect?.name ?? effectId;
}

/* ============================================================ */
/* State init                                                   */
/* ============================================================ */

function getRenderState(message, root = null) {
  if (!canRenderTargetPanel(message, root)) return;
  if (hasModuleState(message) || localStateByMessageId.has(message.id)) return getEffectiveMessageState(message);

  const authorId = getMessageAuthorId(message);
  if (authorId && authorId !== game.user.id) return;

  const state = buildInitialMessageState(message, { hasApplyLinks: hasApplyEffectLinks(root) });
  if (!state) return;
  setMessageState(message, state).catch(error => {
    console.warn(`${MODULE_ID} | Could not persist target state`, error);
  });
  return state;
}

function canRenderTargetPanel(message, root = null) {
  if (shouldManageMessage(message) || hasApplyEffectLinks(root)) return true;
  if (!hasModuleState(message) && !localStateByMessageId.has(message.id)) return false;

  const state = getEffectiveMessageState(message);
  return !!state.abilityUuid
    || !!state.isReactive
    || Object.keys(state.reactiveResults ?? {}).length > 0
    || Object.keys(state.applications ?? {}).length > 0
    || Object.keys(state.tierOverrides ?? {}).length > 0
    || Object.keys(state.damageOverrides ?? {}).length > 0;
}

function initializeMessageSource(message) {
  if (hasModuleState(message)) return;
  const state = buildInitialMessageState(message);
  if (!state) return;
  message.updateSource({ [`flags.${MODULE_ID}.${FLAG_STATE}`]: state });
}

async function initializeMessageState(message) {
  if (hasModuleState(message)) return;
  const state = buildInitialMessageState(message);
  if (!state) return;
  try {
    await setMessageState(message, state);
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not initialize target state`, error);
  }
}

function buildInitialMessageState(message, { hasApplyLinks = false } = {}) {
  const ability = getAbilityItem(message);
  const hasDamageRoll = hasDamageRolls(message) || getParts(message).some(part => hasDamageRolls(part));
  const hasPowerRoll = getParts(message).some(part => hasPowerRolls(part));
  const isReactive = ability?.type === "ability" && !!ability.system?.power?.roll?.reactive;
  if (!hasDamageRoll && !hasPowerRoll && !hasApplyLinks && !isReactive) return null;

  const speakerToken = getSpeakerTokenDocument(message);
  const speakerActor = message.speakerActor ?? speakerToken?.actor ?? ability?.actor ?? game.actors.get(message.speaker?.actor);
  return {
    version: 1,
    sourceUserId: game.user.id,
    sourceUserName: game.user.name,
    targetingUserId: game.user.id,
    targetingUserName: game.user.name,
    sourceActorId: speakerActor?.id ?? null,
    sourceActorUuid: speakerActor?.uuid ?? null,
    sourceActorName: speakerActor?.name ?? message.speaker?.alias ?? "",
    sourceTokenUuid: speakerToken?.uuid ?? null,
    abilityUuid: ability?.uuid ?? null,
    abilityName: ability?.name ?? message.title ?? message.flavor ?? "",
    abilityImg: ability?.img ?? null,
    isReactive,
    targets: collectCurrentTargets(),
    applications: {},
    reactiveResults: {},
    tierOverrides: {},
    damageOverrides: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/* ============================================================ */
/* Panel                                                        */
/* ============================================================ */

function renderTargetPanel(message, html, state) {
  const existing = html.querySelector(`.${PANEL_CLASS}`);
  const targets = getRenderableTargets(state);
  const collapseState = targets.length > 1
    ? mergeCollapseState(collectCollapseState(existing), getRememberedCollapseState(message.id))
    : new Map();
  if (existing) existing.remove();
  if (!state) return;

  const isReactive = (state.isReactive || isReactiveAbilityMessage(message)) && !getParts(message).some(part => hasPowerRolls(part));
  const renderContext = {
    applyActions: buildApplyActionsFromHtml(html),
    collapseState,
    targetCount: targets.length,
  };

  const panel = document.createElement("section");
  panel.classList.add(PANEL_CLASS);
  panel.dataset.messageId = message.id;

  panel.append(createPanelHeader(message, state, isReactive));

  if (!targets.length) {
    const empty = document.createElement("p");
    empty.classList.add(`${MODULE_ID}-empty`);
    empty.textContent = localize("Chat.NoTargets");
    panel.append(empty);

    const baseRow = createBaseResultRow(message, state, renderContext);
    if (baseRow) panel.append(baseRow);
  } else {
    const list = document.createElement("div");
    list.classList.add(`${MODULE_ID}-target-list`);
    for (const target of targets) {
      list.append(isReactive
        ? createReactiveTargetRow(message, state, target)
        : createTargetRow(message, state, target, renderContext));
    }
    panel.append(list);
  }

  panel.classList.toggle(`${MODULE_ID}-single-target`, panel.querySelectorAll(`.${MODULE_ID}-target-row[data-target-key]`).length === 1);

  panel.addEventListener("click", event => handlePanelClick(event, message));

  const dsFooter = html.querySelector(":scope > footer");
  if (dsFooter) dsFooter.insertAdjacentElement("beforebegin", panel);
  else html.insertAdjacentElement("beforeend", panel);

  hideAdjacentSystemDividers(message, html, panel);
  rememberCollapseState(message.id, panel);
}

function createPanelHeader(message, state, isReactive) {
  const header = document.createElement("header");
  header.classList.add(`${MODULE_ID}-header`);

  const titleWrap = document.createElement("div");
  titleWrap.classList.add(`${MODULE_ID}-header-text`);

  const title = document.createElement("strong");
  title.textContent = localize(isReactive ? "Chat.ReactivePanelTitle" : "Chat.TargetPanelTitle");

  const targeting = document.createElement("span");
  const sourceName = state.sourceActorName
    || state.targetingUserName
    || state.sourceUserName
    || game.users.get(getMessageAuthorId(message))?.name
    || "";
  targeting.textContent = localize("Chat.TargetingLine", { name: sourceName });

  titleWrap.append(title, targeting);
  header.append(titleWrap);

  const button = createIconButton({
    icon: "fa-solid fa-bullseye",
    label: localize("Chat.UpdateTargets"),
    action: "updateTargets",
    tooltip: localize("Chat.UpdateTargets"),
    classes: [`${MODULE_ID}-update-targets`],
  });
  header.append(button);

  return header;
}

/* ============================================================ */
/* Target rows (proactive abilities)                            */
/* ============================================================ */

function createBaseResultRow(message, state, renderContext = {}) {
  const matched = findBaseResultPart(message);
  const applyActions = renderContext.applyActions ?? [];
  if (!matched && !applyActions.length) return null;

  const syntheticTarget = {
    selectedToken: true,
    name: localize("Chat.SelectedToken"),
    img: "icons/svg/target.svg",
  };
  const row = createTargetShell(syntheticTarget);
  const body = getTargetBody(row);

  if (matched?.powerRoll) {
    body.append(createRollDisplay(message, state, syntheticTarget, matched, Number(matched.part?.tier) || Number(matched.powerRoll.product) || null));
  }

  const damageActions = matched ? buildDamageActionsForPart(matched.part) : [];
  const statusActions = matched
    ? buildStatusActionsForPart(matched.part, Number(matched.part?.tier) || Number(matched.powerRoll?.product) || null, message)
    : [];
  statusActions.push(...applyActions);
  if (!matched?.powerRoll && !damageActions.length && !statusActions.length) return null;

  const actions = document.createElement("div");
  actions.classList.add(`${MODULE_ID}-target-actions`);
  for (const action of damageActions) actions.append(createDamageActionRow(message, state, syntheticTarget, action));
  for (const action of statusActions) actions.append(createStatusActionRow(message, state, syntheticTarget, action));
  if (actions.childElementCount) body.append(actions);
  else body.append(createNoActionsElement());
  return row;
}

function findBaseResultPart(message) {
  const resultParts = getParts(message).filter(part => isRollResultPart(part) && hasPowerRolls(part));
  const part = resultParts.find(candidate => (candidate.rolls ?? []).some(roll => isPowerRoll(roll) && !roll?.options?.target))
    ?? resultParts[0]
    ?? null;
  if (!part) return findDamageRollPart(message);
  const rolls = Array.from(part.rolls ?? []).reverse();
  const powerRoll = rolls.find(roll => isPowerRoll(roll) && !roll?.options?.target)
    ?? rolls.find(roll => isPowerRoll(roll))
    ?? null;
  return { part, powerRoll, partId: getPartId(part) };
}

function createTargetRow(message, state, target, renderContext = {}) {
  // Resolve the part for this specific target (so we get THIS target's tier/damage/effects).
  const matched = findTargetPart(message, target) ?? findBaseResultPart(message);
  const tierOverride = state.tierOverrides?.[getTargetKey(target)] ?? null;
  const tier = tierOverride?.tier ?? Number(matched?.part?.tier) ?? Number(matched?.powerRoll?.product) ?? null;
  const tierPart = findResultPartForTier(message, tier);
  const actionPart = tierOverride ? tierPart : (tierPart ?? matched?.part ?? null);
  const damageActions = actionPart ? buildDamageActionsForPart(actionPart) : [];
  if (!damageActions.length && tier) damageActions.push(...buildDamageActionsForTier(message, tier));
  const statusActions = buildStatusActionsForPart(actionPart ?? matched?.part, tier, message);
  statusActions.push(...(renderContext.applyActions ?? []));
  const targetCount = renderContext.targetCount ?? getRenderableTargets(state).length;
  const quickDamageAction = targetCount > 1 ? damageActions[0] ?? null : null;

  const row = createTargetShell(target, { collapsed: getInitialCollapsedState(target, renderContext, targetCount > 1) });
  if (quickDamageAction) addQuickDamageButton(row, message, state, target, quickDamageAction);
  const body = getTargetBody(row);

  // Roll display
  if (matched?.powerRoll) {
    body.append(createRollDisplay(message, state, target, matched, tier));
  }

  if (damageActions.length || statusActions.length) {
    const actions = document.createElement("div");
    actions.classList.add(`${MODULE_ID}-target-actions`);
    for (const action of damageActions) {
      actions.append(createDamageActionRow(message, state, target, action));
    }
    for (const action of statusActions) {
      actions.append(createStatusActionRow(message, state, target, action));
    }
    body.append(actions);
  } else if (!matched) {
    // No matched part at all and no power roll either -> nothing to do
  } else {
    body.append(createNoActionsElement());
  }

  return row;
}

function createTargetShell(target, { collapsed = false } = {}) {
  const row = document.createElement("div");
  row.classList.add(`${MODULE_ID}-target-row`);
  row.dataset.targetKey = getTargetKey(target);
  if (collapsed) row.classList.add("is-collapsed");

  const head = document.createElement("div");
  head.classList.add(`${MODULE_ID}-target-head`);
  head.dataset.dstdAction = "toggleTarget";
  head.setAttribute("role", "button");
  head.tabIndex = 0;

  const portrait = document.createElement("img");
  portrait.classList.add(`${MODULE_ID}-portrait`);
  portrait.src = target.img || "icons/svg/mystery-man.svg";
  portrait.alt = target.name || "";

  const name = document.createElement("div");
  name.classList.add(`${MODULE_ID}-target-name`);
  name.textContent = target.name || "Unknown";

  const toggle = document.createElement("i");
  toggle.className = `fa-solid fa-chevron-down ${MODULE_ID}-target-toggle`;

  const body = document.createElement("div");
  body.classList.add(`${MODULE_ID}-target-body`);

  head.append(portrait, name, toggle);
  row.append(head, body);
  return row;
}

function addQuickDamageButton(row, message, state, target, action) {
  const head = row.querySelector(`.${MODULE_ID}-target-head`);
  const toggle = row.querySelector(`.${MODULE_ID}-target-toggle`);
  if (!head || !toggle) return;

  const canApply = userCanApplyForMessage(game.user, message, state);
  const operationId = makeOperationId("damage", target, action);
  const record = state.applications?.[operationId];
  const button = createActionButton({
    icon: damageIconForType(getEffectiveDamageType(state, target, action), action.isHeal),
    label: compactDamageLabel(state, target, action, record),
    action: "applyDamage",
    target,
    operationId,
    disabled: record?.status === "applied" || !canApply,
    tooltip: applyControlTooltip(canApply, action.isHeal ? null : localize("Chat.ApplyDamageTooltip")),
    extraDataset: damageActionDataset(action),
    classes: [`${MODULE_ID}-quick-damage`, damageTypeClass(getEffectiveDamageType(state, target, action), action.isHeal)],
  });

  head.insertBefore(button, toggle);
}

function getTargetBody(row) {
  return row.querySelector(`.${MODULE_ID}-target-body`) ?? row;
}

function collectCollapseState(panel) {
  const state = new Map();
  if (!panel) return state;
  for (const row of panel.querySelectorAll(`.${MODULE_ID}-target-row[data-target-key]`)) {
    state.set(row.dataset.targetKey, row.classList.contains("is-collapsed"));
  }
  return state;
}

function mergeCollapseState(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [key, value] of map ?? []) merged.set(key, value);
  }
  return merged;
}

function getRememberedCollapseState(messageId) {
  return collapseStateByMessageId.get(messageId) ?? new Map();
}

function rememberCurrentCollapseState(messageId) {
  const panel = document.querySelector(`li.chat-message[data-message-id="${messageId}"] .${PANEL_CLASS}`);
  return rememberCollapseState(messageId, panel);
}

function rememberCollapseState(messageId, panel) {
  const state = collectCollapseState(panel);
  if (state.size > 1) collapseStateByMessageId.set(messageId, state);
  else collapseStateByMessageId.delete(messageId);
  return state;
}

function getInitialCollapsedState(target, renderContext, fallback) {
  if (Number(renderContext.targetCount ?? 0) <= 1) return false;
  const key = getTargetKey(target);
  return renderContext.collapseState?.has(key) ? renderContext.collapseState.get(key) : fallback;
}

function createNoActionsElement() {
  const empty = document.createElement("span");
  empty.classList.add(`${MODULE_ID}-muted`);
  empty.textContent = localize("Chat.NoActions");
  return empty;
}

/* ============================================================ */
/* Per-target ability roll display                              */
/* ============================================================ */

function createRollDisplay(message, state, target, matched, tier) {
  const wrap = document.createElement("div");
  wrap.classList.add(`${MODULE_ID}-roll-display`);

  const powerRoll = matched.powerRoll;
  const override = state.tierOverrides?.[getTargetKey(target)];
  const summary = computePowerRollSummary(powerRoll, override);
  const effectiveTier = override?.tier ?? tier ?? summary.tier;
  if (summary.isCritical) wrap.classList.add("is-critical");

  // Tier line: "Tier N (X Edge(s)/Bane(s))"
  const tierLine = document.createElement("div");
  tierLine.classList.add(`${MODULE_ID}-tier-line`);
  tierLine.textContent = formatTierLine(effectiveTier, summary.edges, summary.banes, summary.bonuses, summary.isCritical);

  const tierRow = document.createElement("div");
  tierRow.classList.add(`${MODULE_ID}-tier-row`);
  tierRow.append(tierLine);
  wrap.append(tierRow);

  // Roll breakdown box: formula on left, divider, total on right
  const rollLine = document.createElement("div");
  rollLine.classList.add(`${MODULE_ID}-roll-line`);

  const box = document.createElement("div");
  box.classList.add(`${MODULE_ID}-roll-box`);
  const formula = document.createElement("span");
  formula.classList.add(`${MODULE_ID}-roll-formula`);
  formula.textContent = summary.formula;
  const total = document.createElement("span");
  total.classList.add(`${MODULE_ID}-roll-total`);
  total.textContent = String(summary.total ?? "");
  box.append(formula, total);

  const editRollBtn = createIconButton({
    icon: "fa-solid fa-gear",
    action: "editRoll",
    tooltip: localize("Chat.EditRoll"),
    classes: [`${MODULE_ID}-cog-button`],
    extraDataset: { target: JSON.stringify(target) },
    iconOnly: true,
  });

  const tooltip = formatRollBreakdownTooltip(powerRoll, summary);
  if (tooltip) {
    rollLine.dataset.tooltip = tooltip;
    rollLine.setAttribute("aria-label", tooltip);
  }

  // Tier glyph + tier result text from the ability itself.
  const tierResult = document.createElement("dl");
  tierResult.classList.add(`${MODULE_ID}-tier-result`, "power-roll-display");
  const glyph = getTierGlyph(effectiveTier);
  if (glyph) {
    const glyphEl = document.createElement("dt");
    glyphEl.classList.add(`${MODULE_ID}-tier-glyph`, "glyph", `tier${effectiveTier}`);
    const glyphText = document.createElement("p");
    glyphText.textContent = glyph;
    glyphEl.append(glyphText);
    tierResult.append(glyphEl);
  }
  const tierText = document.createElement("dd");
  tierText.classList.add(`${MODULE_ID}-tier-text`);
  tierText.textContent = "...";
  tierResult.append(tierText);
  hydrateTierDescription(message, effectiveTier, tierText);
  wrap.append(tierResult);

  rollLine.append(box, editRollBtn);
  wrap.append(rollLine);

  return wrap;
}

function formatRollBreakdownTooltip(powerRoll, summary) {
  const dice = getPowerRollDiceResults(powerRoll);
  const lines = [];
  if (dice.length) lines.push(`Dice: ${dice.join(" + ")} = ${summary.naturalTotal}`);
  else lines.push(`Dice total: ${summary.naturalTotal}`);
  if (summary.staticModifier) lines.push(`Modifier: ${formatSignedNumber(summary.staticModifier)}`);
  if (Math.abs(summary.net) === 1) lines.push(`${summary.net > 0 ? "Edge" : "Bane"}: ${formatSignedNumber(Math.sign(summary.net) * 2)}`);
  else if (Math.abs(summary.net) > 1) lines.push(`${summary.net > 0 ? "Edges" : "Banes"}: ${formatSignedNumber(summary.net - Math.sign(summary.net))} tier`);
  if (summary.bonuses) lines.push(`Bonus/Penalty: ${formatSignedNumber(summary.bonuses)}`);
  lines.push(`Total: ${summary.total}`);
  lines.push(`Tier: ${summary.tier}`);
  return lines.join("\n");
}

function getPowerRollDiceResults(powerRoll) {
  const die = powerRoll?.dice?.[0] ?? powerRoll?.terms?.find(term => Number(term?.faces) === 10);
  return Array.from(die?.results ?? [])
    .map(result => Number(result.result ?? result.count ?? result.value))
    .filter(Number.isFinite);
}

function formatSignedNumber(value) {
  const number = Number(value) || 0;
  return `${number >= 0 ? "+" : "-"}${Math.abs(number)}`;
}

function formatTierLine(tier, edges, banes, bonuses, isCritical) {
  if (isCritical) return localize("Chat.TierLineCritical", { tier: tier ?? "?" });
  let modifiers = "";
  const e = Number(edges) || 0;
  const b = Number(banes) || 0;
  const bonus = Number(bonuses) || 0;
  if (e && !b) modifiers = ` (${e} Edge${e === 1 ? "" : "s"})`;
  else if (b && !e) modifiers = ` (${b} Bane${b === 1 ? "" : "s"})`;
  else if (e && b) modifiers = ` (${e} Edge${e === 1 ? "" : "s"}, ${b} Bane${b === 1 ? "" : "s"})`;
  if (bonus) modifiers += `${modifiers ? " " : " ("}${bonus > 0 ? "+" : ""}${bonus} ${bonus > 0 ? "Bonus" : "Penalty"}${modifiers ? "" : ")"}`;
  return localize("Chat.TierLine", { tier: tier ?? "?", modifiers });
}

async function hydrateTierDescription(message, tier, element) {
  try {
    const ability = getAbilityItem(message);
    const html = await ability?.system?.powerRollText?.(Number(tier));
    if (!html) return;
    element.innerHTML = html;
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not render tier description`, error);
    element.textContent = `Tier ${tier}`;
  }
}

/* ============================================================ */
/* Reactive rows (unchanged behavior)                           */
/* ============================================================ */

function createReactiveTargetRow(message, state, target) {
  const row = createTargetShell(target);
  const body = getTargetBody(row);
  const reactiveActions = buildReactiveActions(message);

  const actions = document.createElement("div");
  actions.classList.add(`${MODULE_ID}-target-actions`);

  for (const action of reactiveActions) {
    const operationId = makeOperationId("reactive", target, action);
    const result = state.reactiveResults?.[operationId];

    const group = document.createElement("div");
    group.classList.add(`${MODULE_ID}-action-row`, `${MODULE_ID}-reactive-row`);

    const button = createActionButton({
      icon: "fa-solid fa-dice-d10",
      label: localize("Chat.RollTest", { characteristic: action.label }),
      action: "rollReactive",
      target,
      operationId,
      extraDataset: {
        characteristic: action.characteristic,
        abilityUuid: getAbilityUuid(message) ?? "",
      },
    });

    const badge = document.createElement("span");
    badge.classList.add(`${MODULE_ID}-result-badge`);
    badge.textContent = result
      ? localize("Chat.TierResult", { tier: result.tier, total: result.total })
      : localize("Chat.ResultPending");

    group.append(button, badge);
    actions.append(group);
  }

  body.append(actions);
  return row;
}

/* ============================================================ */
/* Damage/status action rows                                    */
/* ============================================================ */

function createDamageActionRow(message, state, target, action) {
  const operationId = makeOperationId("damage", target, action);
  const record = state.applications?.[operationId];
  const canApply = userCanApplyForMessage(game.user, message, state);
  const isSelectedTokenStack = !!target?.selectedToken;
  const stackCount = getApplicationStackCount(record);
  const isApplied = !isSelectedTokenStack && record?.status === "applied";
  const isUndone = !isSelectedTokenStack && record?.status === "undone";
  const override = state.damageOverrides?.[operationId];

  const baseAmount = override?.amount != null ? Number(override.amount) : Number(action.amount);
  const damageType = override?.damageType ?? action.damageType;
  const typeLabel = override?.typeLabel ?? action.typeLabel;

  const row = document.createElement("div");
  row.classList.add(`${MODULE_ID}-action-row`, `${MODULE_ID}-damage-row`);
  if (isApplied) row.classList.add("is-applied");
  if (isUndone) row.classList.add("is-undone");
  if (isSelectedTokenStack && stackCount) row.classList.add("has-stack");

  let label;
  if (action.isHeal) {
    label = typeLabel
      ? localize("Chat.ApplyTypedHealing", { amount: baseAmount, type: typeLabel })
      : localize("Chat.ApplyHealing", { amount: baseAmount });
  } else {
    label = typeLabel
      ? localize("Chat.ApplyTypedDamage", { amount: baseAmount, type: typeLabel })
      : localize("Chat.ApplyDamage", { amount: baseAmount });
  }

  const applyButton = createActionButton({
    icon: damageIconForType(damageType, action.isHeal),
    label: isApplied ? appliedLabel(record) : label,
    action: "applyDamage",
    target,
    operationId,
    disabled: isApplied || !canApply,
    tooltip: applyControlTooltip(canApply, action.isHeal ? null : localize("Chat.ApplyDamageTooltip")),
    extraDataset: damageActionDataset(action),
    classes: [`${MODULE_ID}-stretch-button`, damageTypeClass(damageType, action.isHeal)],
  });

  const editButton = createIconButton({
    icon: "fa-solid fa-gear",
    action: "editDamage",
    tooltip: localize("Chat.EditDamage"),
    classes: [`${MODULE_ID}-cog-button`],
    extraDataset: {
      target: JSON.stringify(target),
      operationId,
      ...damageActionDataset(action),
    },
    iconOnly: true,
  });

  const undoButton = createIconButton({
    icon: "fa-solid fa-rotate-left",
    action: "undoDamage",
    tooltip: applyControlTooltip(canApply, localize("Chat.Undo")),
    disabled: (isSelectedTokenStack ? stackCount <= 0 : !isApplied) || !canApply,
    classes: [`${MODULE_ID}-undo-button`],
    extraDataset: {
      target: JSON.stringify(target),
      operationId,
    },
    iconOnly: true,
  });

  if (isSelectedTokenStack && stackCount > 0) appendUndoBadge(undoButton, stackCount);

  row.append(applyButton, undoButton, editButton);
  return row;
}

function createStatusActionRow(message, state, target, action) {
  const operationId = makeOperationId("status", target, action);
  const record = state.applications?.[operationId];
  const canApply = userCanApplyForMessage(game.user, message, state);
  const isSelectedTokenStack = !!target?.selectedToken;
  const stackCount = getApplicationStackCount(record);
  const isApplied = !isSelectedTokenStack && record?.status === "applied";
  const isUndone = !isSelectedTokenStack && record?.status === "undone";

  const row = document.createElement("div");
  row.classList.add(`${MODULE_ID}-action-row`, `${MODULE_ID}-status-row`);
  if (isApplied) row.classList.add("is-applied");
  if (isUndone) row.classList.add("is-undone");
  if (isSelectedTokenStack && stackCount) row.classList.add("has-stack");

  const applyButton = createActionButton({
    icon: action.icon,
    iconImg: action.iconImg,
    label: isApplied ? `${localize("Chat.Applied")}: ${action.label}` : localize("Chat.ApplyStatus", { name: action.label }),
    action: "applyStatus",
    target,
    operationId,
    disabled: isApplied || !canApply,
    tooltip: applyControlTooltip(canApply),
    extraDataset: {
      partId: action.partId,
      tier: String(action.tier),
      effectId: action.effectId,
      effectUuid: action.effectUuid,
    },
    classes: [`${MODULE_ID}-stretch-button`],
  });

  const undoButton = createIconButton({
    icon: "fa-solid fa-rotate-left",
    action: "undoStatus",
    tooltip: applyControlTooltip(canApply, localize("Chat.Undo")),
    disabled: (isSelectedTokenStack ? stackCount <= 0 : !isApplied) || !canApply,
    classes: [`${MODULE_ID}-undo-button`],
    extraDataset: {
      target: JSON.stringify(target),
      operationId,
    },
    iconOnly: true,
  });

  if (isSelectedTokenStack && stackCount > 0) appendUndoBadge(undoButton, stackCount);

  row.append(applyButton, undoButton);
  return row;
}

function getApplicationStackCount(record) {
  if (Array.isArray(record?.stack)) return record.stack.length;
  return record?.status === "applied" ? 1 : 0;
}

function appendUndoBadge(button, count) {
  const badge = document.createElement("span");
  badge.classList.add(`${MODULE_ID}-undo-badge`);
  badge.textContent = String(count);
  button.append(badge);
}

function damageActionDataset(action) {
  const dataset = {
    partId: action.partId,
    rollIndex: String(action.rollIndex),
  };

  if (action.synthetic) {
    dataset.syntheticDamage = "true";
    dataset.amount = String(action.amount ?? "");
    dataset.formula = String(action.formula ?? action.amount ?? "0");
    dataset.damageType = action.damageType ?? "";
    dataset.typeLabel = action.typeLabel ?? "";
    dataset.isHeal = action.isHeal ? "true" : "false";
    dataset.ignoredImmunities = JSON.stringify(action.ignoredImmunities ?? []);
  }

  return dataset;
}

function parseSyntheticDamageDataset(element) {
  if (element.dataset.syntheticDamage !== "true") return null;
  return {
    amount: element.dataset.amount,
    formula: element.dataset.formula,
    damageType: element.dataset.damageType ?? "",
    typeLabel: element.dataset.typeLabel ?? "",
    isHeal: element.dataset.isHeal === "true",
    ignoredImmunities: JSON.parse(element.dataset.ignoredImmunities ?? "[]"),
  };
}

function compactDamageLabel(state, target, action, record = null) {
  if (record?.status === "applied") return appliedLabel(record);
  const operationId = makeOperationId("damage", target, action);
  const override = state.damageOverrides?.[operationId];
  const amount = override?.amount != null ? Number(override.amount) : action.amount;
  const typeLabel = override?.typeLabel ?? action.typeLabel;
  if (action.isHeal) return typeLabel ? `${amount} ${typeLabel}` : `${amount} Healing`;
  return typeLabel ? `${amount} ${typeLabel}` : `${amount} Damage`;
}

function getEffectiveDamageType(state, target, action) {
  const operationId = makeOperationId("damage", target, action);
  return state.damageOverrides?.[operationId]?.damageType ?? action.damageType ?? "";
}

function damageIconForType(type, isHeal = false) {
  if (isHeal) return "fa-solid fa-heart-pulse";
  return DAMAGE_TYPE_ICONS[type] ?? "fa-solid fa-burst";
}

function damageTypeClass(type, isHeal = false) {
  const key = isHeal ? "healing" : (type || "untyped");
  return `${MODULE_ID}-damage-type-${String(key).replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function applyControlTooltip(canApply, fallback = null) {
  return canApply ? fallback : localize("Notify.NoPermission");
}

/* ============================================================ */
/* Generic buttons                                              */
/* ============================================================ */

function createActionButton({ icon, iconImg, label, action, target, operationId, disabled = false, classes = [], extraDataset = {}, tooltip = null }) {
  const button = document.createElement("button");
  button.type = "button";
  button.classList.add(`${MODULE_ID}-action-button`, ...classes);
  button.dataset.dstdAction = action;
  if (operationId) button.dataset.operationId = operationId;
  if (target) button.dataset.target = JSON.stringify(target);
  if (tooltip) button.dataset.tooltip = tooltip;
  button.disabled = disabled;
  for (const [key, value] of Object.entries(extraDataset)) {
    if (value == null) continue;
    button.dataset[key] = value;
  }

  if (iconImg) {
    const img = document.createElement("img");
    img.src = iconImg;
    img.alt = "";
    img.classList.add(`${MODULE_ID}-button-icon-img`);
    button.append(img);
  } else if (icon) {
    const iconEl = document.createElement("i");
    iconEl.className = icon;
    button.append(iconEl);
  }
  if (label) {
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    button.append(labelEl);
  }
  return button;
}

function createIconButton({ icon, label = null, action, tooltip = null, disabled = false, classes = [], extraDataset = {}, iconOnly = false }) {
  const button = document.createElement("button");
  button.type = "button";
  button.classList.add(`${MODULE_ID}-icon-button`, ...classes);
  if (action) button.dataset.dstdAction = action;
  if (tooltip) button.dataset.tooltip = tooltip;
  button.disabled = disabled;
  for (const [key, value] of Object.entries(extraDataset)) {
    if (value == null) continue;
    button.dataset[key] = value;
  }
  const iconEl = document.createElement("i");
  iconEl.className = icon;
  button.append(iconEl);
  if (label && !iconOnly) {
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    button.append(labelEl);
  }
  return button;
}

function appliedLabel(record) {
  const suffix = record.halfDamage ? ` (${localize("Chat.Half")})` : "";
  return `${localize("Chat.Applied")} ${record.amount}${suffix}`;
}

/* ============================================================ */
/* Click handler                                                */
/* ============================================================ */

async function handlePanelClick(event, message) {
  const button = event.target.closest("[data-dstd-action]");
  if (!button) return;

  event.preventDefault();
  event.stopPropagation();

  const action = button.dataset.dstdAction;
  if (action === "toggleTarget") {
    if (event.target.closest(`button, .${MODULE_ID}-action-button, .${MODULE_ID}-icon-button`)) return;
    const row = button.closest(`.${MODULE_ID}-target-row`);
    const targetRows = row?.closest(`.${PANEL_CLASS}`)?.querySelectorAll(`.${MODULE_ID}-target-row[data-target-key]`) ?? [];
    if (targetRows.length <= 1) row?.classList.remove("is-collapsed");
    else row?.classList.toggle("is-collapsed");
    rememberCurrentCollapseState(message.id);
    return;
  }

  button.disabled = true;

  try {
    if (action === "updateTargets") {
      await updateTargets(message);
      return;
    }
    if (action === "editRoll") {
      rememberCurrentCollapseState(message.id);
      await openEditRollDialog(message, JSON.parse(button.dataset.target));
      return;
    }
    if (action === "editDamage") {
      rememberCurrentCollapseState(message.id);
      await openEditDamageDialog(message, button);
      return;
    }

    if (["applyDamage", "undoDamage", "applyStatus", "undoStatus"].includes(action)
      && !userCanApplyForMessage(game.user, message, getEffectiveMessageState(message))) {
      ui.notifications.warn(localize("Notify.NoPermission"));
      return;
    }

    const payload = buildPayloadFromButton(button, message, event);
    let result;

    switch (action) {
      case "applyDamage":
        result = await executeMutation("applyDamage", payload);
        notifyDamageResult(result, payload, message);
        return;
      case "undoDamage":
        result = await executeMutation("undoDamage", payload);
        notifyUndoDamage(result, payload);
        return;
      case "applyStatus":
        result = await executeMutation("applyStatus", payload);
        notifyStatusResult(result, payload, message);
        return;
      case "undoStatus":
        result = await executeMutation("undoStatus", payload);
        notifyUndoStatus(result, payload);
        return;
      case "rollReactive":
        result = await rollReactive(message, payload);
        notifyGenericResult(result);
        return;
    }
  } catch (error) {
    console.error(`${MODULE_ID} | panel click failed`, error);
    ui.notifications.error(localize("Notify.OperationFailed", { error: error.message ?? error }));
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function buildPayloadFromButton(button, message, event) {
  const action = button.dataset.dstdAction ?? "";
  let target = button.dataset.target ? JSON.parse(button.dataset.target) : null;
  const stateTarget = target;
  const messageState = getEffectiveMessageState(message);
  const rawOperationId = button.dataset.operationId;
  const operationId = button.dataset.operationId;
  const selectedTokenStack = !!target?.selectedToken;
  if (selectedTokenStack && !action.startsWith("undo")) {
    target = getSelectedTokenTarget();
    if (!target) throw new Error(localize("Notify.NoSelectedToken"));
  }
  const targetKey = getTargetKey(stateTarget);
  return {
    messageId: message.id,
    operationId,
    target,
    targetKey,
    selectedTokenStack,
    partId: button.dataset.partId,
    rollIndex: button.dataset.rollIndex,
    halfDamage: !!event.shiftKey,
    tier: button.dataset.tier,
    effectId: button.dataset.effectId,
    effectUuid: button.dataset.effectUuid,
    characteristic: button.dataset.characteristic,
    abilityUuid: button.dataset.abilityUuid,
    tierOverride: messageState.tierOverrides?.[targetKey] ?? null,
    damageOverride: messageState.damageOverrides?.[operationId] ?? messageState.damageOverrides?.[rawOperationId] ?? null,
    syntheticDamage: button.dataset.syntheticDamage === "true" ? {
      amount: button.dataset.amount,
      formula: button.dataset.formula,
      damageType: button.dataset.damageType ?? "",
      typeLabel: button.dataset.typeLabel ?? "",
      isHeal: button.dataset.isHeal === "true",
      ignoredImmunities: JSON.parse(button.dataset.ignoredImmunities ?? "[]"),
    } : null,
  };
}

function getSelectedTokenTarget() {
  const token = canvas.tokens?.controlled?.[0];
  return token ? normalizeTargetToken(token) : null;
}

async function rollReactive(message, payload) {
  const { actor } = await resolveTarget(payload.target);
  if (actor?.isOwner && !game.user.isGM) {
    const rollMessage = await actor.rollCharacteristic(payload.characteristic, { resultSource: payload.abilityUuid });
    await waitForDiceAnimation(rollMessage);
    const result = extractReactiveRollResult(rollMessage);
    if (!result) return { success: false, cancelled: true, error: localize("Notify.RollCancelled") };
    return executeMutation("saveReactiveResult", { ...payload, result });
  }
  return executeMutation("rollReactive", payload);
}

function waitForDiceAnimation(message, timeoutMs = 4500) {
  const diceSoNiceActive = game.modules.get("dice-so-nice")?.active;
  if (!diceSoNiceActive || !message?.id) return Promise.resolve();

  return new Promise(resolve => {
    let timeoutId = null;
    const finish = () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      Hooks.off("diceSoNiceRollComplete", onComplete);
      resolve();
    };
    const onComplete = messageId => {
      if (messageId === message.id) finish();
    };

    Hooks.on("diceSoNiceRollComplete", onComplete);
    timeoutId = window.setTimeout(finish, timeoutMs);
  });
}

async function updateTargets(message) {
  if (!canCurrentUserUpdateTargets(message)) {
    ui.notifications.warn(localize("Notify.NoPermission"));
    return;
  }

  const targets = collectCurrentTargets();
  const payload = { messageId: message.id, targets };
  rememberUpdatedTargetsCollapseState(message.id, targets);

  let result;
  if (message.isOwner) {
    await mutateMessageState(message.id, state => {
      state.targets = targets;
      state.targetingUserId = game.user.id;
      state.targetingUserName = game.user.name;
      state.updatedAt = Date.now();
      return state;
    });
    applyLocalMessageState(message, state => {
      state.targets = targets;
      state.targetingUserId = game.user.id;
      state.targetingUserName = game.user.name;
      state.updatedAt = Date.now();
      return state;
    });
    result = { success: true };
  } else {
    result = await executeMutation("updateTargets", payload);
    if (result?.success) applyLocalMessageState(message, state => {
      state.targets = targets;
      state.targetingUserId = game.user.id;
      state.targetingUserName = game.user.name;
      state.updatedAt = Date.now();
      return state;
    });
  }

  if (result?.success) ui.notifications.info(localize("Notify.TargetsUpdated"));
  else if (result && !result.cancelled) ui.notifications.error(localize("Notify.OperationFailed", { error: result.error ?? "Unknown" }));
}

function rememberUpdatedTargetsCollapseState(messageId, targets) {
  if (targets.length <= 1) {
    collapseStateByMessageId.delete(messageId);
    return;
  }

  const state = new Map();
  for (const target of targets) state.set(getTargetKey(target), true);
  collapseStateByMessageId.set(messageId, state);
}

function applyLocalMessageState(message, mutator) {
  const state = getEffectiveMessageState(message);
  const nextState = mutator(state) ?? state;
  localStateByMessageId.set(message.id, nextState);
  message.updateSource({ [`flags.${MODULE_ID}.${FLAG_STATE}`]: nextState });
  rerenderMessage(message);
  return nextState;
}

function getEffectiveMessageState(message) {
  return mergeMessageState(getMessageState(message), localStateByMessageId.get(message.id));
}

function mergeMessageState(base, local) {
  if (!local) return base;
  return {
    ...base,
    ...local,
    targets: local.targets ?? base.targets,
    applications: { ...(base.applications ?? {}), ...(local.applications ?? {}) },
    reactiveResults: { ...(base.reactiveResults ?? {}), ...(local.reactiveResults ?? {}) },
    tierOverrides: { ...(base.tierOverrides ?? {}), ...(local.tierOverrides ?? {}) },
    damageOverrides: { ...(base.damageOverrides ?? {}), ...(local.damageOverrides ?? {}) },
  };
}

function reconcileLocalState(message) {
  const local = localStateByMessageId.get(message.id);
  if (!local) return;
  const persisted = getMessageState(message);
  if (Number(persisted.updatedAt ?? 0) >= Number(local.updatedAt ?? 0)) localStateByMessageId.delete(message.id);
}

async function syncReactiveResultFromTestMessage(testMessage) {
  const authorId = getMessageAuthorId(testMessage);
  if (authorId && authorId !== game.user.id) return;

  const result = extractReactiveRollResult(testMessage);
  if (!result) return;

  for (const sourceMessage of game.messages ?? []) {
    if (sourceMessage.id === testMessage.id || !hasModuleState(sourceMessage)) continue;
    const state = getMessageState(sourceMessage);
    const entries = Object.entries(state.reactiveResults ?? {})
      .filter(([, record]) => record?.rollMessageId === testMessage.id);
    if (!entries.length) continue;

    for (const [operationId, record] of entries) {
      const payload = {
        messageId: sourceMessage.id,
        operationId,
        target: record.target,
        characteristic: record.characteristic,
        abilityUuid: record.abilityUuid,
        result,
      };

      if (sourceMessage.isOwner) {
        await mutateMessageState(sourceMessage.id, nextState => {
          nextState.reactiveResults[operationId] = {
            ...record,
            tier: Number(result.tier),
            total: Number(result.total),
            rollMessageId: result.messageId,
            rerolledAt: Date.now(),
          };
          nextState.updatedAt = Date.now();
          return nextState;
        });
      } else {
        const mutationResult = await executeMutation("saveReactiveResult", payload);
        if (mutationResult?.success) applyLocalMessageState(sourceMessage, nextState => {
          nextState.reactiveResults[operationId] = mutationResult.record;
          nextState.updatedAt = Date.now();
          return nextState;
        });
      }
    }
  }
}

function canCurrentUserUpdateTargets(message) {
  if (game.user.isGM || message.isOwner) return true;
  const authorId = getMessageAuthorId(message);
  const state = getEffectiveMessageState(message);
  return authorId === game.user.id || state.sourceUserId === game.user.id;
}

function hideAdjacentSystemDividers(message, root, panel) {
  for (const element of root.querySelectorAll(`.${HIDDEN_SYSTEM_DIVIDER_CLASS}`)) element.classList.remove(HIDDEN_SYSTEM_DIVIDER_CLASS);
  for (const element of root.querySelectorAll(`.${HIDDEN_SYSTEM_RESULT_CLASS}`)) element.classList.remove(HIDDEN_SYSTEM_RESULT_CLASS);
  for (const element of root.querySelectorAll(`.${HIDDEN_SYSTEM_WRAPPER_CLASS}`)) element.classList.remove(HIDDEN_SYSTEM_WRAPPER_CLASS);
  for (const element of root.querySelectorAll(`.${TRIM_SYSTEM_DIVIDER_CLASS}`)) element.classList.remove(TRIM_SYSTEM_DIVIDER_CLASS);

  const previousPart = findPreviousMessagePart(panel);
  if (previousPart) {
    previousPart.classList.add(TRIM_SYSTEM_DIVIDER_CLASS);
    hideAdjacentSystemResult(message, previousPart);
    hideTrailingDividers(previousPart);
  }

  for (const section of root.querySelectorAll(":scope > section[data-message-part]")) hideControlDividers(section);
}

function findPreviousMessagePart(panel) {
  let previous = panel.previousElementSibling;
  while (previous) {
    if (previous.matches?.("section[data-message-part]")) return previous;
    previous = previous.previousElementSibling;
  }
  return null;
}

function hideAdjacentSystemResult(message, section) {
  const partId = section?.dataset?.messagePart;
  const part = getParts(message).find(candidate => getPartId(candidate) === partId);
  if (!isRollResultPart(part)) return;
  if (!section.querySelector?.(".power-roll-display, .power-roll-result, .tier-result, .test-result")) return;
  section.classList.add(HIDDEN_SYSTEM_RESULT_CLASS);
}

function hideTrailingDividers(section) {
  const dividers = Array.from(section.querySelectorAll("hr"));
  dividers.at(-1)?.classList.add(HIDDEN_SYSTEM_DIVIDER_CLASS);
}

function hideControlDividers(section) {
  const controls = section.querySelectorAll(`.apply-damage, [data-action="applyEffect"], [data-action="gainResource"], [data-action="resultPartContext"]`);
  for (const control of controls) {
    for (const divider of findNearbyDividers(control, section)) divider.classList.add(HIDDEN_SYSTEM_DIVIDER_CLASS);
    markHiddenControlWrapper(control, section);
  }
}

function markHiddenControlWrapper(control, section) {
  let candidate = null;
  let element = control.parentElement;
  for (let depth = 0; element && element !== section && depth < 5; depth++) {
    if (!canHideControlWrapper(element)) break;
    candidate = element;
    element = element.parentElement;
  }
  candidate?.classList.add(HIDDEN_SYSTEM_WRAPPER_CLASS);
}

function canHideControlWrapper(element) {
  if (element.matches?.("section[data-message-part]")) return false;
  if (element.querySelector?.(".power-roll-display, .power-roll-result, .tier-result, .test-result, .dice-roll, .dice-tooltip")) return false;

  const clone = element.cloneNode(true);
  clone.querySelectorAll(`.apply-damage, [data-action="applyEffect"], [data-action="gainResource"], [data-action="resultPartContext"], hr, i, img, svg`).forEach(child => child.remove());
  return clone.textContent.trim() === "";
}

function findNearbyDividers(control, section) {
  const dividers = new Set();
  let element = control;
  for (let depth = 0; element && element !== section && depth < 5; depth++) {
    const next = nextElement(element);
    const previous = previousElement(element);
    if (isDividerElement(next)) dividers.add(next);
    if (isDividerElement(previous)) dividers.add(previous);
    element = element.parentElement;
  }
  return dividers;
}

function nextElement(element) {
  let next = element.nextElementSibling;
  while (next?.matches?.(`.${PANEL_CLASS}`)) next = next.nextElementSibling;
  return next;
}

function previousElement(element) {
  let previous = element.previousElementSibling;
  while (previous?.matches?.(`.${PANEL_CLASS}`)) previous = previous.previousElementSibling;
  return previous;
}

function isDividerElement(element) {
  return element?.tagName === "HR" || element?.classList?.contains("divider") || element?.classList?.contains("separator");
}

/* ============================================================ */
/* Notifications                                                */
/* ============================================================ */

function notifyDamageResult(result, payload, message) {
  if (!result || result.cancelled) return;
  if (!result.success) {
    ui.notifications.error(localize("Notify.OperationFailed", { error: result.error ?? "Unknown" }));
    return;
  }
  const r = result.record ?? {};
  const sourceName = getEffectiveMessageState(message)?.sourceActorName || "";
  const targetName = payload.target?.name ?? "Target";
  if (r.kind === "healing") {
    ui.notifications.info(localize("Notify.HealedTarget", { source: sourceName, target: targetName, amount: r.amount }));
  } else if (r.typeLabel) {
    ui.notifications.info(localize("Notify.DealtTypedDamage", { source: sourceName, target: targetName, amount: r.amount, type: r.typeLabel }));
  } else {
    ui.notifications.info(localize("Notify.DealtDamage", { source: sourceName, target: targetName, amount: r.amount }));
  }
}

function notifyStatusResult(result, payload, message) {
  if (!result || result.cancelled) return;
  if (!result.success) {
    ui.notifications.error(localize("Notify.OperationFailed", { error: result.error ?? "Unknown" }));
    return;
  }
  const r = result.record ?? {};
  const sourceName = getEffectiveMessageState(message)?.sourceActorName || "";
  ui.notifications.info(localize("Notify.InflictedStatus", {
    source: sourceName,
    target: payload.target?.name ?? "Target",
    status: r.statusName ?? payload.effectId,
  }));
}

function notifyUndoDamage(result, payload) {
  if (!result || result.cancelled) return;
  if (!result.success) {
    ui.notifications.error(localize("Notify.OperationFailed", { error: result.error ?? "Unknown" }));
    return;
  }
  const key = result.record?.kind === "healing" ? "Notify.UndoneHealing" : "Notify.UndoneDamage";
  ui.notifications.info(localize(key, { target: result.record?.target?.name ?? payload.target?.name ?? "Target" }));
}

function notifyUndoStatus(result, payload) {
  if (!result || result.cancelled) return;
  if (!result.success) {
    ui.notifications.error(localize("Notify.OperationFailed", { error: result.error ?? "Unknown" }));
    return;
  }
  ui.notifications.info(localize("Notify.UndoneStatus", {
    status: result.record?.statusName ?? payload.effectId,
    target: result.record?.target?.name ?? payload.target?.name ?? "Target",
  }));
}

function notifyGenericResult(result) {
  if (!result || result.cancelled) return;
  if (!result.success) {
    ui.notifications.error(localize("Notify.OperationFailed", { error: result.error ?? "Unknown" }));
  }
}

/* ============================================================ */
/* Action builders (per-part, not per-message)                  */
/* ============================================================ */

function buildDamageActionsForPart(part) {
  if (!part) return [];
  const DamageRoll = globalThis.ds?.rolls?.DamageRoll ?? CONFIG.Dice.rolls.find(roll => roll.name === "DamageRoll");
  const actions = [];
  const partId = getPartId(part);
  for (let rollIndex = 0; rollIndex < (part.rolls?.length ?? 0); rollIndex++) {
    const roll = part.rolls[rollIndex];
    const isDamageRoll = DamageRoll ? roll instanceof DamageRoll : roll?.constructor?.name === "DamageRoll";
    if (!isDamageRoll) continue;
    actions.push({
      partId,
      rollIndex,
      amount: Number(roll.total ?? 0),
      damageType: roll.type ?? roll.options?.type ?? "",
      typeLabel: roll.typeLabel ?? labelForDamageType(roll.type ?? roll.options?.type ?? ""),
      isHeal: !!roll.isHeal,
    });
  }
  return actions;
}

function buildStatusActionsForPart(part, tier, message = null) {
  const ability = safeFromUuidSync(getPartAbilityUuid(part)) ?? (message ? getAbilityItem(message) : null);
  if (!ability) return [];
  const partId = getPartId(part) ?? `tier${Number(tier)}-synthetic`;
  const useTier = Number(tier ?? part?.tier);
  const actions = [];

  for (const powerEffect of ability.system?.power?.effects ?? []) {
    if (powerEffect.type !== "applied") continue;
    const buttons = powerEffect.constructButtons?.(useTier) ?? [];
    for (const button of buttons) {
      const effectId = button.dataset.effectId;
      if (!effectId) continue;
      const { iconImg, iconClass } = resolveStatusIcon(powerEffect, effectId, button);
      actions.push({
        partId,
        tier: useTier,
        effectId,
        effectUuid: button.dataset.uuid,
        label: button.textContent.trim() || effectId,
        icon: iconClass,
        iconImg,
      });
    }
  }
  return actions;
}

function getPartAbilityUuid(part) {
  return part?.abilityUuid ?? part?.resultSource ?? null;
}

function buildDamageActionsForTier(message, tier) {
  const ability = getAbilityItem(message);
  if (!ability) return [];

  const actions = [];
  let index = 0;
  for (const powerEffect of ability.system?.power?.effects ?? []) {
    if (powerEffect.type !== "damage") continue;
    const tierData = powerEffect.damage?.[`tier${Number(tier)}`];
    if (!tierData || Number(tierData.value) === 0) continue;

    const damageType = tierData.types?.size === 1 ? tierData.types.first() : "";
    const formula = String(tierData.value ?? "0");
    const simplified = simplifyDamageFormula(formula, ability);
    actions.push({
      partId: `tier${Number(tier)}-synthetic`,
      rollIndex: powerEffect.id ?? powerEffect._id ?? `damage-${index}`,
      amount: simplified,
      formula,
      damageType,
      typeLabel: labelForDamageType(damageType),
      ignoredImmunities: Array.from(tierData.ignoredImmunities ?? []),
      isHeal: false,
      synthetic: true,
    });
    index++;
  }

  return actions;
}

function simplifyDamageFormula(formula, ability) {
  try {
    const simplified = globalThis.ds?.utils?.simplifyRollFormula?.(formula, ability.getRollData?.() ?? {});
    if (simplified != null && simplified !== "") return simplified;
  } catch (_) {
    // Use the raw formula when the system helper cannot simplify it synchronously.
  }
  return formula;
}

function resolveStatusIcon(powerEffect, effectId, fallbackButton) {
  // Prefer the configured ActiveEffect img (item-defined effect)
  const itemEffect = powerEffect?.item?.effects?.get?.(effectId);
  if (itemEffect?.img) return { iconImg: itemEffect.img, iconClass: null };
  // Fallback: status effect from CONFIG
  const status = CONFIG.statusEffects?.find(e => e.id === effectId);
  if (status?.img) return { iconImg: status.img, iconClass: null };
  if (status?.icon) return { iconImg: status.icon, iconClass: null };
  // Fallback: fontawesome icon from system's button
  const i = fallbackButton?.querySelector?.("i")?.className;
  return { iconImg: null, iconClass: i || "fa-solid fa-person-rays" };
}

function labelForDamageType(type) {
  if (!type) return "";
  const cfg = globalThis.ds?.CONFIG?.damageTypes?.[type];
  if (!cfg) return "";
  return cfg.label ? game.i18n.localize(cfg.label) : type;
}

function buildReactiveActions(message) {
  const ability = getAbilityItem(message);
  const characteristics = Array.from(ability?.system?.power?.roll?.characteristics ?? []);
  return characteristics.map(characteristic => ({
    characteristic,
    label: game.i18n.localize(globalThis.ds?.CONFIG?.characteristics?.[characteristic]?.label ?? characteristic),
    partId: "reactive",
  }));
}

function safeFromUuidSync(uuid) {
  try {
    return uuid ? fromUuidSync(uuid) : null;
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not resolve ${uuid}`, error);
    return null;
  }
}

/* ============================================================ */
/* Edit dialogs                                                 */
/* ============================================================ */

async function openEditRollDialog(message, target) {
  rememberCurrentCollapseState(message.id);
  const matched = target?.selectedToken ? findBaseResultPart(message) : findTargetPart(message, target);
  if (!matched?.powerRoll) {
    ui.notifications.warn(localize("Chat.NoRollForTarget"));
    return;
  }
  const state = getEffectiveMessageState(message);
  const targetKey = getTargetKey(target);
  const override = state.tierOverrides?.[targetKey];
  const currentEdges = override?.edges != null ? Number(override.edges) : Number(matched.powerRoll.options?.edges ?? 0);
  const currentBanes = override?.banes != null ? Number(override.banes) : Number(matched.powerRoll.options?.banes ?? 0);
  const currentBonuses = override?.bonuses != null ? Number(override.bonuses) : Number(matched.powerRoll.options?.bonuses ?? 0);
  const naturalSum = readNaturalRoll(matched.powerRoll);
  const criticalThreshold = Number(matched.powerRoll.options?.criticalThreshold ?? 19);
  const baseSummary = computePowerRollSummary(matched.powerRoll, override);
  const staticModifier = Number(baseSummary.staticModifier ?? 0);

  const opts = [0, 1, 2].map(n => `<option value="${n}">${n}</option>`).join("");
  const content = `
    <p style="margin:0 0 8px 0; opacity:0.8; font-size:0.85em;">
      ${foundry.utils.escapeHTML(localize("Dialog.EditRoll.Hint", { natural: naturalSum }))}
    </p>
    <div class="form-group">
      <label>${foundry.utils.escapeHTML(localize("Dialog.EditRoll.Edges"))}</label>
      <select name="edges">${opts}</select>
    </div>
    <div class="form-group">
      <label>${foundry.utils.escapeHTML(localize("Dialog.EditRoll.Banes"))}</label>
      <select name="banes">${opts}</select>
    </div>
    <div class="form-group">
      <label>${foundry.utils.escapeHTML(localize("Dialog.EditRoll.Bonuses"))}</label>
      <input type="number" name="bonuses" step="1" value="0"/>
    </div>
  `;

  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: localize("Dialog.EditRoll.Title", { name: target.name ?? "" }) },
    content,
    ok: {
      label: localize("Dialog.EditRoll.Confirm"),
      callback: (event, button, dialog) => {
        const form = dialog.element.querySelector("form");
        return {
          edges: Number(form.elements.edges.value),
          banes: Number(form.elements.banes.value),
          bonuses: Number(form.elements.bonuses.value || 0),
        };
      },
    },
    rejectClose: false,
    render: (event, dialog) => {
      const form = dialog.element.querySelector("form");
      if (form) {
        form.elements.edges.value = String(currentEdges);
        form.elements.banes.value = String(currentBanes);
        form.elements.bonuses.value = String(currentBonuses);
      }
    },
  });

  if (!result) return;

  const newTier = computeTierFromDice(naturalSum, result.edges, result.banes, result.bonuses, criticalThreshold, staticModifier);
  const net = result.edges - result.banes;
  const singleEdgeBaneAdjustment = Math.abs(net) === 1 ? Math.sign(net) * 2 : 0;
  const newTotal = naturalSum + staticModifier + singleEdgeBaneAdjustment + result.bonuses;
  const isCritical = naturalSum >= criticalThreshold;
  const overrideData = {
    tier: newTier,
    total: newTotal,
    naturalTotal: naturalSum,
    staticModifier,
    edges: result.edges,
    banes: result.banes,
    bonuses: result.bonuses,
    isCritical,
  };

  if (message.isOwner) {
    await mutateMessageState(message.id, s => {
      s.tierOverrides = s.tierOverrides ?? {};
      s.tierOverrides[targetKey] = overrideData;
      s.updatedAt = Date.now();
      return s;
    });
    applyLocalMessageState(message, s => {
      s.tierOverrides = s.tierOverrides ?? {};
      s.tierOverrides[targetKey] = overrideData;
      s.updatedAt = Date.now();
      return s;
    });
  } else {
    const mutationResult = await executeMutation("updateRollOverride", {
      messageId: message.id,
      targetKey,
      override: overrideData,
    });
    if (mutationResult?.success) applyLocalMessageState(message, s => {
      s.tierOverrides = s.tierOverrides ?? {};
      s.tierOverrides[targetKey] = overrideData;
      s.updatedAt = Date.now();
      return s;
    });
  }
  ui.notifications.info(localize("Notify.RollEdited", { target: target.name ?? "", tier: newTier }));
}

async function openEditDamageDialog(message, button) {
  rememberCurrentCollapseState(message.id);
  const target = JSON.parse(button.dataset.target);
  const operationId = button.dataset.operationId;
  const partId = button.dataset.partId;
  const rollIndex = Number(button.dataset.rollIndex);
  const state = getEffectiveMessageState(message);
  const part = partId === "message"
    ? { rolls: message.rolls }
    : getParts(message).find(p => getPartId(p) === partId);
  const roll = part?.rolls?.[rollIndex];
  const synthetic = parseSyntheticDamageDataset(button);
  if (!roll && !synthetic) {
    ui.notifications.warn(localize("Chat.NoActions"));
    return;
  }

  const override = state.damageOverrides?.[operationId];
  let baseAmount = Number(roll?.total ?? synthetic?.amount ?? 0);
  if (!Number.isFinite(baseAmount) && synthetic?.formula) {
    const formulaRoll = new Roll(synthetic.formula, getAbilityItem(message)?.getRollData?.() ?? {});
    await formulaRoll.evaluate();
    baseAmount = Number(formulaRoll.total ?? 0);
  }
  const currentType = override?.damageType ?? roll?.type ?? roll?.options?.type ?? synthetic?.damageType ?? "";

  const damageTypes = Object.entries(globalThis.ds?.CONFIG?.damageTypes ?? {}).map(([value, cfg]) => ({
    value,
    label: cfg.label ? game.i18n.localize(cfg.label) : value,
  }));
  const opts = [`<option value="">${foundry.utils.escapeHTML(localize("Dialog.EditDamage.None"))}</option>`]
    .concat(damageTypes.map(d => `<option value="${d.value}">${foundry.utils.escapeHTML(d.label)}</option>`))
    .join("");

  const content = `
    <div class="form-group">
      <label>${foundry.utils.escapeHTML(localize("Dialog.EditDamage.Additional"))}</label>
      <input type="text" name="additional" placeholder="1d3"/>
      <p class="hint" style="margin:0; opacity:0.8; font-size:0.8em;">
        ${foundry.utils.escapeHTML(localize("Dialog.EditDamage.AdditionalHint"))}
      </p>
    </div>
    <div class="form-group">
      <label>${foundry.utils.escapeHTML(localize("Dialog.EditDamage.DamageType"))}</label>
      <select name="damageType">${opts}</select>
    </div>
  `;

  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: localize("Dialog.EditDamage.Title", { name: target.name ?? "" }) },
    content,
    ok: {
      label: localize("Dialog.EditDamage.Confirm"),
      callback: (event, btn, dialog) => {
        const form = dialog.element.querySelector("form");
        return {
          additional: form.elements.additional.value.trim(),
          damageType: form.elements.damageType.value,
        };
      },
    },
    rejectClose: false,
    render: (event, dialog) => {
      const form = dialog.element.querySelector("form");
      if (form) {
        form.elements.additional.value = override?.additional ?? "";
        form.elements.damageType.value = currentType ?? "";
      }
    },
  });

  if (!result) return;

  let bonus = 0;
  if (result.additional) {
    try {
      const r = new Roll(result.additional);
      await r.evaluate();
      bonus = Number(r.total ?? 0);
    } catch (error) {
      ui.notifications.error(`Invalid formula: ${error.message ?? error}`);
      return;
    }
  }

  const damageType = result.damageType || "";
  const typeLabel = labelForDamageType(damageType);
  const newAmount = baseAmount + bonus;
  const overrideData = {
    amount: newAmount,
    baseAmount,
    bonus,
    additional: result.additional,
    damageType,
    typeLabel,
  };

  if (message.isOwner) {
    await mutateMessageState(message.id, s => {
      s.damageOverrides = s.damageOverrides ?? {};
      s.damageOverrides[operationId] = overrideData;
      s.updatedAt = Date.now();
      return s;
    });
    rerenderMessage(game.messages.get(message.id) ?? message);
  } else {
    const result = await executeMutation("updateDamageOverride", {
      messageId: message.id,
      operationId,
      override: overrideData,
    });
    if (result?.success) applyLocalMessageState(message, s => {
      s.damageOverrides = s.damageOverrides ?? {};
      s.damageOverrides[operationId] = overrideData;
      s.updatedAt = Date.now();
      return s;
    });
  }
  ui.notifications.info(localize("Notify.DamageEdited", { target: target.name ?? "" }));
}
