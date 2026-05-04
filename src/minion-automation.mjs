import { localize, MODULE_ID } from "./config.mjs";
import { isMinionDamageAutomationEnabled } from "./settings.mjs";

const AREA_DISTANCE_TYPES = new Set(["aura", "burst", "cube", "line", "wall"]);

let currentPickCleanup = null;
let originalCheckDefeatedMinions = null;

export function initializeMinionAutomation() {
  patchSystemMinionPrompt();

  Hooks.on("preUpdateCombatantGroup", (group, changes, options = {}) => {
    if (!game.user.isGM) return;
    if (!isMinionDamageAutomationEnabled()) return;
    if (!isSquadGroup(group)) return;

    const newStamina = foundry.utils.getProperty(changes, "system.staminaValue");
    if (newStamina === undefined) return;

    const minionMembers = getMinionMembers(group);
    if (!minionMembers.length) return;

    const poolMax = Number(group.system?.staminaMax ?? 0);
    if (Number.isFinite(poolMax)) {
      const clamped = Math.clamp(Number(newStamina), 0, poolMax);
      if (clamped !== Number(newStamina)) foundry.utils.setProperty(changes, "system.staminaValue", clamped);
    }

    applyAreaDamageCap(group, changes, options.dstd ?? {});
  });

  Hooks.on("updateCombatantGroup", (group, changes, options = {}) => {
    if (!game.user.isGM) return;
    if (!isMinionDamageAutomationEnabled()) return;
    if (options.dstd?.skipMinionAutomationHook) return;
    if (foundry.utils.getProperty(changes, "system.staminaValue") === undefined) return;

    checkMinionDeaths(group, buildMinionDamageContext(group, options.dstd ?? {})).catch(error => {
      console.warn(`${MODULE_ID} | Minion death automation failed`, error);
    });
  });
}

export function isAreaAbility(ability) {
  const distanceType = String(ability?.system?.distance?.type ?? "").toLowerCase();
  return AREA_DISTANCE_TYPES.has(distanceType);
}

export async function applySquadMinionDamage(actor, squadGroup, data, tokenDocument) {
  const damage = calculateDamageAfterModifiers(actor, data.amount, data.damageType, data.ignoredImmunities);
  if (damage === 0) {
    ui.notifications.info("DRAW_STEEL.Actor.DamageNotification.ImmunityReducedToZero", { format: { name: actor.name } });
    return;
  }

  const appliedDamage = capAreaDamageToTarget(squadGroup, tokenDocument, damage, data.isAreaAbility);
  if (appliedDamage <= 0) return;

  await updateSquadStamina(squadGroup, -appliedDamage, {
    targetTokenDocument: tokenDocument,
    operationTargets: data.operationTargets,
    damageType: data.damageType,
    isAreaAbility: data.isAreaAbility,
  });
}

export async function applySquadMinionHealing(squadGroup, amount, { targetTokenDocument = null, operationTargets = [], isAreaAbility = false } = {}) {
  await updateSquadStamina(squadGroup, Number(amount ?? 0), { targetTokenDocument, operationTargets, isAreaAbility });
}

export function getSquadCombatGroup(actor, tokenDocument = null) {
  if (!isMinionActor(actor)) return null;

  const combatant = getTargetCombatant(actor, tokenDocument);
  if (combatant?.group?.type === "squad" && isMinionActor(combatant.actor)) return combatant.group;

  const combatGroups = actor.system?.combatGroups;
  if (combatGroups?.size === 1 && actor.system?.combatGroup?.type === "squad") return actor.system.combatGroup;
  return null;
}

export function getStaminaSnapshot(actor, tokenDocument = null) {
  const squadGroup = getSquadCombatGroup(actor, tokenDocument);
  if (squadGroup) {
    return {
      groupedMinion: true,
      groupUuid: squadGroup.uuid,
      groupId: squadGroup.id,
      groupName: squadGroup.name,
      value: Number(squadGroup.system?.staminaValue ?? 0),
      temporary: Number(actor.system?.stamina?.temporary ?? 0),
      max: Number(squadGroup.system?.staminaMax ?? 0),
      actorValue: Number(actor.system?.stamina?.value ?? 0),
      actorMax: Number(actor.system?.stamina?.max ?? 0),
      minions: getSquadMinionStates(squadGroup),
    };
  }

  return {
    value: Number(actor.system?.stamina?.value ?? 0),
    temporary: Number(actor.system?.stamina?.temporary ?? 0),
    max: Number(actor.system?.stamina?.max ?? 0),
  };
}

