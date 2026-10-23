/** Backup and API import, added for the 2026-10-23 derivative. */
import { DEFAULT_SETTINGS, getSettings, getChatKey, normalizeApiProfiles, API_PROFILE_FIELDS, saveSettings } from './state.js';
import { normalizeModification } from './modifier.js';
import { normalizeBase } from './api.js';
const record = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
function retainCurrentKey(settings, incoming) {
    if (incoming.apiKey === undefined && incoming.apiUrl !== undefined
        && normalizeBase(incoming.apiUrl) !== normalizeBase(settings.apiUrl)) incoming.apiKey = '';
}

export function parseImport(text) {
    return JSON.parse(text, (key, value) => {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('导入文件包含不支持的字段。');
        return value;
    });
}

export function exportBackup(ctx, includeSecrets = false) {
    const settings = clone(getSettings(ctx));
    if (!includeSecrets) {
        delete settings.apiKey;
        for (const profile of settings.apiProfiles || []) delete profile.apiKey;
    }
    return { format: 'world-modifier', schemaVersion: 2, exportedAt: new Date().toISOString(), settings };
}

export function importBackup(ctx, payload) {
    if (!record(payload)) throw new Error('备份必须是 JSON 对象。');
    const settings = getSettings(ctx);
    if (payload.format === 'world-modifier') {
        if (payload.schemaVersion !== 2 || !record(payload.settings)) throw new Error('不支持这个备份版本。');
        const incoming = clone(payload.settings);
        retainCurrentKey(settings, incoming);
        if (!record(incoming.chatData)) throw new Error('备份缺少聊天数据。');
        for (const data of Object.values(incoming.chatData)) {
            if (!record(data)) throw new Error('聊天数据格式错误。');
            if (data.modifications !== undefined && !Array.isArray(data.modifications)) throw new Error('修改列表格式错误。');
            if (data.modifications) data.modifications = data.modifications.map(normalizeModification).filter(Boolean);
        }
        if (incoming.apiProfiles) incoming.apiProfiles = mergeProfileSecrets(settings, incoming.apiProfiles);
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (incoming[key] !== undefined && key !== 'chatData') settings[key] = incoming[key];
        }
        settings.chatData = { ...settings.chatData, ...incoming.chatData };
    } else if (payload.exportedBy === 'World Modulator' && record(payload.chatData)) {
        // v1 exported a single chat and forgot the current apiKey. Preserve absent fields.
        const incoming = record(payload.settings) ? clone(payload.settings) : {};
        retainCurrentKey(settings, incoming);
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (incoming[key] !== undefined && !['chatData', 'globalRules', 'globalCharacters', 'apiProfiles'].includes(key)) settings[key] = clone(incoming[key]);
        }
        if (incoming.apiProfiles) settings.apiProfiles = mergeProfileSecrets(settings, incoming.apiProfiles);
        settings.chatData[getChatKey(ctx)] = clone(payload.chatData);
        if (record(payload.globalRules)) settings.globalRules = { ...settings.globalRules, ...payload.globalRules };
        if (record(payload.globalCharacters)) settings.globalCharacters = { ...settings.globalCharacters, ...payload.globalCharacters };
    } else {
        throw new Error('这不是世界修改器备份；API 配置请使用「导入 API」。');
    }
    saveSettings(ctx);
}

function mergeProfileSecrets(settings, profiles) {
    if (!Array.isArray(profiles)) throw new Error('API 配置组必须是数组。');
    return normalizeApiProfiles(profiles.map((profile) => {
        const old = settings.apiProfiles?.find((entry) => entry.name === profile?.name
            && normalizeBase(entry.apiUrl) === normalizeBase(profile?.apiUrl));
        return { ...profile, apiKey: profile?.apiKey ?? old?.apiKey ?? '' };
    }));
}

export function importApiConfig(ctx, payload) {
    const settings = getSettings(ctx);
    const source = record(payload?.settings) ? payload.settings : payload;
    if (!record(source)) throw new Error('API 配置必须是 JSON 对象。');
    const apiUrl = source.apiUrl ?? source.base_url ?? source.baseURL ?? source.url;
    const apiKey = source.apiKey ?? source.api_key ?? source.key;
    const model = source.model ?? source.modelName;
    const profiles = source.apiProfiles ?? source.profiles;
    if (apiUrl === undefined && apiKey === undefined && model === undefined && !Array.isArray(profiles)) throw new Error('没有找到 API 地址、Key、模型或配置组。');
    const normalizedProfiles = profiles === undefined ? null : mergeProfileSecrets(settings, profiles);
    const next = {};
    for (const [name, value] of Object.entries({ apiUrl, apiKey, model })) {
        if (value !== undefined && typeof value !== 'string') throw new Error(name + ' 必须是文本。');
    }
    if (apiUrl !== undefined) next.apiUrl = normalizeBase(apiUrl);
    if (apiKey !== undefined) next.apiKey = String(apiKey).trim();
    if (model !== undefined) next.model = String(model).trim();
    retainCurrentKey(settings, next);
    for (const key of API_PROFILE_FIELDS) {
        if (!['apiUrl', 'apiKey', 'model', 'apiMode'].includes(key) && source[key] !== undefined) next[key] = source[key];
    }
    if (Object.keys(next).length || source.apiMode) next.apiMode = source.apiMode === 'main' ? 'main' : 'custom';
    if (normalizedProfiles) {
        settings.apiProfiles = normalizedProfiles;
        if (!Object.keys(next).length && normalizedProfiles.length) {
            for (const key of API_PROFILE_FIELDS) next[key] = normalizedProfiles[0][key];
        }
    }
    Object.assign(settings, next);
    saveSettings(ctx);
    return normalizedProfiles?.length || 1;
}
