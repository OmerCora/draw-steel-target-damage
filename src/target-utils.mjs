import { MODULE_ID } from "./config.mjs";

export function getParts(message) {
  const parts = message?.system?.parts;
  if (!parts) return [];
  if (Array.isArray(parts)) return parts;
  if (typeof parts.values === "function") return Array.from(parts.values());
  if (typeof parts.contents !== "undefined") return Array.from(parts.contents);
  return Object.values(parts);
}

export function getPartId(part) {
  return part?.id ?? part?._id;
}

export function getPart(message, partId) {
  const parts = message?.system?.parts;
  if (!parts) return null;
  if (typeof parts.get === "function") return parts.get(partId) ?? null;
  return getParts(message).find(part => getPartId(part) === partId) ?? null;
}

export function isAbilityMessage(message) {
  return getParts(message).some(part => ["abilityUse", "abilityResult", "test"].includes(part.type));
}

export function isActionableAbilityMessage(message) {
  return getParts(message).some(part => isRollResultPart(part) && hasPowerRolls(part)) || isReactiveAbilityMessage(message);
}

export function isDamageRollMessage(message) {
  return getParts(message).some(part => hasDamageRolls(part)) || hasDamageRolls(message);
}

export function shouldManageMessage(message) {
  return isActionableAbilityMessage(message) || isDamageRollMessage(message);
}

export function getAbilityUsePart(message) {
  return getParts(message).find(part => part.type === "abilityUse") ?? null;
}

export function getAbilityUuid(message) {
  const abilityUse = getAbilityUsePart(message);
  if (abilityUse?.abilityUuid) return abilityUse.abilityUuid;
  const result = getParts(message).find(part => part.type === "abilityResult" && part.abilityUuid);
  if (result?.abilityUuid) return result.abilityUuid;
  const test = getParts(message).find(part => part.type === "test" && part.resultSource);
  return test?.resultSource ?? null;
}

