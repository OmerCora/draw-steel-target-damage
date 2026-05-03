import { FLAG_STATE, MODULE_ID } from "./config.mjs";
import { isAbilityRegionVisibilityOverrideEnabled, isAoeTargetingEnabled } from "./settings.mjs";
import { hasModuleState, mutateMessageState } from "./state.mjs";
import { getAbilityUuid, normalizeTargetToken } from "./target-utils.mjs";

const DRAW_STEEL_SCOPE = "draw-steel";

export function initializeAoeTargeting() {
  Hooks.on("preCreateRegion", (region) => {
    if (!isAbilityRegionVisibilityOverrideEnabled()) return;
    if (!getAbilitySource(region)) return;

    region.updateSource({ visibility: CONST.REGION_VISIBILITY.ALWAYS });
  });

  Hooks.on("createRegion", (region, _options, userId) => {
    if (userId !== game.user.id) return;
    if (!isAoeTargetingEnabled()) return;
    handleCreatedRegion(region).catch(error => {
      console.warn(`${MODULE_ID} | AOE targeting failed`, error);
    });
  });
}

async function handleCreatedRegion(region) {
  const abilityUuid = getAbilitySource(region);
  if (!abilityUuid) return;

  const ability = await fromUuid(abilityUuid);
  if (!ability?.system) return;

  const sourceToken = findSourceToken(ability.actor);
  const criteria = getTargetCriteria(ability);
  const tokensInRegion = Array.from(canvas.tokens?.placeables ?? []).filter(token => regionContainsToken(region, token));
  const targetTokens = tokensInRegion.filter(token => shouldTargetToken(token, sourceToken, criteria));

  if (criteria.self && sourceToken && !targetTokens.includes(sourceToken)) targetTokens.push(sourceToken);

  await setUserTargets(targetTokens);
  await updateLatestMessageTargets(ability.uuid, targetTokens);
}

function getAbilitySource(region) {
  return region.getFlag?.(DRAW_STEEL_SCOPE, "abilitySource")
    ?? foundry.utils.getProperty(region, `flags.${DRAW_STEEL_SCOPE}.abilitySource`)
    ?? foundry.utils.getProperty(region._source, `flags.${DRAW_STEEL_SCOPE}.abilitySource`);
}

function getTargetCriteria(ability) {
  const target = ability.system.target ?? {};
  const type = String(target.type ?? "");
  const label = ability.system.formattedLabels?.target ?? "";
  const text = `${type} ${target.custom ?? ""} ${label}`.toLowerCase();

  return {
    enemy: type.includes("enemy") || /\benem(?:y|ies)\b/.test(text),
    ally: type.includes("ally") || /\ball(?:y|ies)\b/.test(text),
    self: type.includes("self") || /\bself\b/.test(text),
    creature: type.includes("creature") || /\bcreatures?\b/.test(text),
    object: type.includes("object") || /\bobjects?\b/.test(text),
  };
}

function shouldTargetToken(token, sourceToken, criteria) {
  const actor = token.actor;
  if (!actor) return false;

  const disposition = Number(token.document?.disposition ?? token.disposition ?? 0);
  const sourceDisposition = Number(sourceToken?.document?.disposition ?? sourceToken?.disposition ?? 0);
  const isObject = actor.type === "object";
  const isSelf = sourceToken && token.document?.uuid === sourceToken.document?.uuid;

  const rules = [
    () => isNeutralOrSecret(disposition),
    () => criteria.self && isSelf,
    () => criteria.creature && !isObject,
    () => criteria.object && isObject,
    () => criteria.ally && sourceDisposition && disposition === sourceDisposition,
    () => criteria.enemy && isEnemyDisposition(sourceDisposition, disposition),
  ];

  return rules.some(rule => rule());
}

function isEnemyDisposition(sourceDisposition, disposition) {
  const { FRIENDLY, HOSTILE } = CONST.TOKEN_DISPOSITIONS;
  if (sourceDisposition === FRIENDLY) return disposition === HOSTILE;
  if (sourceDisposition === HOSTILE) return disposition === FRIENDLY;
  return false;
}

function isNeutralOrSecret(disposition) {
  const { NEUTRAL, SECRET } = CONST.TOKEN_DISPOSITIONS;
  return disposition === NEUTRAL || disposition === SECRET;
}

function regionContainsToken(region, token) {
  if (!region?.testPoint) return false;
  const elevation = Number(token.document?.elevation ?? 0);
  return getTokenSamplePoints(token).some(point => region.testPoint({ ...point, elevation }));
}

function getTokenSamplePoints(token) {
  const center = token.center ?? {
    x: Number(token.document?.x ?? token.x ?? 0) + Number(token.w ?? canvas.grid.size) / 2,
    y: Number(token.document?.y ?? token.y ?? 0) + Number(token.h ?? canvas.grid.size) / 2,
  };
  const inset = Math.max(1, Math.min(Number(token.w ?? canvas.grid.size), Number(token.h ?? canvas.grid.size)) * 0.25);
  return [
    center,
    { x: center.x - inset, y: center.y - inset },
    { x: center.x + inset, y: center.y - inset },
    { x: center.x - inset, y: center.y + inset },
    { x: center.x + inset, y: center.y + inset },
  ];
}

function findSourceToken(actor) {
  if (!actor) return null;
  return canvas.tokens?.controlled?.find(token => token.actor?.uuid === actor.uuid)
    ?? actor.token?.object
    ?? actor.getActiveTokens?.(true, true)?.find(token => token.scene?.id === canvas.scene?.id)
    ?? actor.getActiveTokens?.(true, true)?.[0]
    ?? null;
}

async function setUserTargets(tokens) {
  const ids = tokens.map(token => token.id).filter(Boolean);
  if (typeof game.user.updateTokenTargets === "function") {
    await game.user.updateTokenTargets(ids);
    return;
  }

  for (const token of canvas.tokens?.placeables ?? []) token.setTarget(false, { user: game.user, releaseOthers: false, groupSelection: true });
  for (const token of tokens) token.setTarget(true, { user: game.user, releaseOthers: false, groupSelection: true });
}

async function updateLatestMessageTargets(abilityUuid, tokens) {
  const targetData = tokens.map(token => normalizeTargetToken(token)).filter(Boolean);
  const messages = Array.from(game.messages ?? []).reverse();
  const message = messages.find(candidate => hasModuleState(candidate)
    && (candidate.getFlag(MODULE_ID, FLAG_STATE)?.abilityUuid === abilityUuid || getAbilityUuid(candidate) === abilityUuid)
    && (candidate.isOwner || game.user.isGM));
  if (!message) return;

  await mutateMessageState(message.id, state => {
    state.targets = targetData;
    state.targetingUserId = game.user.id;
    state.targetingUserName = game.user.name;
    state.updatedAt = Date.now();
    return state;
  });
}