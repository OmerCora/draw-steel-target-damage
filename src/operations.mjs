import { localize, TARGETED_STATUS_IDS } from "./config.mjs";
import {
  applySquadMinionDamage,
  applySquadMinionHealing,
  getSquadCombatGroup,
  getStaminaSnapshot,
  isAreaAbility,
  restoreChangedMinionStates,
} from "./minion-automation.mjs";
import { userCanApplyForMessage } from "./permissions.mjs";
import { getMessageAuthorId, getPart, resolveTarget } from "./target-utils.mjs";
import { getMessageState, mutateMessageState } from "./state.mjs";

export async function applyDamageOperation(payload, context) {
  const { message, roll } = getRollContext(payload, { allowSynthetic: !!payload.syntheticDamage });
  const state = getMessageState(message);
  assertCanApplyForMessage(context.user, message, state);

  const override = payload.damageOverride ?? null;
  const synthetic = payload.syntheticDamage ?? null;
  const syntheticAmount = synthetic ? await evaluateSyntheticDamageAmount(synthetic, message) : null;
  const baseAmount = override?.amount != null ? Number(override.amount) : Number(roll?.total ?? syntheticAmount ?? 0);
  const damageType = override?.damageType ?? roll?.type ?? synthetic?.damageType ?? "";
  const typeLabel = override?.typeLabel ?? roll?.typeLabel ?? synthetic?.typeLabel ?? "";
  const isHeal = roll?.isHeal ?? synthetic?.isHeal ?? false;
  const areaAbility = await resolveIsAreaAbility(state.abilityUuid ?? payload.abilityUuid);

  const amount = payload.halfDamage ? Math.floor(baseAmount / 2) : baseAmount;
  const applicationTargets = getApplicationTargets(payload);
  const operationTargets = areaAbility ? getContextTargets(payload, applicationTargets) : applicationTargets;
  const records = [];

  for (const target of applicationTargets) {
    records.push(await applyDamageToTarget(target, {
      kind: isHeal ? "healing" : "damage",
      isHeal,
      healType: roll?.type ?? synthetic?.damageType,
      amount,
      originalAmount: Number(roll?.total ?? syntheticAmount ?? 0),
      halfDamage: !!payload.halfDamage,
      damageType,
      typeLabel,
      override,
      ignoredImmunities: roll?.ignoredImmunities ?? synthetic?.ignoredImmunities ?? [],
      operationTargets,
      isAreaAbility: areaAbility,
      partId: payload.partId,
      rollIndex: Number.isFinite(Number(payload.rollIndex)) ? Number(payload.rollIndex) : payload.rollIndex,
    }, context.user));
  }

  const record = makeStackRecord(payload, records);

  if (payload.selectedTokenStack) await pushApplicationRecord(message.id, payload.operationId, record, payload, context.user);
  else await writeApplicationRecord(message.id, payload.operationId, record, payload, context.user);
  return { success: true, record };
}

export async function undoDamageOperation(payload, context) {
  const message = getMessageOrThrow(payload.messageId);
  const state = getMessageState(message);
  assertCanApplyForMessage(context.user, message, state);
  const entry = state.applications?.[payload.operationId];
  const prior = getLatestAppliedRecord(entry);
  if (!prior) throw new Error("No applied damage record was found");

  const record = Array.isArray(prior.records)
    ? await undoDamageBatch(prior, context.user)
    : await undoDamageRecord(prior, context.user);

  if (payload.selectedTokenStack || isStackedApplication(entry)) await popApplicationRecord(message.id, payload.operationId, record, payload, context.user);
  else await writeApplicationRecord(message.id, payload.operationId, record, payload, context.user);
  return { success: true, record };
}

async function applyDamageToTarget(target, data, user) {
  const { actor, tokenDocument } = await resolveTargetOrThrow(target);
  const before = getStaminaSnapshot(actor, tokenDocument);
  const squadGroup = getSquadCombatGroup(actor, tokenDocument);

  if (data.isHeal) {
    const isTemporary = data.healType !== "value";
    if (!isTemporary && squadGroup) await applySquadMinionHealing(squadGroup, data.amount, {
      targetTokenDocument: tokenDocument,
      operationTargets: data.operationTargets,
      isAreaAbility: data.isAreaAbility,
    });
    else await actor.modifyTokenAttribute(isTemporary ? "stamina.temporary" : "stamina", data.amount, !isTemporary, !isTemporary);
  } else if (squadGroup) {
    await applySquadMinionDamage(actor, squadGroup, data, tokenDocument);
  } else {
    await actor.system.takeDamage(data.amount, {
      type: data.damageType,
      ignoredImmunities: data.ignoredImmunities,
    });
  }

  return {
    kind: data.kind,
    status: "applied",
    target,
    partId: data.partId,
    rollIndex: data.rollIndex,
    amount: data.amount,
    originalAmount: data.originalAmount,
    halfDamage: data.halfDamage,
    damageType: data.damageType,
    typeLabel: data.typeLabel,
    override: data.override ?? null,
    before,
    after: getStaminaSnapshot(actor, tokenDocument),
    appliedByUserId: user?.id ?? game.user.id,
    appliedByUserName: user?.name ?? game.user.name,
    appliedAt: Date.now(),
  };
}

