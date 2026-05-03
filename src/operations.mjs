import { localize, TARGETED_STATUS_IDS } from "./config.mjs";
import { userCanApplyForMessage } from "./permissions.mjs";
import { getMessageAuthorId, getPart, resolveTarget } from "./target-utils.mjs";
import { getMessageState, mutateMessageState } from "./state.mjs";

export async function applyDamageOperation(payload, context) {
  const { message, roll } = getRollContext(payload, { allowSynthetic: !!payload.syntheticDamage });
  assertCanApplyForMessage(context.user, message);
  const { actor } = await resolveTargetOrThrow(payload.target);
  const before = getStaminaSnapshot(actor);

  const override = payload.damageOverride ?? null;
  const synthetic = payload.syntheticDamage ?? null;
  const syntheticAmount = synthetic ? await evaluateSyntheticDamageAmount(synthetic, message) : null;
  const baseAmount = override?.amount != null ? Number(override.amount) : Number(roll?.total ?? syntheticAmount ?? 0);
  const damageType = override?.damageType ?? roll?.type ?? synthetic?.damageType ?? "";
  const typeLabel = override?.typeLabel ?? roll?.typeLabel ?? synthetic?.typeLabel ?? "";
  const isHeal = roll?.isHeal ?? synthetic?.isHeal ?? false;

  const amount = payload.halfDamage ? Math.floor(baseAmount / 2) : baseAmount;

  if (isHeal) {
    const isTemporary = (roll?.type ?? synthetic?.damageType) !== "value";
    await actor.modifyTokenAttribute(isTemporary ? "stamina.temporary" : "stamina", amount, !isTemporary, !isTemporary);
  } else {
    await actor.system.takeDamage(amount, {
      type: damageType,
      ignoredImmunities: roll?.ignoredImmunities ?? synthetic?.ignoredImmunities ?? [],
    });
  }

  const after = getStaminaSnapshot(actor);
  const record = {
    kind: isHeal ? "healing" : "damage",
    status: "applied",
    target: payload.target,
    partId: payload.partId,
    rollIndex: Number.isFinite(Number(payload.rollIndex)) ? Number(payload.rollIndex) : payload.rollIndex,
    amount,
    originalAmount: Number(roll?.total ?? syntheticAmount ?? 0),
    halfDamage: !!payload.halfDamage,
    damageType,
    typeLabel,
    override: override ?? null,
    before,
    after,
    appliedByUserId: context.user?.id ?? game.user.id,
    appliedByUserName: context.user?.name ?? game.user.name,
    appliedAt: Date.now(),
  };

  if (payload.selectedTokenStack) await pushApplicationRecord(message.id, payload.operationId, record);
  else await writeApplicationRecord(message.id, payload.operationId, record);
  return { success: true, record };
}

export async function undoDamageOperation(payload, context) {
  const message = getMessageOrThrow(payload.messageId);
  const state = getMessageState(message);
  assertCanApplyForMessage(context.user, message, state);
  const entry = state.applications?.[payload.operationId];
  const prior = getLatestAppliedRecord(entry);
  if (!prior?.before) throw new Error("No applied damage record was found");

  const { actor } = await resolveTargetOrThrow(prior.target ?? payload.target);
  await actor.update({
    "system.stamina.value": prior.before.value,
    "system.stamina.temporary": prior.before.temporary,
  });

  const record = {
    ...prior,
    status: "undone",
    undoneByUserId: context.user?.id ?? game.user.id,
    undoneByUserName: context.user?.name ?? game.user.name,
    undoneAt: Date.now(),
    afterUndo: getStaminaSnapshot(actor),
  };

  if (payload.selectedTokenStack || isStackedApplication(entry)) await popApplicationRecord(message.id, payload.operationId, record);
  else await writeApplicationRecord(message.id, payload.operationId, record);
  return { success: true, record };
}

export async function applyStatusOperation(payload, context) {
  const message = getMessageOrThrow(payload.messageId);
  const state = getMessageState(message);
  assertCanApplyForMessage(context.user, message, state);
  const { actor } = await resolveTargetOrThrow(payload.target);
  const powerEffect = payload.effectUuid ? await fromUuid(payload.effectUuid) : null;
  const statusName = getStatusName(powerEffect, payload.effectId);
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
    await addTargetedStatusSource(afterEffects, payload.effectId, state.sourceActorUuid ?? powerEffect?.item?.actor?.uuid);
  }

  const record = {
    kind: "status",
    status: "applied",
    target: payload.target,
    partId: payload.partId,
    tier: Number(payload.tier),
    effectId: payload.effectId,
    effectUuid: payload.effectUuid,
    statusName,
    targeted: TARGETED_STATUS_IDS.has(payload.effectId),
    beforeEffects,
    afterEffectIds: afterEffects.map(effect => effect.id),
    appliedByUserId: context.user?.id ?? game.user.id,
    appliedByUserName: context.user?.name ?? game.user.name,
    appliedAt: Date.now(),
  };

  if (payload.selectedTokenStack) await pushApplicationRecord(message.id, payload.operationId, record);
  else await writeApplicationRecord(message.id, payload.operationId, record);
  return { success: true, record };
}

export async function undoStatusOperation(payload, context) {
  const message = getMessageOrThrow(payload.messageId);
  const state = getMessageState(message);
  assertCanApplyForMessage(context.user, message, state);
  const entry = state.applications?.[payload.operationId];
  const prior = getLatestAppliedRecord(entry);
  if (!prior) throw new Error("No applied status record was found");

  const { actor } = await resolveTargetOrThrow(prior.target ?? payload.target);
  const idsToDelete = (prior.afterEffectIds ?? []).filter(id => actor.effects.get(id));
  if (idsToDelete.length) await actor.deleteEmbeddedDocuments("ActiveEffect", idsToDelete);

  const restoreEffects = (prior.beforeEffects ?? []).filter(effectData => {
    const id = effectData._id ?? effectData.id;
    return id && !actor.effects.get(id);
  });
  if (restoreEffects.length) await actor.createEmbeddedDocuments("ActiveEffect", restoreEffects, { keepId: true });

  const record = {
    ...prior,
    status: "undone",
    undoneByUserId: context.user?.id ?? game.user.id,
    undoneByUserName: context.user?.name ?? game.user.name,
    undoneAt: Date.now(),
  };

  if (payload.selectedTokenStack || isStackedApplication(entry)) await popApplicationRecord(message.id, payload.operationId, record);
  else await writeApplicationRecord(message.id, payload.operationId, record);
  return { success: true, record };
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

async function writeApplicationRecord(messageId, operationId, record) {
  await mutateMessageState(messageId, state => {
    state.applications = state.applications ?? {};
    state.applications[operationId] = record;
    state.updatedAt = Date.now();
    return state;
  });
}

async function pushApplicationRecord(messageId, operationId, record) {
  await mutateMessageState(messageId, state => {
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

async function popApplicationRecord(messageId, operationId, undoRecord) {
  await mutateMessageState(messageId, state => {
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

function getStaminaSnapshot(actor) {
  return {
    value: Number(actor.system?.stamina?.value ?? 0),
    temporary: Number(actor.system?.stamina?.temporary ?? 0),
    max: Number(actor.system?.stamina?.max ?? 0),
  };
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