export async function restoreSquadMinionStates(squadGroup, minionStates = []) {
  for (const state of minionStates ?? []) {
    const combatant = findGroupCombatant(squadGroup, state);
    if (!combatant || !isMinionActor(combatant.actor)) continue;
    await setCombatantDefeated(combatant, !!state.defeated, !!state.hasDefeatedStatus);
  }
}

/**
 * Restores only minions whose defeated/dead state actually changed during a specific operation.
 * Used by delta-based undo so parallel AoE applications don't interfere with each other.
 */
export async function restoreChangedMinionStates(squadGroup, beforeMinions = [], afterMinions = []) {
  const afterById = new Map((afterMinions ?? []).map(state => [state.combatantId, state]));
  for (const beforeState of beforeMinions ?? []) {
    const afterState = afterById.get(beforeState.combatantId);
    if (!afterState) continue;
    if (beforeState.defeated === afterState.defeated && beforeState.hasDefeatedStatus === afterState.hasDefeatedStatus) continue;
    const combatant = findGroupCombatant(squadGroup, beforeState);
    if (!combatant || !isMinionActor(combatant.actor)) continue;
    await setCombatantDefeated(combatant, !!beforeState.defeated, !!beforeState.hasDefeatedStatus);
  }
}

async function updateSquadStamina(squadGroup, delta, { targetTokenDocument = null, operationTargets = [], damageType = "", isAreaAbility = false } = {}) {
  const options = buildSquadUpdateOptions(squadGroup, targetTokenDocument, operationTargets, { damageType, isAreaAbility });
  const update = { "system.staminaValue": Number(squadGroup.system?.staminaValue ?? 0) + Number(delta) };

  await squadGroup.update(update, options);

  if (isMinionDamageAutomationEnabled()) {
    await checkMinionDeaths(squadGroup, buildMinionDamageContext(squadGroup, options.dstd));
  }
}

function buildSquadUpdateOptions(squadGroup, targetTokenDocument, operationTargets, { damageType = "", isAreaAbility = false } = {}) {
  const targetIds = getOperationTargetTokenIds(operationTargets);
  const primaryTargetId = targetTokenDocument?.id ?? null;
  const priorityTargetIds = uniqueValues([primaryTargetId, ...targetIds]);
  const groupTargetIds = getGroupTargetTokenIds(squadGroup, priorityTargetIds);
  const dstd = {
    source: MODULE_ID,
    skipMinionAutomationHook: true,
    isAreaAbility: !!isAreaAbility,
    primaryTargetId,
    minionDeathTargetIds: priorityTargetIds,
    areaTargetIds: isAreaAbility ? groupTargetIds : [],
  };

  const dsOptions = damageType ? { damageType } : {};
  return { ds: dsOptions, dstd };
}

function applyAreaDamageCap(group, changes, context) {
  if (!context.isAreaAbility) return;

  const newStamina = foundry.utils.getProperty(changes, "system.staminaValue");
  if (newStamina === undefined) return;

  const minionMembers = getMinionMembers(group);
  const individualMax = getIndividualMinionMax(minionMembers);
  if (!individualMax) return;

  const targetIds = new Set(context.areaTargetIds ?? []);
  if (!targetIds.size) return;

  const targetedInGroup = minionMembers.filter(member => targetIds.has(member.tokenId));
  if (!targetedInGroup.length) return;

  const poolMax = Number(group.system?.staminaMax ?? 0);
  const preExistingDead = minionMembers.filter(member => member.isDefeated && !targetIds.has(member.tokenId)).length;
  const minAllowedStamina = poolMax - ((preExistingDead + targetedInGroup.length) * individualMax);

  if (Number(newStamina) < minAllowedStamina) {
    foundry.utils.setProperty(changes, "system.staminaValue", minAllowedStamina);
  }
}

function capAreaDamageToTarget(squadGroup, tokenDocument, damage, isAreaAbility) {
  const numericDamage = Number(damage ?? 0);
  if (!isAreaAbility || numericDamage <= 0) return numericDamage;

  const minionMembers = getMinionMembers(squadGroup);
  const individualMax = getIndividualMinionMax(minionMembers);
  if (!individualMax) return numericDamage;

  const targetTokenId = tokenDocument?.id ?? null;
  const targetMember = targetTokenId ? minionMembers.find(member => member.tokenId === targetTokenId) : null;
  if (targetMember?.isDefeated) return 0;

  return Math.min(numericDamage, individualMax);
}