async function undoDamageRecord(prior, user) {
  if (!prior?.before) throw new Error("No applied damage record was found");

  const { actor, tokenDocument } = await resolveTargetOrThrow(prior.target);
  const squadGroup = await resolveSnapshotSquadGroup(prior.before, actor, tokenDocument);

  if (squadGroup) {
    // Delta-based undo: only add back the damage this specific operation applied,
    // so parallel AoE applications to the same squad pool don't interfere.
    const currentPool = Number(squadGroup.system?.staminaValue ?? 0);
    const poolMax = Number(squadGroup.system?.staminaMax ?? prior.before.max ?? Infinity);
    const appliedDelta = (prior.after?.value ?? prior.before.value) - prior.before.value; // negative = damage
    const newPool = Math.min(Math.max(0, currentPool - appliedDelta), poolMax);
    await squadGroup.update({ "system.staminaValue": newPool }, { dstd: { skipMinionAutomationHook: true } });
    // Only un-defeat minions whose state changed in this specific operation.
    await restoreChangedMinionStates(squadGroup, prior.before.minions ?? [], prior.after?.minions ?? []);
  } else {
    await actor.update({
      "system.stamina.value": prior.before.value,
      "system.stamina.temporary": prior.before.temporary,
    });
  }

  return {
    ...prior,
    status: "undone",
    undoneByUserId: user?.id ?? game.user.id,
    undoneByUserName: user?.name ?? game.user.name,
    undoneAt: Date.now(),
    afterUndo: getStaminaSnapshot(actor, tokenDocument),
  };
}

async function undoDamageBatch(prior, user) {
  const records = [];
  for (const record of Array.from(prior.records).reverse()) records.unshift(await undoDamageRecord(record, user));
  return {
    ...prior,
    status: "undone",
    records,
    undoneByUserId: user?.id ?? game.user.id,
    undoneByUserName: user?.name ?? game.user.name,
    undoneAt: Date.now(),
  };
}

export async function applyStatusOperation(payload, context) {
  const message = getMessageOrThrow(payload.messageId);
  const state = getMessageState(message);
  assertCanApplyForMessage(context.user, message, state);
  const powerEffect = payload.effectUuid ? await fromUuid(payload.effectUuid) : null;
  const statusName = getStatusName(powerEffect, payload.effectId);
  const applicationTargets = getApplicationTargets(payload);
  const records = [];

  for (const target of applicationTargets) {
    records.push(await applyStatusToTarget(target, {
      payload,
      powerEffect,
      statusName,
      sourceActorUuid: state.sourceActorUuid,
    }, context.user));
  }

  const record = makeStackRecord(payload, records);

  if (payload.selectedTokenStack) await pushApplicationRecord(message.id, payload.operationId, record, payload, context.user);
  else await writeApplicationRecord(message.id, payload.operationId, record, payload, context.user);
  return { success: true, record };
}

export async function undoStatusOperation(payload, context) {
  const message = getMessageOrThrow(payload.messageId);
  const state = getMessageState(message);
  assertCanApplyForMessage(context.user, message, state);
  const entry = state.applications?.[payload.operationId];
  const prior = getLatestAppliedRecord(entry);
  if (!prior) throw new Error("No applied status record was found");

  const record = Array.isArray(prior.records)
    ? await undoStatusBatch(prior, context.user)
    : await undoStatusRecord(prior, context.user);

  if (payload.selectedTokenStack || isStackedApplication(entry)) await popApplicationRecord(message.id, payload.operationId, record, payload, context.user);
  else await writeApplicationRecord(message.id, payload.operationId, record, payload, context.user);
  return { success: true, record };
}

