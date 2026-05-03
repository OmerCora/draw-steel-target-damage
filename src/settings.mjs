import { MODULE_ID } from "./config.mjs";

export const SETTINGS = {
  applyPermission: "applyPermission",
  hideSystemButtons: "hideSystemButtons",
  aoeTargeting: "aoeTargeting",
};

const HIDE_SYSTEM_BODY_CLASS = `${MODULE_ID}-hide-system`;
const DRAW_STEEL_PLUS_BODY_CLASS = `${MODULE_ID}-draw-steel-plus`;

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTINGS.applyPermission, {
    name: "DSTD.Settings.ApplyPermission.Name",
    hint: "DSTD.Settings.ApplyPermission.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: CONST.USER_ROLES.GAMEMASTER,
    choices: {
      [CONST.USER_ROLES.PLAYER]: "DSTD.Settings.Roles.Player",
      [CONST.USER_ROLES.TRUSTED]: "DSTD.Settings.Roles.Trusted",
      [CONST.USER_ROLES.ASSISTANT]: "DSTD.Settings.Roles.Assistant",
      [CONST.USER_ROLES.GAMEMASTER]: "DSTD.Settings.Roles.Director",
    },
  });

  game.settings.register(MODULE_ID, SETTINGS.hideSystemButtons, {
    name: "DSTD.Settings.HideSystemButtons.Name",
    hint: "DSTD.Settings.HideSystemButtons.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: applyHideSystemButtons,
  });

  game.settings.register(MODULE_ID, SETTINGS.aoeTargeting, {
    name: "DSTD.Settings.AoeTargeting.Name",
    hint: "DSTD.Settings.AoeTargeting.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });
}

export function getApplyPermissionRole() {
  return Number(game.settings.get(MODULE_ID, SETTINGS.applyPermission));
}

export function userCanApply(user = game.user) {
  return user?.isGM || Number(user?.role ?? 0) >= getApplyPermissionRole();
}

export function isHideSystemButtons() {
  try {
    return !!game.settings.get(MODULE_ID, SETTINGS.hideSystemButtons);
  } catch (_) {
    return false;
  }
}

export function isAoeTargetingEnabled() {
  try {
    return !!game.settings.get(MODULE_ID, SETTINGS.aoeTargeting);
  } catch (_) {
    return true;
  }
}

export function applyHideSystemButtons(value = isHideSystemButtons()) {
  document.body?.classList.toggle(HIDE_SYSTEM_BODY_CLASS, !!value);
  document.body?.classList.toggle(DRAW_STEEL_PLUS_BODY_CLASS, !!game.modules.get("draw-steel-plus")?.active);
}