async function checkMinionDeaths(group, context = {}) {
  if (!isMinionDamageAutomationEnabled()) return;
  if (!isSquadGroup(group)) return;

  const minionMembers = getMinionMembers(group);
  if (!minionMembers.length) return;

  const individualMax = getIndividualMinionMax(minionMembers);
  if (!individualMax) return;

  const poolMax = Number(group.system?.staminaMax ?? 0);
  const currentPool = Number(group.system?.staminaValue ?? 0);
  const damageTaken = Math.max(0, poolMax - currentPool);
  const currentlyDead = minionMembers.filter(member => member.isDefeated).length;
  let expectedDead = Math.min(minionMembers.length, Math.floor(damageTaken / individualMax));

  if (context.isAreaAbility) {
    const areaTargetIds = new Set(context.areaTargetIds ?? []);
    const targetedInGroup = minionMembers.filter(member => areaTargetIds.has(member.tokenId));
    if (targetedInGroup.length) {
      const aliveTargeted = targetedInGroup.filter(member => !member.isDefeated).length;
      expectedDead = Math.min(expectedDead, currentlyDead + aliveTargeted);
    }
  }

  const additionalDeaths = expectedDead - currentlyDead;
  if (additionalDeaths <= 0) return;

  await chooseMinionDeaths(group, minionMembers, additionalDeaths, context);
}

async function chooseMinionDeaths(group, minionMembers, additionalDeaths, context = {}) {
  const aliveMinions = minionMembers.filter(member => !member.isDefeated);
  if (!aliveMinions.length) return;

  const priorityTokenIds = uniqueValues([
    context.primaryTargetId,
    ...(context.minionDeathTargetIds ?? []),
    ...(context.isAreaAbility ? context.areaTargetIds ?? [] : []),
  ]);
  const killed = new Set();

  for (const tokenId of priorityTokenIds) {
    if (killed.size >= additionalDeaths) break;
    const combatant = aliveMinions.find(member => member.tokenId === tokenId && !killed.has(member.id));
    if (!combatant) continue;
    await setCombatantDefeated(combatant, true, true);
    killed.add(combatant.id);
  }

  if (!killed.size && !context.isAreaAbility) {
    const firstAlive = aliveMinions[0];
    if (firstAlive) {
      await setCombatantDefeated(firstAlive, true, true);
      killed.add(firstAlive.id);
    }
  }

  if (aliveMinions.length <= additionalDeaths) {
    for (const combatant of aliveMinions) {
      if (killed.has(combatant.id)) continue;
      await setCombatantDefeated(combatant, true, true);
      killed.add(combatant.id);
    }
    return;
  }

  const remaining = additionalDeaths - killed.size;
  if (remaining > 0) await startMinionPickMode(group.parent, group, remaining);
}

function startMinionPickMode(combat, group, count) {
  if (currentPickCleanup) currentPickCleanup();
  if (!combat || count <= 0) return Promise.resolve();

  const validTokenIds = new Set();
  for (const member of group.members ?? []) {
    if (member.isDefeated || !isMinionActor(member.actor)) continue;
    if (member.tokenId) validTokenIds.add(member.tokenId);
  }

  if (!validTokenIds.size) return Promise.resolve();

  return new Promise(resolve => {
    let remaining = Math.min(count, validTokenIds.size);
    let resolved = false;
    ui.notifications.info(localize("Notify.MinionPickPrompt", { count: remaining, name: group.name }));

    const hookId = Hooks.on("controlToken", async (token, controlled) => {
      if (!controlled) return;
      if (!validTokenIds.has(token.document.id)) return;

      const combatant = combat.combatants.find(member => member.tokenId === token.document.id);
      if (!combatant || combatant.isDefeated) return;

      try {
        await setCombatantDefeated(combatant, true, true);
      } catch (error) {
        console.warn(`${MODULE_ID} | Could not defeat picked minion`, error);
        cleanup();
        return;
      }

      validTokenIds.delete(token.document.id);
      remaining -= 1;
      token.release();

      if (remaining > 0 && validTokenIds.size > 0) {
        ui.notifications.info(localize("Notify.MinionPickPrompt", { count: remaining, name: group.name }));
      } else {
        cleanup();
      }
    });

    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      cleanup();
      ui.notifications.info(localize("Notify.MinionPickCancelled"));
    };

    document.addEventListener("keydown", onKeyDown);

    function cleanup() {
      Hooks.off("controlToken", hookId);
      document.removeEventListener("keydown", onKeyDown);
      if (currentPickCleanup === cleanup) currentPickCleanup = null;
      if (resolved) return;
      resolved = true;
      resolve();
    }

    currentPickCleanup = cleanup;
  });
}

async function setCombatantDefeated(combatant, defeated, defeatedStatusActive = defeated) {
  const defeatedId = CONFIG.specialStatusEffects.DEFEATED;
  if (combatant.defeated !== defeated) await combatant.update({ defeated });

  const hasDefeatedStatus = !!combatant.actor?.statuses?.has(defeatedId);
  if (hasDefeatedStatus !== defeatedStatusActive) {
    await combatant.actor?.toggleStatusEffect(defeatedId, { overlay: true, active: defeatedStatusActive });
  }
}