async function applyStatusToTarget(target, data, user) {
  const { actor } = await resolveTargetOrThrow(target);
  const { payload, powerEffect, statusName } = data;
  const beforeEffects = findMatchingEffects(actor, payload.effectId, statusName).map(effect => effect.toObject());

  if (powerEffect?.applyEffect) {
    await powerEffect.applyEffect(`tier${Number(payload.tier)}`, payload.effectId, { targets: [actor] });
  } else if (CONFIG.statusEffects.find(effect => effect.id === payload.effectId)) {
    await actor.toggleStatusEffect(payload.effectId, { active: true, overlay: false });
  } else if (powerEffect?.documentName === "ActiveEffect") {
    const effectData = powerEffect.toObject();
    delete effectData._id;
    await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
  } else {
    throw new Error(`Cannot resolve status effect ${payload.effectId}`);
  }

  const afterEffects = findMatchingEffects(actor, payload.effectId, statusName);
  if (TARGETED_STATUS_IDS.has(payload.effectId)) {
    await addTargetedStatusSource(afterEffects, payload.effectId, data.sourceActorUuid ?? powerEffect?.item?.actor?.uuid);
  }

  return {
    kind: "status",
    status: "applied",
    target,
    partId: payload.partId,
    tier: Number(payload.tier),
    effectId: payload.effectId,
    effectUuid: payload.effectUuid,
    statusName,
    targeted: TARGETED_STATUS_IDS.has(payload.effectId),
    beforeEffects,
    afterEffectIds: afterEffects.map(effect => effect.id),
    appliedByUserId: user?.id ?? game.user.id,
    appliedByUserName: user?.name ?? game.user.name,
    appliedAt: Date.now(),
  };
}

async function undoStatusRecord(prior, user) {
  const { actor } = await resolveTargetOrThrow(prior.target);
  const idsToDelete = (prior.afterEffectIds ?? []).filter(id => actor.effects.get(id));
  if (idsToDelete.length) await actor.deleteEmbeddedDocuments("ActiveEffect", idsToDelete);

  const restoreEffects = (prior.beforeEffects ?? []).filter(effectData => {
    const id = effectData._id ?? effectData.id;
    return id && !actor.effects.get(id);
  });
  if (restoreEffects.length) await actor.createEmbeddedDocuments("ActiveEffect", restoreEffects, { keepId: true });

  return {
    ...prior,
    status: "undone",
    undoneByUserId: user?.id ?? game.user.id,
    undoneByUserName: user?.name ?? game.user.name,
    undoneAt: Date.now(),
  };
}

async function undoStatusBatch(prior, user) {
  const records = [];
  for (const record of prior.records) records.push(await undoStatusRecord(record, user));
  return {
    ...prior,
    status: "undone",
    records,
    undoneByUserId: user?.id ?? game.user.id,
    undoneByUserName: user?.name ?? game.user.name,
    undoneAt: Date.now(),
  };
}

export async function rollReactiveOperation(payload, context) {
  const { actor } = await resolveTargetOrThrow(payload.target);
  if (!canUserRollActor(context.user, actor)) throw new Error(localize("Notify.NoPermission"));

  const rollMessage = await actor.rollCharacteristic(payload.characteristic, { resultSource: payload.abilityUuid });
  await waitForDiceAnimation(rollMessage);
  const result = extractReactiveRollResult(rollMessage);
  if (!result) return { success: false, cancelled: true, error: localize("Notify.RollCancelled") };

  return saveReactiveResultOperation({ ...payload, result }, context);
}

export async function saveReactiveResultOperation(payload, context) {
  const message = getMessageOrThrow(payload.messageId);
  const { actor } = await resolveTargetOrThrow(payload.target);
  const authorId = getMessageAuthorId(message);

  if (!context.user?.isGM && authorId !== context.user?.id && !canUserRollActor(context.user, actor)) {
    throw new Error(localize("Notify.NoPermission"));
  }

  const record = {
    target: payload.target,
    characteristic: payload.characteristic,
    abilityUuid: payload.abilityUuid,
    tier: Number(payload.result.tier),
    total: Number(payload.result.total),
    rollMessageId: payload.result.messageId,
    rolledByUserId: context.user?.id ?? game.user.id,
    rolledByUserName: context.user?.name ?? game.user.name,
    rolledAt: Date.now(),
  };

  await mutateMessageState(message.id, state => {
    state.reactiveResults[payload.operationId] = record;
    state.updatedAt = Date.now();
    return state;
  });

  return { success: true, record };
}

export async function updateTargetsOperation(payload, context) {
  const message = getMessageOrThrow(payload.messageId);
  const state = getMessageState(message);
  if (!canUserMutateMessage(context.user, message, state)) throw new Error(localize("Notify.NoPermission"));

  await mutateMessageState(message.id, state => {
    state.targets = payload.targets ?? [];
    state.targetingUserId = context.user?.id ?? game.user.id;
    state.targetingUserName = context.user?.name ?? game.user.name;
    state.updatedAt = Date.now();
    return state;
  });

  return { success: true };
}

