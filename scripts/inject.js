/** World Modulator injection, modified 2026-10-23 for direct world edits. */
import { MODULE_NAME } from './prompts.js';
import { getSettings } from './state.js';
import { getModifications, renderModifications } from './modifier.js';

const KEY = `${MODULE_NAME}_inject_99_modifications`;
const LEGACY_SEGMENTS = ['modulator', 'worldState', 'worldRules', 'characters', 'wardrobe'];
export const POSITIONS = Object.freeze({ IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 });
export const ROLES = Object.freeze({ SYSTEM: 0, USER: 1, ASSISTANT: 2 });
let lastInjectedKeys = [];

function clearLegacy(ctx) {
    LEGACY_SEGMENTS.forEach((name, index) => {
        ctx.setExtensionPrompt?.(`${MODULE_NAME}_inject_${name}`, '', 0, 0);
        ctx.setExtensionPrompt?.(`${MODULE_NAME}_inject_${String(index).padStart(2, '0')}_${name}`, '', 0, 0);
    });
}

export function buildInjectionSegments(ctx) {
    const settings = getSettings(ctx);
    if (!settings || settings.modifierInjectionEnabled === false) return {};
    const text = renderModifications(getModifications(ctx), String(ctx?.name1 || '用户'));
    return text ? { modifications: text } : {};
}

export function applyInjection(ctx) {
    clearLegacy(ctx);
    const text = buildInjectionSegments(ctx).modifications || '';
    const settings = getSettings(ctx);
    const depth = Math.max(0, Math.min(100, Math.floor(Number(settings?.modifierInjectDepth) || 0)));
    if (typeof ctx?.setExtensionPrompt !== 'function') {
        lastInjectedKeys = [];
        return { injected: [], length: 0, available: false };
    }
    ctx.setExtensionPrompt(KEY, text, POSITIONS.IN_CHAT, depth, false, ROLES.SYSTEM);
    lastInjectedKeys = text ? [KEY] : [];
    return { injected: text ? ['modifications'] : [], length: text.length, available: true };
}

export function clearInjection(ctx) {
    clearLegacy(ctx);
    ctx.setExtensionPrompt?.(KEY, '', POSITIONS.IN_CHAT, 0);
    lastInjectedKeys = [];
}
export function getInjectedKeys() { return [...lastInjectedKeys]; }
