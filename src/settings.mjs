import { MODULE_ID } from "./config.mjs";

export const SETTINGS = {
  applyPermission: "applyPermission",
  hideSystemButtons: "hideSystemButtons",
  aoeTargeting: "aoeTargeting",
  overrideAbilityRegionVisibility: "overrideAbilityRegionVisibility",
  minionDamageAutomation: "minionDamageAutomation",
  targetImageSource: "targetImageSource",
};

export const TARGET_IMAGE_SOURCES = {
  token: "token",
  portrait: "portrait",
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
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: applyHideSystemButtons,
  });

  game.settings.register(MODULE_ID, SETTINGS.aoeTargeting, {
    name: "DSTD.Settings.AoeTargeting.Name",
    hint: "DSTD.Settings.AoeTargeting.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, SETTINGS.overrideAbilityRegionVisibility, {
    name: "DSTD.Settings.OverrideAbilityRegionVisibility.Name",
    hint: "DSTD.Settings.OverrideAbilityRegionVisibility.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: false,
  });

  game.settings.register(MODULE_ID, SETTINGS.minionDamageAutomation, {
    name: "DSTD.Settings.MinionDamageAutomation.Name",
    hint: "DSTD.Settings.MinionDamageAutomation.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, SETTINGS.targetImageSource, {
    name: "DSTD.Settings.TargetImageSource.Name",
    hint: "DSTD.Settings.TargetImageSource.Hint",
    scope: "world",
    config: true,
    type: String,
    default: TARGET_IMAGE_SOURCES.token,
    choices: {
      [TARGET_IMAGE_SOURCES.token]: "DSTD.Settings.TargetImageSource.Token",
      [TARGET_IMAGE_SOURCES.portrait]: "DSTD.Settings.TargetImageSource.Portrait",
    },
    onChange: () => Hooks.callAll(`${MODULE_ID}.targetImageSourceChanged`),
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

export function isAbilityRegionVisibilityOverrideEnabled() {
  try {
    return !!game.settings.get(MODULE_ID, SETTINGS.overrideAbilityRegionVisibility);
  } catch (_) {
    return false;
  }
}

export function isMinionDamageAutomationEnabled() {
  try {
    return !!game.settings.get(MODULE_ID, SETTINGS.minionDamageAutomation);
  } catch (_) {
    return true;
  }
}

export function getTargetImageSource() {
  try {
    return game.settings.get(MODULE_ID, SETTINGS.targetImageSource) || TARGET_IMAGE_SOURCES.token;
  } catch (_) {
    return TARGET_IMAGE_SOURCES.token;
  }
}

export function applyHideSystemButtons(value = isHideSystemButtons()) {
  document.body?.classList.toggle(HIDE_SYSTEM_BODY_CLASS, !!value);
  document.body?.classList.toggle(DRAW_STEEL_PLUS_BODY_CLASS, !!game.modules.get("draw-steel-plus")?.active);
}
