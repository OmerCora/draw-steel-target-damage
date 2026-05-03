import { FLAG_STATE, MODULE_ID } from "./config.mjs";

function cloneData(value) {
  if (value == null) return value;
  if (foundry.utils.deepClone) return foundry.utils.deepClone(value);
  return foundry.utils.duplicate(value);
}

export function normalizeState(state = {}) {
  return {
    version: 1,
    sourceUserId: null,
    sourceUserName: "",
    targetingUserId: null,
    targetingUserName: "",
    sourceActorId: null,
    sourceActorUuid: null,
    sourceActorName: "",
    sourceTokenUuid: null,
    abilityUuid: null,
    abilityName: "",
    abilityImg: null,
    isReactive: false,
    targets: [],
    applications: {},
    reactiveResults: {},
    tierOverrides: {},
    damageOverrides: {},
    ...cloneData(state),
  };
}

export function getMessageState(message) {
  return normalizeState(message?.getFlag(MODULE_ID, FLAG_STATE) ?? {});
}

export async function setMessageState(message, state) {
  if (!message) throw new Error("Chat message not found");
  await message.setFlag(MODULE_ID, FLAG_STATE, normalizeState(state));
}

export async function mutateMessageState(messageId, mutator) {
  const message = game.messages.get(messageId);
  if (!message) throw new Error("Chat message not found");

  const state = getMessageState(message);
  const nextState = await mutator(state) ?? state;
  await setMessageState(message, nextState);
  return nextState;
}

export function hasModuleState(message) {
  return !!message?.getFlag(MODULE_ID, FLAG_STATE);
}