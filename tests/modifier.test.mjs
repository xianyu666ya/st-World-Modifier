import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getSettings, getChatData, saveApiProfile, applyApiProfile } from '../scripts/state.js';
import { saveModification, getModifications, toggleModification, removeModification, undoLastModification, renderModifications } from '../scripts/modifier.js';
import { applyInjection, buildInjectionSegments } from '../scripts/inject.js';
import { callAnalyzer, fetchModelList, normalizeBase, buildProxyConnection, resolveConnection } from '../scripts/api.js';
import { exportBackup, importBackup, importApiConfig, parseImport } from '../scripts/backup.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; delete globalThis.location; delete globalThis.SillyTavern; });
function context() {
    let key = 'chat-A';
    const prompts = new Map();
    return { name1: '主角', characterId: 0, chat: [], extensionSettings: {}, prompts,
        getCurrentChatId: () => key, switchChat: (next) => { key = next; },
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'host-test-csrf' }),
        saveSettingsDebounced() {}, setExtensionPrompt: (id, text, ...args) => prompts.set(id, { text, args }) };
}
function apiSettings(ctx) {
    Object.assign(getSettings(ctx), { apiMode: 'custom', apiUrl: 'https://independent.example/v1', apiKey: 'independent-test-key', model: 'example-model' });
    globalThis.location = { origin: 'http://localhost:8000', href: 'http://localhost:8000/' };
    return getSettings(ctx);
}
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const completion = (data) => response({ choices: [{ message: { content: JSON.stringify(data) } }] });
const params = { systemPrompt: 'Return a JSON object.', payload: { test: true } };

