import { userCanApply } from "./settings.mjs";
import { getMessageState } from "./state.mjs";
import { getAbilityItem, getSpeakerTokenDocument } from "./target-utils.mjs";

export function userCanApplyForMessage(user = game.user, message, state = getMessageState(message)) {
  if (!userCanApply(user)) return false;
  if (user?.isGM) return true;
  return userOwnsMessageSource(user, message, state);
}

export function userCanApplyForTarget(user = game.user, message, state = getMessageState(message), target = null) {
  if (!userCanApply(user)) return false;
  if (user?.isGM) return true;
  if (userOwnsMessageSource(user, message, state)) return true;
  if (!target || target.selectedToken) return false;
  return userOwnsTarget(user, target);
}

export function userOwnsMessageSource(user = game.user, message, state = getMessageState(message)) {
  if (!user) return false;

  const sourceActor = resolveSourceActor(message, state);
  if (documentOwnedByUser(sourceActor, user)) return true;

  const sourceToken = resolveSourceToken(message, state);
  if (documentOwnedByUser(sourceToken, user)) return true;
  if (documentOwnedByUser(sourceToken?.actor, user)) return true;

  const ability = getAbilityItem(message);
  return documentOwnedByUser(ability?.actor, user);
}

function resolveSourceActor(message, state) {
  return fromUuidSyncSafe(state?.sourceActorUuid)
    ?? message?.speakerActor
    ?? getSpeakerTokenDocument(message)?.actor
    ?? getAbilityItem(message)?.actor
    ?? game.actors.get(message?.speaker?.actor)
    ?? null;
}

function resolveSourceToken(message, state) {
  return fromUuidSyncSafe(state?.sourceTokenUuid) ?? getSpeakerTokenDocument(message);
}

function userOwnsTarget(user, target) {
  const token = fromUuidSyncSafe(target?.tokenUuid);
  if (documentOwnedByUser(token, user)) return true;
  if (documentOwnedByUser(token?.actor, user)) return true;

  const actor = fromUuidSyncSafe(target?.actorUuid) ?? game.actors.get(target?.actorId);
  return documentOwnedByUser(actor, user);
}

function documentOwnedByUser(document, user) {
  return document?.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) ?? false;
}

function fromUuidSyncSafe(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_error) {
    return null;
  }
}