/** World Modulator entry, replaced 2026-10-23: a direct, simple world modifier. */
import { getContextSafe, getSettings, getChatKey, saveSettings, buildRecentMessages,
    normalizeApiProfiles, saveApiProfile, applyApiProfile, deleteApiProfile } from './scripts/state.js';
import { callAnalyzer, fetchModelList, resolveConnection, getDebugInfo } from './scripts/api.js';
import { getModifications, saveModification, toggleModification, removeModification,
    undoLastModification, MODIFICATION_TYPES, AWARENESS_MODES } from './scripts/modifier.js';
import { applyInjection, clearInjection, buildInjectionSegments } from './scripts/inject.js';
import { exportBackup, importBackup, importApiConfig, parseImport } from './scripts/backup.js';

const TEMPLATE_URL = new URL('./template.html', import.meta.url).href;
const $ = (selector) => document.querySelector(selector);
const ui = { ready: false, tab: 'edit', editingId: '', chatKey: '', controller: null, toastTimer: null };
const current = () => getContextSafe();
const hasChat = (ctx) => Boolean(ctx && (ctx.characterId !== undefined && ctx.characterId !== null || ctx.groupId || ctx.chat?.length));

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
function notify(message, error = false) {
    const toast = $('#wm-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.dataset.error = String(error);
    toast.hidden = false;
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => { toast.hidden = true; }, 3800);
}
function status(selector, message, error = false) {
    const node = $(selector);
    node.textContent = message;
    node.dataset.error = String(error);
}
function value(selector, next) {
    const node = $(selector);
    if (node && document.activeElement !== node) node.value = next ?? '';
}
function applyTheme() {
    $('#wm-panel').dataset.theme = getSettings()?.theme === 'light' ? 'light' : 'dark';
}
function switchTab(tab) {
    ui.tab = ['edit', 'active', 'settings'].includes(tab) ? tab : 'edit';
    document.querySelectorAll('#wm-panel [data-tab]').forEach((node) => {
        const selected = node.dataset.tab === ui.tab;
        node.classList.toggle('wm-active', selected);
        node.setAttribute('aria-current', selected ? 'page' : 'false');
    });
    document.querySelectorAll('#wm-panel [data-page]').forEach((node) => { node.hidden = node.dataset.page !== ui.tab; });
    if (ui.tab === 'settings') renderSettings();
    if (ui.tab === 'active') renderModifications();
}
function typeChanged(resetTarget = false) {
    const type = $('#wm-edit-type').value;
    const ctx = current();
    const target = $('#wm-edit-target');
    target.readOnly = type === 'self';
    if (resetTarget || type === 'self') target.value = type === 'self' ? ctx?.name1 || '我' : type === 'world' ? '当前世界' : '';
    target.placeholder = type === 'cognition' ? '例如：林晚，或这个世界的所有人' : '填写人物名或修改对象';
    $('#wm-awareness-label').hidden = type === 'cognition';
    $('#wm-type-hint').textContent = type === 'cognition'
        ? '只改指定人物的想法与记忆；例如「坚信我是他的老师，并记得共同学习的经历」。'
        : '写下修改完成后的结果，不需要编写规则。';
}
function resetForm() {
    ui.controller?.abort();
    ui.controller = null;
    ui.editingId = '';
    $('#wm-edit-form').reset();
    $('#wm-cancel-edit').hidden = true;
    $('#wm-apply').textContent = '应用修改 ↗';
    $('#wm-ai-refine').disabled = !hasChat(current());
    status('#wm-edit-status', '');
    typeChanged(true);
}
function syncChat() {
    const ctx = current();
    if (!ctx) return;
    const key = getChatKey(ctx);
    if (key !== ui.chatKey) {
        ui.chatKey = key;
        resetForm();
    }
    refresh();
}
function refresh() {
    const ctx = current();
    if (!ctx || !ui.ready) return;
    const available = hasChat(ctx);
    const entries = available ? getModifications(ctx) : [];
    const count = entries.filter((item) => item.enabled).length;
    const enabled = getSettings(ctx).modifierInjectionEnabled !== false;
    $('#wm-count').textContent = String(count);
    $('#wm-apply').disabled = !available;
    $('#wm-ai-refine').disabled = !available || Boolean(ui.controller);
    $('#wm-current-status').textContent = !available ? '请先打开一个聊天' : !enabled ? '注入已暂停 · 修改仍然保存' : count ? String(count) + ' 项修改已启用 · 下一轮回复读取' : '当前聊天 · 等待你的第一个修改';
    $('#wm-panel').classList.toggle('wm-paused', !enabled || !available);
    if (available) applyInjection(ctx); else clearInjection(ctx);
    applyTheme();
    if (ui.tab === 'active') renderModifications();
}
function renderModifications() {
    const ctx = current();
    const list = $('#wm-modification-list');
    list.replaceChildren();
    const entries = hasChat(ctx) ? getModifications(ctx) : [];
    $('#wm-undo').disabled = !entries.some((item) => item.enabled);
    if (!entries.length) {
        const empty = element('div', 'wm-empty');
        empty.append(element('span', 'wm-empty-icon', '✦'), element('h3', '', '世界还保持原样'), element('p', '', '在「直接修改」中，写下你想要的第一个改变。'));
        list.append(empty);
    }
    [...entries].reverse().forEach((entry) => {
        const card = element('article', 'wm-modification' + (entry.enabled ? '' : ' wm-disabled'));
        const head = element('div', 'wm-modification-head');
        head.append(element('span', 'wm-tag', MODIFICATION_TYPES[entry.type] || '其他修改'), element('span', 'wm-entry-state', entry.enabled ? '已启用' : '已停用'));
        const actions = element('div', 'wm-entry-actions');
        const button = (label, handler) => {
            const node = element('button', 'wm-text-button', label);
            node.type = 'button'; node.addEventListener('click', handler); actions.append(node);
        };
        button('编辑', () => {
            ui.editingId = entry.id;
            $('#wm-edit-type').value = entry.type;
            $('#wm-edit-target').value = entry.target;
            $('#wm-edit-text').value = entry.text;
            $('#wm-edit-awareness').value = entry.awareness;
            typeChanged();
            $('#wm-cancel-edit').hidden = false;
            $('#wm-apply').textContent = '保存并应用修改 ↗';
            switchTab('edit'); $('#wm-edit-text').focus();
        });
        button(entry.enabled ? '停用' : '启用', () => { toggleModification(current(), entry.id); refresh(); });
        button('删除', () => { removeModification(current(), entry.id); if (ui.editingId === entry.id) resetForm(); refresh(); });
        card.append(head, element('h4', '', entry.type === 'self' ? ctx.name1 || '我' : entry.target), element('p', 'wm-entry-text', entry.text));
        card.append(element('p', 'wm-hint', entry.type === 'cognition' ? '仅修改指定对象的认知' : AWARENESS_MODES[entry.awareness]), actions);
        list.append(card);
    });
    $('#wm-injection-preview').textContent = buildInjectionSegments(ctx).modifications || '当前没有注入内容。';
}
function formInput() {
    return { type: $('#wm-edit-type').value, target: $('#wm-edit-target').value.trim(), text: $('#wm-edit-text').value.trim(), awareness: $('#wm-edit-awareness').value };
}
function applyForm(event) {
    event.preventDefault();
    const ctx = current();
    if (!hasChat(ctx)) return notify('请先打开一个聊天。', true);
    if (getChatKey(ctx) !== ui.chatKey) { syncChat(); return notify('聊天已切换，请在当前聊天重新填写。', true); }
    const input = formInput();
    if (!input.target && input.type !== 'self') return status('#wm-edit-status', '请填写要修改的人物或对象。', true);
    try {
        saveModification(ctx, input, ui.editingId);
        resetForm(); refresh();
        const paused = getSettings(ctx).modifierInjectionEnabled === false;
        status('#wm-edit-status', paused ? '修改已保存。请在设置中开启注入后生效。' : '已应用。继续聊天，下一轮回复会读取这个修改。');
        notify(paused ? '已保存，当前注入已暂停。' : '修改已应用到当前聊天。');
    } catch (error) { status('#wm-edit-status', error.message, true); }
}
async function refine() {
    const ctx = current();
    const input = formInput();
    if (!input.text) return status('#wm-edit-status', '先写一个想法，AI 才能帮你细化。', true);
    if (!input.target && input.type !== 'self') return status('#wm-edit-status', '请先填写修改对象。', true);
    const key = getChatKey(ctx), fingerprint = JSON.stringify(input);
    const controller = new AbortController(); ui.controller = controller;
    $('#wm-ai-refine').disabled = true;
    status('#wm-edit-status', 'AI 正在细化描述…你也可以随时直接应用。');
    try {
        const result = await callAnalyzer({ ...getSettings(ctx), usePreset: false }, ctx, {
            systemPrompt: '你是小说世界修改器的描述助手。将用户想法整理为简洁明确、已经实现的结果，不要改写成世界规则、任务或实现过程。保留用户意图、修改对象与认知范围，不增添无关能力或剧情。人物认知修改只改变指定对象的认知。只输出 JSON 对象，格式为 {"text":"细化后的修改描述"}。',
            payload: { ...input, user: ctx.name1 || '用户', recent_messages: buildRecentMessages(ctx, { contextSize: 4 }).map((m) => ({ ...m, text: m.text.slice(-4000) })) },
        }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (getChatKey(current()) !== key || JSON.stringify(formInput()) !== fingerprint) return status('#wm-edit-status', '输入或聊天已变化，已丢弃旧的 AI 结果。');
        if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('AI 没有返回描述，请重试或直接手动应用。');
        $('#wm-edit-text').value = result.text.trim().slice(0, 16000);
        status('#wm-edit-status', '描述已细化，还未应用。确认内容后点击「应用修改」。');
    } catch (error) {
        if (!controller.signal.aborted) status('#wm-edit-status', error.message, true);
    } finally {
        if (ui.controller === controller) ui.controller = null;
        $('#wm-ai-refine').disabled = !hasChat(current()) || Boolean(ui.controller);
    }
}

function syncApiFields() {
    const settings = getSettings();
    settings.apiMode = $('#wm-api-mode').value;
    settings.apiUrl = $('#wm-api-url').value.trim();
    settings.apiKey = $('#wm-api-key').value.trim();
    settings.model = $('#wm-api-model').value.trim();
    settings.apiTransport = $('#wm-api-transport').value;
    settings.apiTimeoutMs = Math.max(5, Math.min(1800, Number($('#wm-api-timeout').value) || 120)) * 1000;
    settings.temperature = Math.max(0, Math.min(2, Number($('#wm-api-temperature').value) || 0));
    saveSettings();
    return settings;
}
function renderSettings() {
    const settings = getSettings();
    if (!settings) return;
    value('#wm-api-mode', settings.apiMode);
    value('#wm-api-url', settings.apiUrl); value('#wm-api-key', settings.apiKey); value('#wm-api-model', settings.model);
    value('#wm-api-transport', settings.apiTransport);
    value('#wm-api-timeout', Math.round((settings.apiTimeoutMs || 120000) / 1000));
    value('#wm-api-temperature', settings.temperature);
    value('#wm-theme', settings.theme === 'light' ? 'light' : 'dark');
    $('#wm-injection-enabled').checked = settings.modifierInjectionEnabled !== false;
    $('#wm-custom-fields').hidden = settings.apiMode !== 'custom';
    $('#wm-main-hint').hidden = settings.apiMode === 'custom';
    const connection = resolveConnection({ ...settings, apiMode: 'main' }, current());
    $('#wm-main-hint').textContent = connection.apiUrl ? '复用酒馆主连接：' + connection.apiUrl + ' · ' + (connection.model || '当前模型') : '使用酒馆当前连接和模型。无需在插件中重复填写 Key。';
    const models = $('#wm-model-list'); models.replaceChildren(new Option('可选：从列表选择模型', ''));
    for (const model of settings.modelOptions || []) models.add(new Option(model, model, false, model === settings.model));
    const profiles = $('#wm-profile-select'), selected = profiles.value;
    profiles.replaceChildren(new Option('已保存的配置', ''));
    for (const profile of normalizeApiProfiles(settings.apiProfiles)) profiles.add(new Option(profile.name, profile.name, false, profile.name === selected));
}
async function testConnection() {
    const settings = { ...syncApiFields(), usePreset: false };
    const button = $('#wm-test-connection'); button.disabled = true;
    status('#wm-api-status', '正在发送测试请求…');
    try {
        const result = await callAnalyzer(settings, current(), {
            systemPrompt: 'This is a connection test. Reply with the JSON object {"ok":true} only.', payload: { test: true },
        });
        if (result.ok !== true) throw new Error('连接成功，但模型没有按要求返回 JSON。请检查所选模型。');
        status('#wm-api-status', '连接成功，模型可以正常返回 JSON。');
    } catch (error) { status('#wm-api-status', error.message, true); }
    finally { button.disabled = false; }
}
async function loadModels() {
    const settings = syncApiFields(), button = $('#wm-fetch-models'); button.disabled = true;
    const snapshot = JSON.stringify([settings.apiMode, settings.apiUrl, settings.apiKey]);
    status('#wm-api-status', '正在拉取模型…');
    try {
        const models = await fetchModelList({ ...settings }, current());
        const latest = getSettings();
        if (JSON.stringify([latest.apiMode, latest.apiUrl, latest.apiKey]) !== snapshot) return status('#wm-api-status', '连接配置已变化，已丢弃旧模型列表。');
        if (!models.length) throw new Error('服务没有返回模型列表。可以直接填写模型名，再点「测试连接」。');
        latest.modelOptions = models;
        if (!latest.model) latest.model = models[0];
        saveSettings(); renderSettings();
        status('#wm-api-status', '已拉取 ' + models.length + ' 个模型。可继续测试连接。');
    } catch (error) { status('#wm-api-status', error.message, true); }
    finally { button.disabled = false; }
}
function download(name, payload) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const anchor = element('a'); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function readFile(input, kind) {
    const file = input.files?.[0];
    if (!file) return;
    const ctx = current(), key = getChatKey(ctx);
    try {
        if (file.size > 20 * 1024 * 1024) throw new Error('文件超过 20MB，请先拆分备份。');
        const payload = parseImport(await file.text());
        if (kind === 'api') {
            importApiConfig(current(), payload); renderSettings(); status('#wm-api-status', 'API 配置已导入。请点「测试连接」验证。');
        } else {
            if (getChatKey(current()) !== key) throw new Error('聊天已切换，请在目标聊天重新导入。');
            importBackup(ctx, payload); resetForm(); renderSettings(); refresh(); notify('备份已恢复。');
        }
    } catch (error) {
        if (kind === 'api') status('#wm-api-status', error.message, true); else notify(error.message, true);
    } finally { input.value = ''; }
}
function bindEvents() {
    $('#wm-close').addEventListener('click', closePanel);
    document.querySelectorAll('#wm-panel [data-tab]').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
    $('#wm-edit-type').addEventListener('change', () => typeChanged(true));
    $('#wm-edit-form').addEventListener('submit', applyForm);
    $('#wm-edit-text').addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) $('#wm-edit-form').requestSubmit(); });
    $('#wm-cancel-edit').addEventListener('click', resetForm);
    $('#wm-ai-refine').addEventListener('click', refine);
    const examples = {
        god: { type: 'self', text: '我已经从普通人成为掌控时间与空间的神，能够自由使用这些力量。', target: '' },
        mind: { type: 'cognition', text: '坚信我是一直教导自己的老师，并拥有与我相识多年的清晰记忆。', target: '' },
        world: { type: 'world', text: '当前世界已经进入永夜，天空有两轮月亮，居民早已习惯这样的生活。', target: '当前世界' },
    };
    document.querySelectorAll('#wm-panel [data-example]').forEach((button) => button.addEventListener('click', () => {
        resetForm(); const example = examples[button.dataset.example];
        $('#wm-edit-type').value = example.type; $('#wm-edit-text').value = example.text; $('#wm-edit-target').value = example.target;
        typeChanged(); (example.type === 'cognition' ? $('#wm-edit-target') : $('#wm-edit-text')).focus();
    }));
    $('#wm-undo').addEventListener('click', () => { undoLastModification(current()); refresh(); notify('已停用最近一条修改。'); });
    $('#wm-injection-enabled').addEventListener('change', (event) => { getSettings().modifierInjectionEnabled = event.target.checked; saveSettings(); refresh(); });
    $('#wm-theme').addEventListener('change', (event) => { getSettings().theme = event.target.value; saveSettings(); applyTheme(); });
    for (const selector of ['#wm-api-mode', '#wm-api-url', '#wm-api-key', '#wm-api-model', '#wm-api-transport', '#wm-api-timeout', '#wm-api-temperature']) {
        $(selector).addEventListener('input', () => { syncApiFields(); if (selector === '#wm-api-mode') { $('#wm-custom-fields').hidden = $('#wm-api-mode').value !== 'custom'; $('#wm-main-hint').hidden = $('#wm-api-mode').value === 'custom'; } });
    }
    $('#wm-model-list').addEventListener('change', (event) => { if (event.target.value) { $('#wm-api-model').value = event.target.value; syncApiFields(); } });
    $('#wm-fetch-models').addEventListener('click', loadModels);
    $('#wm-test-connection').addEventListener('click', testConnection);
    $('#wm-api-import').addEventListener('click', () => $('#wm-api-file').click());
    $('#wm-api-file').addEventListener('change', (event) => readFile(event.target, 'api'));
    $('#wm-api-paste').addEventListener('click', () => {
        try { importApiConfig(current(), parseImport($('#wm-api-json').value)); $('#wm-api-json').value = ''; renderSettings(); status('#wm-api-status', 'API 配置已导入。请点「测试连接」验证。'); }
        catch (error) { status('#wm-api-status', error.message, true); }
    });
    $('#wm-profile-save').addEventListener('click', () => {
        try { const settings = syncApiFields(); saveApiProfile(settings, $('#wm-profile-name').value); saveSettings(); renderSettings(); notify('连接配置已保存。'); }
        catch (error) { status('#wm-api-status', error.message, true); }
    });
    $('#wm-profile-select').addEventListener('change', (event) => {
        if (!event.target.value) return;
        try { applyApiProfile(getSettings(), event.target.value); saveSettings(); $('#wm-profile-name').value = event.target.value; renderSettings(); status('#wm-api-status', '已切换配置，请测试连接。'); }
        catch (error) { status('#wm-api-status', error.message, true); }
    });
    $('#wm-profile-delete').addEventListener('click', () => {
        try { deleteApiProfile(getSettings(), $('#wm-profile-select').value); saveSettings(); renderSettings(); notify('连接配置已删除。'); }
        catch (error) { status('#wm-api-status', error.message, true); }
    });
    $('#wm-export').addEventListener('click', () => { syncApiFields(); download('world-modifier-backup-' + Date.now() + '.json', exportBackup(current(), $('#wm-backup-secrets').checked)); notify('备份已导出。'); });
    $('#wm-import').addEventListener('click', () => $('#wm-import-file').click());
    $('#wm-import-file').addEventListener('change', (event) => readFile(event.target, 'backup'));
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#wm-panel').hidden) closePanel(); });
    setupDrag($('#wm-floating-orb'), $('#wm-floating-orb'), true);
    setupDrag($('#wm-drag-handle'), $('#wm-panel'), false);
    window.addEventListener('resize', clampPositions);
}
function clampPositions() {
    for (const selector of ['#wm-floating-orb', '#wm-panel']) {
        const node = $(selector); if (!node || node.hidden || !node.style.left) continue;
        const bounds = node.getBoundingClientRect();
        node.style.left = Math.max(0, Math.min(bounds.left, window.innerWidth - bounds.width)) + 'px';
        node.style.top = Math.max(0, Math.min(bounds.top, window.innerHeight - Math.min(bounds.height, window.innerHeight))) + 'px';
    }
}
function setupDrag(handle, node, openOnClick) {
    let drag = null;
    handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.target.closest('button') && !openOnClick) return;
        const rect = node.getBoundingClientRect();
        drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
        handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', (event) => {
        if (!drag) return;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) < 6 && !drag.moved) return;
        drag.moved = true; node.style.right = 'auto'; node.style.bottom = 'auto';
        node.style.left = Math.max(0, Math.min(window.innerWidth - node.offsetWidth, drag.left + dx)) + 'px';
        node.style.top = Math.max(0, Math.min(window.innerHeight - Math.min(node.offsetHeight, window.innerHeight), drag.top + dy)) + 'px';
    });
    handle.addEventListener('pointerup', () => {
        if (!drag) return;
        if (openOnClick && !drag.moved) togglePanel();
        drag = null;
    });
    handle.addEventListener('pointercancel', () => { drag = null; });
    if (openOnClick) handle.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); togglePanel(); } });
}
function openPanel() { $('#wm-panel').hidden = false; syncChat(); clampPositions(); }
function closePanel() { $('#wm-panel').hidden = true; $('#wm-floating-orb').focus(); }
function togglePanel() { if ($('#wm-panel').hidden) openPanel(); else closePanel(); }
function ensureMenu() {
    const menu = $('#extensionsMenu');
    if (!menu) return false;
    if (!$('#wm-menu-item')) {
        const button = element('div', 'list-group-item flex-container flexGap5 interactable', '✦ 世界修改器');
        button.id = 'wm-menu-item'; button.tabIndex = 0; button.setAttribute('role', 'button');
        button.addEventListener('click', openPanel);
        button.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') openPanel(); });
        menu.append(button);
    }
    return true;
}
export async function init() {
    const ctx = current(); if (!ctx) return false;
    if (!ui.ready) {
        const response = await fetch(TEMPLATE_URL);
        if (!response.ok) throw new Error('无法加载世界修改器面板：HTTP ' + response.status);
        const holder = element('div'); holder.innerHTML = await response.text();
        document.body.append(...holder.childNodes);
        ui.ready = true;
        // Retire the old automatic tracker; manual world edits require no requests.
        clearInterval(globalThis.__world_modulator_poll__); globalThis.__world_modulator_poll__ = null;
        bindEvents(); renderSettings(); syncChat();
        const on = (name, callback) => { if (ctx.eventTypes?.[name]) ctx.eventSource?.on?.(ctx.eventTypes[name], callback); };
        on('CHAT_CHANGED', syncChat);
        on('GENERATION_STARTED', () => { const latest = current(); if (latest) applyInjection(latest); });
        // Also supports hosts that do not emit CHAT_CHANGED for every switch.
        setInterval(() => { if (current() && getChatKey(current()) !== ui.chatKey) syncChat(); }, 1000);
    }
    return ensureMenu();
}
if (typeof document !== 'undefined') {
    const boot = async (remaining = 60) => {
        let done = false;
        try { done = await init(); } catch (error) { console.error('[World Modifier]', error); }
        if (!done && remaining > 0) setTimeout(() => boot(remaining - 1), 500);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => boot(), { once: true }); else void boot();
}
globalThis.__worldModifier__ = globalThis.__worldModulator__ = {
    init, open: openPanel, close: closePanel, toggle: togglePanel,
    getSettings, getDebugInfo, applyInjection: () => applyInjection(current()),
};