test('direct self modification works without API and injects named user at chat depth zero', () => {
    const ctx = context();
    saveModification(ctx, { type: 'self', target: '我', text: '我已经成为神。' });
    const outcome = applyInjection(ctx);
    assert.equal(outcome.available, true); assert.equal(outcome.injected.length, 1);
    const prompt = [...ctx.prompts.values()].find((p) => p.text.includes('成为神'));
    assert.match(prompt.text, /对象：主角/); assert.deepEqual(prompt.args, [1, 0, false, 0]);
});
test('cognition is limited to selected targets and is not a physical fact', () => {
    const text = renderModifications([{ enabled: true, type: 'cognition', target: '林晚', text: '认为我是老师。', awareness: 'natural' }]);
    assert.match(text, /对象：林晚/); assert.match(text, /不改变其他人物认知/); assert.match(text, /不将其信念自动变为客观事实/);
});
test('editing moves a modification to the end for deterministic priority', () => {
    const ctx = context(); const a = saveModification(ctx, { text: 'first' });
    saveModification(ctx, { text: 'second' }); saveModification(ctx, { text: 'edited' }, a.id);
    assert.deepEqual(getModifications(ctx).map((m) => m.text), ['second', 'edited']);
});
test('toggle, undo and delete immediately change the injected content', () => {
    const ctx = context(), a = saveModification(ctx, { text: 'become god' }), b = saveModification(ctx, { text: 'night' });
    undoLastModification(ctx); assert.doesNotMatch(buildInjectionSegments(ctx).modifications, /结果：night/);
    toggleModification(ctx, a.id); assert.deepEqual(buildInjectionSegments(ctx), {});
    toggleModification(ctx, b.id); removeModification(ctx, b.id); assert.deepEqual(buildInjectionSegments(ctx), {});
});
test('switching chats never injects modifications from the previous chat', () => {
    const ctx = context(); saveModification(ctx, { text: 'chat A secret' }); applyInjection(ctx);
    ctx.switchChat('chat-B'); applyInjection(ctx);
    assert.deepEqual(getModifications(ctx), []); assert.equal([...ctx.prompts.values()].some((p) => p.text.includes('chat A secret')), false);
    ctx.switchChat('chat-A'); assert.equal(getModifications(ctx).length, 1);
});
test('pause clears injection but keeps data; resume restores it', () => {
    const ctx = context(); saveModification(ctx, { text: 'stay saved' }); applyInjection(ctx);
    getSettings(ctx).modifierInjectionEnabled = false; applyInjection(ctx);
    assert.equal([...ctx.prompts.values()].every((p) => !p.text), true);
    getSettings(ctx).modifierInjectionEnabled = true; assert.equal(applyInjection(ctx).injected.length, 1);
});
test('legacy rules migrate once, including their disabled state', () => {
    const ctx = context(), data = getChatData(ctx);
    data.rules = { old: { description: 'legacy change', enabled: true }, retired: { description: 'removed' } }; data.retiredRules = { retired: {} };
    assert.equal(getModifications(ctx).length, 2); assert.equal(getModifications(ctx).length, 2);
    assert.equal(getModifications(ctx).find((m) => m.target === 'retired').enabled, false);
});
test('new backup restores every chat, current API key and connection options', () => {
    const ctx = context(); apiSettings(ctx); getSettings(ctx).apiTimeoutMs = 45000; getSettings(ctx).apiTransport = 'proxy';
    saveModification(ctx, { text: 'A' }); ctx.switchChat('chat-B'); saveModification(ctx, { text: 'B' }); saveApiProfile(getSettings(ctx), 'personal');
    const backup = exportBackup(ctx, true), other = context(); importBackup(other, backup);
    assert.equal(getSettings(other).apiKey, 'independent-test-key'); assert.equal(getSettings(other).apiTimeoutMs, 45000);
    assert.equal(Object.keys(getSettings(other).chatData).length, 2); applyApiProfile(getSettings(other), 'personal'); assert.equal(getSettings(other).apiTransport, 'proxy');
});
test('backup without secrets omits keys and does not erase existing keys on restore', () => {
    const ctx = context(); apiSettings(ctx); saveApiProfile(getSettings(ctx), 'personal');
    const backup = exportBackup(ctx); assert.equal(JSON.stringify(backup).includes('independent-test-key'), false);
    importBackup(ctx, backup); assert.equal(getSettings(ctx).apiKey, 'independent-test-key'); assert.equal(getSettings(ctx).apiProfiles[0].apiKey, 'independent-test-key');
});
test('v1 backup restores into current chat and preserves missing current API key', () => {
    const ctx = context(); apiSettings(ctx);
    importBackup(ctx, { exportedBy: 'World Modulator', settings: { apiMode: 'custom', model: 'restored' }, chatData: { rules: { legacy: { description: 'old' } } } });
    assert.equal(getSettings(ctx).apiKey, 'independent-test-key'); assert.equal(getModifications(ctx)[0].text, 'old');
});
test('API import understands common aliases and chooses independent mode', () => {
    const ctx = context(); importApiConfig(ctx, { base_url: 'https://other.example/v1/chat/completions', api_key: ' new-key ', model: 'new-model' });
    assert.equal(getSettings(ctx).apiMode, 'custom'); assert.equal(getSettings(ctx).apiUrl, 'https://other.example/v1'); assert.equal(getSettings(ctx).apiKey, 'new-key');
});
test('imported profiles missing apiMode infer custom mode from their URL', () => {
    const ctx = context(); importApiConfig(ctx, { apiProfiles: [{ name: 'imported', apiUrl: 'https://api.example/v1', apiKey: 'key', model: 'model' }] });
    assert.equal(getSettings(ctx).apiMode, 'custom'); assert.equal(resolveConnection(getSettings(ctx), ctx).apiKey, 'key');
});
test('import validation rejects prototype keys and non-backup JSON', () => {
    assert.throws(() => parseImport('{"__proto__":{"polluted":true}}'));
    assert.throws(() => importBackup(context(), { random: true }));
    assert.throws(() => importApiConfig(context(), {}));
});
test('normalizes root addresses, full endpoints and local addresses', () => {
    assert.equal(normalizeBase('https://api.example/'), 'https://api.example/v1');
    assert.equal(normalizeBase('https://api.example/v1/chat/completions/'), 'https://api.example/v1');
    assert.equal(normalizeBase('localhost:1234/v1'), 'http://localhost:1234/v1');
    assert.equal(normalizeBase('api.example/v1'), 'https://api.example/v1');
});
test('proxy auth is valid YAML/JSON and uses the independent key', () => {
    const fields = buildProxyConnection({ apiUrl: 'https://api.example/v1', apiKey: 'test:key#punctuation' });
    assert.deepEqual(JSON.parse(fields.custom_include_headers), { Authorization: 'Bearer test:key#punctuation' });
});
test('model discovery sends independent authorization and real host CSRF headers', async () => {
    const ctx = context(), settings = apiSettings(ctx);
    globalThis.fetch = async (url, options) => {
        assert.equal(url, '/api/backends/chat-completions/status');
        assert.equal(options.headers['X-CSRF-Token'], 'host-test-csrf');
        assert.equal(JSON.parse(JSON.parse(options.body).custom_include_headers).Authorization, 'Bearer independent-test-key');
        return response({ data: [{ id: 'z' }, { id: 'a' }] });
    };
    assert.deepEqual(await fetchModelList(settings, ctx), ['a', 'z']);
});
test('independent generation sends its own key and avoids forcing JSON mode', async () => {
    const ctx = context(), settings = apiSettings(ctx);
    globalThis.fetch = async (url, options) => {
        assert.equal(url, '/api/backends/chat-completions/generate'); const body = JSON.parse(options.body);
        assert.equal(JSON.parse(body.custom_include_headers).Authorization, 'Bearer independent-test-key');
        assert.equal(body.response_format, undefined); assert.equal(body.model, 'example-model'); return completion({ ok: true });
    };
    assert.deepEqual(await callAnalyzer(settings, ctx, params), { ok: true });
});
test('bad key is surfaced and does not disable proxy for the next request', async () => {
    const ctx = context(), settings = apiSettings(ctx); let calls = 0;
    globalThis.fetch = async (url) => { calls++; assert.equal(url, '/api/backends/chat-completions/generate'); return calls === 1 ? response({ error: { message: 'invalid api key' } }, 401) : completion({ ok: true }); };
    await assert.rejects(callAnalyzer(settings, ctx, params), /401/);
    assert.deepEqual(await callAnalyzer(settings, ctx, params), { ok: true }); assert.equal(calls, 2);
});
test('CSRF failure keeps the actual error instead of falling back to CORS', async () => {
    const ctx = context(), settings = apiSettings(ctx); let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('Invalid CSRF token', { status: 403 }); };
    await assert.rejects(callAnalyzer(settings, ctx, params), /CSRF/); assert.equal(calls, 1);
});
test('direct mode bypasses host and sends the independent bearer key', async () => {
    const ctx = context(), settings = apiSettings(ctx); settings.apiTransport = 'direct';
    globalThis.fetch = async (url, options) => { assert.equal(url, 'https://independent.example/v1/chat/completions'); assert.equal(options.headers.Authorization, 'Bearer independent-test-key'); return completion({ ok: true }); };
    assert.deepEqual(await callAnalyzer(settings, ctx, params), { ok: true });
});
test('200 with an upstream model-list error is not reported as connected', async () => {
    const ctx = context(), settings = apiSettings(ctx); globalThis.fetch = async () => response({ error: true, data: { data: [] } });
    await assert.rejects(fetchModelList(settings, ctx), /模型列表返回错误/);
});
test('unsupported model listing does not prevent a completion test', async () => {
    const ctx = context(), settings = apiSettings(ctx);
    globalThis.fetch = async (url) => url.endsWith('/status') ? response({ error: 'not supported' }, 404) : completion({ ok: true });
    await assert.rejects(fetchModelList(settings, ctx), /404/); assert.deepEqual(await callAnalyzer(settings, ctx, params), { ok: true });
});
test('main native connection can use host generateRaw without copying keys', async () => {
    const ctx = context(); ctx.generateRaw = async (request) => { assert.match(request.systemPrompt, /JSON/); return '{"ok":true}'; };
    assert.deepEqual(await callAnalyzer(getSettings(ctx), ctx, params), { ok: true });
});
test('cancelling AI aborts the active network request', async () => {
    const ctx = context(), settings = apiSettings(ctx), controller = new AbortController();
    globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    const pending = callAnalyzer(settings, ctx, params, { signal: controller.signal }); controller.abort();
    await assert.rejects(pending, /aborted|无法连接/);
});
