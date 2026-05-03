import { userCanApply } from "./settings.mjs";
import { getMessageState } from "./state.mjs";
import { getAbilityItem, getSpeakerTokenDocument } from "./target-utils.mjs";

export function userCanApplyForMessage(user = game.user, message, state = getMessageState(message)) {
  if (!userCanApply(user)) return false;
  if (user?.isGM) return true;
  return userOwnsMessageSource(user, message, state);
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