export async function updateRollOverrideOperation(payload, context) {
  const message = getMessageOrThrow(payload.messageId);
  const messageState = getMessageState(message);
  if (!canUserMutateMessage(context.user, message, messageState)) throw new Error(localize("Notify.NoPermission"));

  await mutateMessageState(message.id, state => {
    state.tierOverrides = state.tierOverrides ?? {};
    state.tierOverrides[payload.targetKey] = payload.override;
    state.updatedAt = Date.now();
    return state;
  });

  return { success: true };
}

export async function updateDamageOverrideOperation(payload, context) {
  const message = getMessageOrThrow(payload.messageId);
  const messageState = getMessageState(message);
  if (!canUserMutateMessage(context.user, message, messageState)) throw new Error(localize("Notify.NoPermission"));

  await mutateMessageState(message.id, state => {
    state.damageOverrides = state.damageOverrides ?? {};
    state.damageOverrides[payload.operationId] = payload.override;
    state.updatedAt = Date.now();
    return state;
  });

  return { success: true };
}

export function extractReactiveRollResult(message) {
  if (!message) return null;

  let roll = Array.from(message.rolls ?? []).reverse().find(candidate => Number(candidate.product));
  if (!roll) {
    const testPart = Array.from(message.system?.parts?.values?.() ?? [])
      .find(part => part.type === "test" && part.rolls?.length);
    roll = testPart?.rolls?.at(-1);
  }

  if (!roll) return null;
  return {
    messageId: message.id,
    tier: Number(roll.product),
    total: Number(roll.total),
  };
}

function getApplicationTargets(payload) {
  const targets = Array.isArray(payload.targets) && payload.targets.length ? payload.targets : [payload.target];
  const validTargets = targets.filter(target => target?.tokenUuid || target?.actorUuid);
  if (!validTargets.length) throw new Error("Target actor not found");
  return validTargets;
}

function getContextTargets(payload, fallbackTargets) {
  const validTargets = Array.isArray(payload.contextTargets)
    ? payload.contextTargets.filter(target => target?.tokenUuid || target?.actorUuid)
    : [];
  return validTargets.length ? validTargets : fallbackTargets;
}

function makeStackRecord(payload, records) {
  if (!records.length) throw new Error("No application records were created");
  if (!payload.selectedTokenStack || records.length === 1) return records[0];

  const first = records[0];
  return {
    ...first,
    target: {
      selectedToken: true,
      name: `${records.length} selected tokens`,
    },
    targetCount: records.length,
    records,
  };
}

async function writeApplicationRecord(messageId, operationId, record, payload = null, user = game.user) {
  const message = getMessageOrThrow(messageId);
  await mutateMessageState(message.id, state => {
    applyInteractionStatePatch(state, payload, user, message);
    state.applications = state.applications ?? {};
    state.applications[operationId] = record;
    state.updatedAt = Date.now();
    return state;
  });
}

async function pushApplicationRecord(messageId, operationId, record, payload = null, user = game.user) {
  const message = getMessageOrThrow(messageId);
  await mutateMessageState(message.id, state => {
    applyInteractionStatePatch(state, payload, user, message);
    state.applications = state.applications ?? {};
    const current = state.applications[operationId];
    const stack = getApplicationStack(current).concat(record);
    state.applications[operationId] = {
      ...record,
      stack,
      stackCount: stack.length,
      history: current?.history ?? [],
    };
    state.updatedAt = Date.now();
    return state;
  });
}

async function popApplicationRecord(messageId, operationId, undoRecord, payload = null, user = game.user) {
  const message = getMessageOrThrow(messageId);
  await mutateMessageState(message.id, state => {
    applyInteractionStatePatch(state, payload, user, message);
    state.applications = state.applications ?? {};
    const current = state.applications[operationId];
    const stack = getApplicationStack(current);
    stack.pop();
    const history = [...(current?.history ?? []), undoRecord];

    state.applications[operationId] = stack.length
      ? {
        ...stack.at(-1),
        stack,
        stackCount: stack.length,
        history,
      }
      : {
        kind: undoRecord.kind,
        status: "undone",
        target: undoRecord.target,
        stack: [],
        stackCount: 0,
        history,
        lastUndone: undoRecord,
        undoneAt: undoRecord.undoneAt,
      };

    state.updatedAt = Date.now();
    return state;
  });
}