function buildMinionDamageContext(group, context = {}) {
  const targetIds = new Set(context.minionDeathTargetIds ?? []);
  const areaTargetIds = context.isAreaAbility
    ? getGroupTargetTokenIds(group, context.areaTargetIds?.length ? context.areaTargetIds : context.minionDeathTargetIds)
    : [];

  return {
    isAreaAbility: !!context.isAreaAbility,
    primaryTargetId: context.primaryTargetId ?? null,
    minionDeathTargetIds: Array.from(targetIds),
    areaTargetIds,
  };
}

function getSquadMinionStates(squadGroup) {
  const defeatedId = CONFIG.specialStatusEffects.DEFEATED;
  return getMinionMembers(squadGroup).map(combatant => ({
    combatantId: combatant.id,
    tokenId: combatant.tokenId ?? null,
    actorUuid: combatant.actor?.uuid ?? null,
    defeated: !!combatant.defeated,
    hasDefeatedStatus: !!combatant.actor?.statuses?.has(defeatedId),
  }));
}

function findGroupCombatant(squadGroup, state) {
  const combat = squadGroup.parent ?? game.combat;
  return combat?.combatants?.get(state.combatantId)
    ?? Array.from(squadGroup.members ?? []).find(member => member.id === state.combatantId || member.tokenId === state.tokenId)
    ?? null;
}

function getTargetCombatant(actor, tokenDocument = null) {
  const combat = game.combat;
  if (!combat) return null;

  const tokenCombatant = tokenDocument?.combatant;
  if (tokenCombatant?.parent === combat || tokenCombatant?.combat === combat) return tokenCombatant;

  const tokenId = tokenDocument?.id ?? null;
  const sceneId = tokenDocument?.parent?.id ?? null;
  if (tokenId) {
    const tokenMatch = combat.combatants.find(combatant => {
      const combatantSceneId = combatant.sceneId ?? combatant.scene?.id ?? combatant.token?.parent?.id;
      return combatant.tokenId === tokenId && (!sceneId || !combatantSceneId || combatantSceneId === sceneId);
    });
    if (tokenMatch) return tokenMatch;
  }

  return Array.from(combat.getCombatantsByActor?.(actor) ?? []).find(combatant => combatant.actor === actor) ?? null;
}

function getMinionMembers(group) {
  return Array.from(group?.members ?? []).filter(member => isMinionActor(member.actor));
}

function getIndividualMinionMax(minionMembers) {
  return Number(minionMembers[0]?.actor?.system?.stamina?.max ?? 0) || 0;
}

function getOperationTargetTokenIds(targets = []) {
  return uniqueValues(targets.map(target => target?.tokenId));
}

function getGroupTargetTokenIds(squadGroup, targetTokenIds = []) {
  const targetIds = new Set(targetTokenIds ?? []);
  return uniqueValues(getMinionMembers(squadGroup)
    .filter(member => targetIds.has(member.tokenId))
    .map(member => member.tokenId));
}

function calculateDamageAfterModifiers(actor, amount, damageType = "", ignoredImmunities = []) {
  const damage = actor.system?.damage ?? {};
  const weaknesses = damage.weaknesses ?? {};
  const immunities = damage.immunities ?? {};
  const ignored = new Set(ignoredImmunities ?? []);
  const allWeakness = Number(weaknesses.all ?? 0) || 0;
  const specificWeakness = Number(weaknesses[damageType] ?? 0) || 0;
  const allImmunity = ignored.has("all") ? 0 : (Number(immunities.all ?? 0) || 0);
  const specificImmunity = ignored.has("all") || ignored.has(damageType) ? 0 : (Number(immunities[damageType] ?? 0) || 0);

  return Math.max(0, Number(amount ?? 0) + Math.max(allWeakness, specificWeakness) - Math.max(allImmunity, specificImmunity));
}

function patchSystemMinionPrompt() {
  const SquadModel = globalThis.ds?.data?.CombatantGroup?.SquadModel;
  if (!SquadModel || originalCheckDefeatedMinions) return;

  originalCheckDefeatedMinions = SquadModel.prototype.checkDefeatedMinions;
  SquadModel.prototype.checkDefeatedMinions = function (...args) {
    if (isMinionDamageAutomationEnabled()) return;
    return originalCheckDefeatedMinions.call(this, ...args);
  };
}

function isSquadGroup(group) {
  return group?.type === "squad";
}

function isMinionActor(actor) {
  return !!(actor?.isMinion ?? actor?.system?.isMinion);
}

function uniqueValues(values = []) {
  return Array.from(new Set(values.filter(value => value != null && value !== "")));
}