export function getAbilityItem(message) {
  const abilityUuid = getAbilityUuid(message);
  if (!abilityUuid) return null;
  try {
    return fromUuidSync(abilityUuid);
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not resolve ability ${abilityUuid}`, error);
    return null;
  }
}

export function getMessageAuthorId(message) {
  return message?.user?.id ?? message?.user ?? message?.userId ?? null;
}

export function getSpeakerTokenDocument(message) {
  const speaker = message?.speaker ?? {};
  if (!speaker.token) return null;

  const speakerScene = speaker.scene ? game.scenes.get(speaker.scene) : null;
  const canvasScene = globalThis.canvas?.scene ?? null;
  const scene = speakerScene ?? (!speaker.scene || canvasScene?.id === speaker.scene ? canvasScene : null);
  return scene?.tokens?.get(speaker.token) ?? null;
}

export function isReactiveAbilityMessage(message) {
  const ability = getAbilityItem(message);
  return ability?.type === "ability" && !!ability.system?.power?.roll?.reactive;
}

export function isDamageRoll(roll) {
  const DamageRoll = globalThis.ds?.rolls?.DamageRoll ?? CONFIG.Dice.rolls.find(candidate => candidate.name === "DamageRoll");
  return DamageRoll ? roll instanceof DamageRoll : roll?.constructor?.name === "DamageRoll";
}

export function isPowerRoll(roll) {
  const PowerRoll = globalThis.ds?.rolls?.PowerRoll ?? CONFIG.Dice.rolls.find(candidate => candidate.name === "PowerRoll");
  if (PowerRoll && roll instanceof PowerRoll) return true;
  if (roll?.constructor?.name === "PowerRoll") return true;
  return Number.isFinite(Number(roll?.product)) && !!roll?.dice?.length;
}

export function hasDamageRolls(container) {
  return Array.from(container?.rolls ?? []).some(roll => isDamageRoll(roll));
}

export function hasPowerRolls(container) {
  return Array.from(container?.rolls ?? []).some(roll => isPowerRoll(roll));
}

export function isRollResultPart(part) {
  return ["abilityResult", "test"].includes(part?.type);
}

export function normalizeTargetToken(token) {
  const document = token?.document ?? token;
  const actor = token?.actor ?? document?.actor;
  if (!document?.uuid || !actor) return null;

  return {
    tokenUuid: document.uuid,
    tokenId: document.id ?? null,
    sceneId: document.parent?.id ?? null,
    actorUuid: actor.uuid,
    actorId: actor.id ?? null,
    name: token?.name ?? document.name ?? actor.name,
    img: document.texture?.src ?? actor.img ?? "icons/svg/mystery-man.svg",
  };
}

export function collectCurrentTargets() {
  const targets = Array.from(game.user.targets ?? [])
    .map(token => normalizeTargetToken(token))
    .filter(target => target?.tokenUuid || target?.actorUuid);

  const seen = new Set();
  return targets.filter(target => {
    const key = getTargetKey(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function getTargetKey(target) {
  if (target?.selectedToken) return "selected-token";
  const raw = target?.tokenUuid ?? target?.actorUuid ?? target?.tokenId ?? target?.actorId ?? "";
  // Replace dots so the key is safe to use as an object key inside Foundry flags
  // (setFlag runs expandObject on the value, which would otherwise turn a dotted
  // key like "Scene.x.Token.y" into a nested path).
  return String(raw).replace(/\./g, "__");
}

export async function resolveTarget(target) {
  let tokenDocument = null;
  let actor = null;

  if (target?.tokenUuid) {
    try {
      tokenDocument = await fromUuid(target.tokenUuid);
      actor = tokenDocument?.actor ?? null;
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not resolve token ${target.tokenUuid}`, error);
    }
  }

  if (!actor && target?.actorUuid) {
    try {
      actor = await fromUuid(target.actorUuid);
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not resolve actor ${target.actorUuid}`, error);
    }
  }

  return { actor, tokenDocument };
}

export function hashString(value) {
  let hash = 0;
  const text = String(value ?? "");
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export function makeOperationId(kind, target, action) {
  const targetHash = hashString(getTargetKey(target));
  const actionId = action.rollIndex ?? action.effectId ?? action.characteristic ?? "action";
  return `${kind}-${action.partId ?? "part"}-${actionId}-${targetHash}`.replace(/[^A-Za-z0-9_-]/g, "-");
}

export function getRenderableTargets(state) {
  // Only show CURRENTLY targeted entries. Applications/reactive results stay in flags
  // as history but are not displayed once a target is removed via Update Targets.
  return [...(state?.targets ?? [])];
}

/* -------------------------------------------------- */

/**
 * Find the abilityResult part whose `rolls` array contains a PowerRoll for the given target.
 * Power rolls store the target actor uuid in `roll.options.target`.
 * Returns { part, powerRoll, partId } or null.
 */
export function findTargetPart(message, target) {
  const targetActorUuid = target?.actorUuid;
  for (const part of getParts(message)) {
    if (!isRollResultPart(part)) continue;
    for (const roll of Array.from(part.rolls ?? []).reverse()) {
      const rollTargetUuid = roll?.options?.target;
      if (!rollTargetUuid) continue;
      if (rollTargetUuid === targetActorUuid) {
        return { part, powerRoll: roll, partId: getPartId(part) };
      }
    }
  }
  // Fallback: if there is exactly one abilityResult part, use that
  // (ability had a base roll only, single target, or no per-roll target tagging).
  const resultParts = getParts(message).filter(p => isRollResultPart(p) && hasPowerRolls(p));
  if (resultParts.length === 1) {
    const part = resultParts[0];
    const powerRoll = Array.from(part.rolls ?? []).reverse().find(r => isPowerRoll(r));
    return { part, powerRoll, partId: getPartId(part) };
  }
  return null;
}

/* -------------------------------------------------- */

/**
 * Compute a power-roll tier from a natural d10 sum and modifier options.
 * Mirrors Draw Steel's PowerRoll math: single edge/bane shifts the total by 2,
 * double edge/bane shifts the tier by 1, and bonuses/penalties modify total.
 */
export function computeTierFromDice(naturalSum, edges = 0, banes = 0, bonuses = 0, criticalThreshold = 19, staticModifier = 0) {
  const naturalTotal = Number(naturalSum) || 0;
  if (naturalTotal >= Number(criticalThreshold ?? 19)) return 3;
  const net = (Number(edges) || 0) - (Number(banes) || 0);
  const singleEdgeBaneAdjustment = Math.abs(net) === 1 ? Math.sign(net) * 2 : 0;
  const total = naturalTotal + (Number(staticModifier) || 0) + singleEdgeBaneAdjustment + (Number(bonuses) || 0);
  let tier = 1;
  if (total >= 12) tier = 2;
  if (total >= 17) tier = 3;
  const adjustment = net - Math.sign(net);
  return Math.min(3, Math.max(1, tier + adjustment));
}

export function computePowerRollSummary(powerRoll, override = null) {
  const naturalTotal = readNaturalRoll(powerRoll);
  const edges = override?.edges != null ? Number(override.edges) : Number(powerRoll?.options?.edges ?? 0);
  const banes = override?.banes != null ? Number(override.banes) : Number(powerRoll?.options?.banes ?? 0);
  const bonuses = override?.bonuses != null ? Number(override.bonuses) : Number(powerRoll?.options?.bonuses ?? 0);
  const criticalThreshold = Number(powerRoll?.options?.criticalThreshold ?? 19);
  const staticModifier = override?.staticModifier != null
    ? Number(override.staticModifier)
    : getStaticRollModifier(powerRoll, naturalTotal);
  const net = edges - banes;
  const singleEdgeBaneAdjustment = Math.abs(net) === 1 ? Math.sign(net) * 2 : 0;
  const total = naturalTotal + staticModifier + singleEdgeBaneAdjustment + bonuses;
  const isCritical = naturalTotal >= criticalThreshold;
  const tier = computeTierFromDice(naturalTotal, edges, banes, bonuses, criticalThreshold, staticModifier);

  return {
    naturalTotal,
    staticModifier,
    edges,
    banes,
    bonuses,
    net,
    total,
    tier,
    isCritical,
    formula: formatPowerRollFormula(powerRoll, { net, bonuses, staticModifier }),
  };
}

function getStaticRollModifier(powerRoll, naturalTotal) {
  const total = Number(powerRoll?.total);
  if (!Number.isFinite(total)) return 0;
  const edges = Number(powerRoll?.options?.edges ?? 0);
  const banes = Number(powerRoll?.options?.banes ?? 0);
  const bonuses = Number(powerRoll?.options?.bonuses ?? 0);
  const net = edges - banes;
  const singleEdgeBaneAdjustment = Math.abs(net) === 1 ? Math.sign(net) * 2 : 0;
  return total - (Number(naturalTotal) || 0) - singleEdgeBaneAdjustment - bonuses;
}

function formatPowerRollFormula(powerRoll, { net, bonuses, staticModifier }) {
  const baseFormula = powerRoll?.terms?.[0]?.formula ?? powerRoll?.dice?.[0]?.formula ?? "2d10";
  const parts = [String(baseFormula)];
  if (staticModifier) parts.push(`${staticModifier > 0 ? "+" : "-"} ${Math.abs(staticModifier)}`);
  if (Math.abs(net) === 1) parts.push(`${net > 0 ? "+" : "-"} 2[${net > 0 ? "E" : "B"}]`);
  if (bonuses) parts.push(`${bonuses > 0 ? "+" : "-"} ${Math.abs(bonuses)}`);
  return parts.join(" ");
}

export function findResultPartForTier(message, tier) {
  const tierNumber = Number(tier);
  return getParts(message).find(part => part.type === "abilityResult" && Number(part.tier) === tierNumber) ?? null;
}

/**
 * Read the natural d10 sum from a PowerRoll, ignoring modifiers.
 */
export function readNaturalRoll(powerRoll) {
  try {
    const die = powerRoll?.dice?.[0] ?? powerRoll?.terms?.find(t => t?.faces === 10);
    return Number(die?.total ?? die?.results?.reduce?.((s, r) => s + (Number(r.result) || 0), 0) ?? 0);
  } catch (_) {
    return 0;
  }
}

export function getTierGlyph(tier) {
  try {
    return globalThis.ds?.rolls?.PowerRoll?.RESULT_TIERS?.[`tier${Number(tier)}`]?.glyph ?? "";
  } catch (_) {
    return "";
  }
}

export function getTierLabel(tier) {
  try {
    const key = globalThis.ds?.rolls?.PowerRoll?.RESULT_TIERS?.[`tier${Number(tier)}`]?.label;
    return key ? game.i18n.localize(key) : `Tier ${tier}`;
  } catch (_) {
    return `Tier ${tier}`;
  }
}

export function findDamageRollPart(message) {
  for (const part of getParts(message)) {
    if (hasDamageRolls(part)) return { part, powerRoll: null, partId: getPartId(part) };
  }

  const rollIndex = Array.from(message?.rolls ?? []).findIndex(roll => isDamageRoll(roll));
  if (rollIndex >= 0) return { part: { _id: "message", id: "message", rolls: message.rolls }, powerRoll: null, partId: "message" };
  return null;
}