function applyInteractionStatePatch(state, payload, user, message) {
  if (!payload || !canUserMutateMessage(user, message, state)) return;

  if (payload.targetKey && payload.tierOverride) {
    state.tierOverrides = state.tierOverrides ?? {};
    state.tierOverrides[payload.targetKey] = payload.tierOverride;
  }

  if (payload.operationId && payload.damageOverride) {
    state.damageOverrides = state.damageOverrides ?? {};
    state.damageOverrides[payload.operationId] = payload.damageOverride;
  }
}

function getLatestAppliedRecord(entry) {
  if (Array.isArray(entry?.stack) && entry.stack.length) return entry.stack.at(-1);
  return entry?.status === "applied" ? entry : null;
}

function getApplicationStack(entry) {
  if (Array.isArray(entry?.stack)) return entry.stack.filter(record => record?.status === "applied");
  return entry?.status === "applied" ? [entry] : [];
}

function isStackedApplication(entry) {
  return Array.isArray(entry?.stack);
}

function getRollContext(payload, { allowSynthetic = false } = {}) {
  const message = getMessageOrThrow(payload.messageId);
  const part = getPart(message, payload.partId);
  const rollIndex = Number(payload.rollIndex);
  const roll = part?.rolls?.[rollIndex] ?? message.rolls?.[rollIndex];
  if (!roll && !allowSynthetic) throw new Error("Damage roll not found");
  return { message, part, roll };
}

async function evaluateSyntheticDamageAmount(synthetic, message) {
  const numeric = Number(synthetic.amount);
  if (Number.isFinite(numeric)) return numeric;

  const state = getMessageState(message);
  const ability = state.abilityUuid ? await fromUuid(state.abilityUuid) : null;
  const roll = new Roll(String(synthetic.formula ?? synthetic.amount ?? "0"), ability?.getRollData?.() ?? {});
  await roll.evaluate();
  return Number(roll.total ?? 0);
}

async function resolveIsAreaAbility(abilityUuid) {
  if (!abilityUuid) return false;
  try {
    return isAreaAbility(await fromUuid(abilityUuid));
  } catch (error) {
    console.warn(`draw-steel-target-damage | Could not resolve ability ${abilityUuid}`, error);
    return false;
  }
}

function getMessageOrThrow(messageId) {
  const message = game.messages.get(messageId);
  if (!message) throw new Error("Chat message not found");
  return message;
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

async function resolveTargetOrThrow(target) {
  const resolved = await resolveTarget(target);
  if (!resolved.actor) throw new Error("Target actor not found");
  return resolved;
}

function assertCanApplyForMessage(user, message, state = getMessageState(message)) {
  if (!userCanApplyForMessage(user, message, state)) throw new Error(localize("Notify.NoPermission"));
}

function canUserRollActor(user, actor) {
  if (user?.isGM) return true;
  return actor?.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) ?? false;
}

function canUserMutateMessage(user, message, state = getMessageState(message)) {
  if (user?.isGM) return true;
  if (!user) return false;
  if (getMessageAuthorId(message) === user.id || state.sourceUserId === user.id) return true;
  return message.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) ?? false;
}

async function resolveSnapshotSquadGroup(snapshot, actor, tokenDocument) {
  if (snapshot?.groupUuid) {
    try {
      const group = await fromUuid(snapshot.groupUuid);
      if (group) return group;
    } catch (_) {}
  }
  return getSquadCombatGroup(actor, tokenDocument);
}

function getStatusName(powerEffect, effectId) {
  if (powerEffect?.name) return powerEffect.name;
  const itemEffect = powerEffect?.item?.effects?.get(effectId);
  if (itemEffect?.name) return itemEffect.name;
  const status = CONFIG.statusEffects.find(effect => effect.id === effectId);
  return status?.name ? game.i18n.localize(status.name) : effectId;
}

async function addTargetedStatusSource(effects, statusId, sourceActorUuid) {
  if (!sourceActorUuid) return;
  const key = `system.statuses.${statusId}.sources`;

  for (const effect of effects) {
    const changes = effect.changes?.map(change => change.toObject?.() ?? change) ?? [];
    if (changes.some(change => change.key === key && change.value === sourceActorUuid)) continue;
    await effect.update({
      changes: changes.concat({
        key,
        mode: CONST.ACTIVE_EFFECT_MODES.ADD,
        value: sourceActorUuid,
      }),
    });
  }
}

function findMatchingEffects(actor, effectId, statusName) {
  const lowerName = String(statusName ?? "").toLowerCase();
  return actor.effects.filter(effect => {
    if (effect.id === effectId) return true;
    if (effect.statuses?.has(effectId)) return true;
    return lowerName && String(effect.name ?? "").toLowerCase() === lowerName;
  });
}