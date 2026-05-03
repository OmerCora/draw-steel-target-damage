import { localize, SOCKET_NAME } from "./config.mjs";

const pendingRequests = new Map();
let actionHandlers = {};

export function registerSocketHandlers(handlers) {
  actionHandlers = handlers;
  game.socket.on(SOCKET_NAME, handleSocketMessage);
}

export async function executeMutation(action, payload) {
  if (game.user.isGM) return runHandler(action, payload, game.user, false);
  return requestGM(action, payload);
}

async function requestGM(action, payload) {
  const gm = getResponsibleGM();
  if (!gm) return { success: false, error: localize("Notify.NoGM") };

  const requestId = foundry.utils.randomID();
  const timeoutMs = 15000;

  return new Promise(resolve => {
    const timeoutId = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve({ success: false, error: localize("Notify.SocketTimeout") });
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, timeoutId });

    game.socket.emit(SOCKET_NAME, {
      type: "request",
      requestId,
      action,
      payload,
      userId: game.user.id,
    });
  });
}

async function handleSocketMessage(message) {
  if (message?.type === "response") {
    if (message.targetUserId !== game.user.id) return;
    const pending = pendingRequests.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pendingRequests.delete(message.requestId);
    pending.resolve(message.result);
    return;
  }

  if (message?.type !== "request") return;
  if (!isResponsibleGM()) return;

  const requester = game.users.get(message.userId);
  const result = await runHandler(message.action, message.payload, requester, true);

  game.socket.emit(SOCKET_NAME, {
    type: "response",
    requestId: message.requestId,
    targetUserId: message.userId,
    result,
  });
}

async function runHandler(action, payload, user, viaSocket) {
  const handler = actionHandlers[action];
  if (!handler) return { success: false, error: `Unknown socket action: ${action}` };

  try {
    return await handler(payload, { user, viaSocket });
  } catch (error) {
    console.error(error);
    return { success: false, error: error.message ?? String(error) };
  }
}

function getResponsibleGM() {
  return game.users.activeGM ?? game.users.find(user => user.active && user.isGM) ?? null;
}

function isResponsibleGM() {
  return game.user.id === getResponsibleGM()?.id;
}