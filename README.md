# Draw Steel - Target Damage

[![Downloads](https://img.shields.io/github/downloads/OmerCora/draw-steel-target-damage/total?label=Downloads&color=4aa94a)](https://github.com/OmerCora/draw-steel-target-damage/releases)
[![Latest Version Downloads](https://img.shields.io/github/downloads/OmerCora/draw-steel-target-damage/latest/total?label=Latest%20Version&color=4aa94a)](https://github.com/OmerCora/draw-steel-target-damage/releases/latest)

A Foundry VTT module for the [Draw Steel](https://mcdmproductions.com) system that adds target-aware damage, healing, status condition application with undo. Auto targeting with system AOE region placement. Also supports reactive tests directly to ability chat cards.

## Summary

Target Damage adds buttons for each target before/after an ability roll, and lets the Director or permitted actor owner apply the right damage or status without reselecting tokens over and over.

<img width="855" height="481" alt="Screenshot 2026-05-03 003845" src="https://github.com/user-attachments/assets/51a0a0f3-7131-459f-9eb0-1514db55a5ae" />



https://github.com/user-attachments/assets/88f1906f-5ebe-4804-b5f4-a8c2aef774d0



## Features

### Per-Target Chat Controls

- Captures the roller's current targets when an ability is posted to chat
- Adds damage, healing, and status buttons for each recorded target
- Keeps each target in its own row with the target portrait, name, roll result, tier result, and available actions
- Collapses multi-target rows so big area attacks do not eat the whole chat log w/ quick damage buttons in collapsed rows for faster cleanup during busy combats

### Damage, Healing, and Status Application

- Applies Draw Steel `DamageRoll` results through the system's normal damage handling
- Applies grouped minion damage and healing through the squad's shared stamina pool
- Automatically defeats minions as the squad stamina pool crosses thresholds, with area abilities capped to the targeted minions and each area application limited to one minion's stamina
- Supports healing and temporary stamina from Draw Steel healing rolls
- Applies power roll status effects and normal Draw Steel conditions
- Adds typed damage icons with color, so fire, cold, psychic, holy, and the rest are easier to scan
- Shift+Click damage buttons to apply half damage, rounded down
- Supports surge damage in Edit Damage for hero rolls and retainer rolls, spending surges on apply and refunding them on undo

### Undo Support

- Adds an undo button beside each target operation
- Restores stamina and temporary stamina to the previous values after damage or healing
- Restores squad stamina and minion defeated states for grouped minion operations
- Removes applied status effects, and restores any matching effects that were present before the button was clicked
- When no target is designated falls back to system behaviour(selected-token) but with an undo stack when you apply the same base result to several selected tokens. So you can undo multiple times.

### Target and Roll Editing

- **Update Targets** refreshes the chat card from your currently targeted tokens
- **Edit Roll** lets you adjust edges, banes, bonuses, and penalties per target, then updates the displayed tier result
- **Edit Damage** lets you add extra damage, spend surges, or change the damage type before applying it

### Reactive Tests

- Detects reactive abilities and creates per-target test buttons
- Lets owned actors roll their own reactive tests, while other requests can be relayed through the Director
- Saves each target's tier and total back onto the original ability message

### AOE Targeting

- Watches for Draw Steel ability regions placed on the canvas
- Selects tokens inside the placed area based on the ability target text and token dispositions
- Updates the latest matching ability chat card with the detected targets
- Can be turned off if you prefer to manage targets manually
- Cross checks for token disposition and ability target description. 
In example: If an ability target contains "Allies", Hostile tokens only target other Hostile tokens with placed aoe regions. 

### Permissions

- The Director can always apply and undo target controls
- The `Apply Damage/Status Condition Permission` setting controls the minimum role allowed to use apply and undo buttons. (Players can only click the ability rolls they own)

## Settings

- **Apply Damage/Status Condition Permission:** Minimum role allowed to apply or undo damage and status buttons. Defaults to Director. Non-Director users are still limited to source actors or tokens they own.
- **Hide System Roll & Damage Buttons:** Hides the system's duplicate controls on managed chat cards. Defaults on.
- **AOE Targeting:** Automatically updates the latest matching ability card when Draw Steel places an area region. Defaults on.
- **Override Ability Region Visibility:** Creates Draw Steel ability template regions with Always for Anyone visibility instead of Always for Observers. Defaults on.
- **Automated Minion Damage:** Handles squad stamina caps and minion defeat automation for targeted damage. Defaults on.
- **Target Image Source:** Choose whether target boxes show token images or actor portraits. Defaults to token images.

## Installation

Search for **"Draw Steel - Target Damage"** in the Foundry module browser, or paste the manifest URL directly:

```
https://github.com/OmerCora/draw-steel-target-damage/releases/latest/download/module.json
```

## Compatibility

| | Version |
|---|---|
| **Foundry VTT** | v13+ (verified 14.360) |
| **Draw Steel System** | v0.11.0+ (verified 1.0.0) |

## License

Module code is licensed under [MIT](LICENSE).

This module uses content from *Draw Steel: Heroes* (ISBN: 978-1-7375124-7-9) under the [DRAW STEEL Creator License](https://mcdm.gg/DS-license).

## Support

If you find this module useful, consider supporting development:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/G2G263V03)

---

*Draw Steel - Target Damage is an independent product published under the DRAW STEEL Creator License and is not affiliated with MCDM Productions, LLC. DRAW STEEL &copy; 2024 MCDM Productions, LLC.*
