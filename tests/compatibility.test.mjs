import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getSettings } from '../scripts/state.js';
import { importApiConfig } from '../scripts/backup.js';
import { buildProxyConnection, callAnalyzer } from '../scripts/api.js';
import { saveModification, toggleModification, getModifications } from '../scripts/modifier.js';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const context = () => ({ extensionSettings: {}, getCurrentChatId: () => 'A', saveSettingsDebounced() {} });
test('saving an edited disabled modification applies and enables it again', () => {
    const ctx = context(), entry = saveModification(ctx, { text: 'old' });
    toggleModification(ctx, entry.id);
    saveModification(ctx, { text: 'new' }, entry.id);
    assert.equal(getModifications(ctx)[0].enabled, true);
});
function settings(ctx) { return Object.assign(getSettings(ctx), { apiMode: 'custom', apiUrl: 'https://old.example/v1', apiKey: 'old-test-key', model: 'test' }); }

test('changing an API address without a key clears the previous endpoints key', () => {
    const ctx = context(); settings(ctx);
    importApiConfig(ctx, { apiUrl: 'https://new.example/v1', model: 'new-model' });
    assert.equal(getSettings(ctx).apiKey, '');
});
test('independent keyless endpoints do not inherit the host custom key', () => {
    const fields = buildProxyConnection({ source: 'custom', apiUrl: 'http://localhost:1234/v1', apiKey: '' });
    assert.equal(JSON.parse(fields.custom_include_headers).Authorization, '');
});
test('wrongly typed API import leaves the live configuration unchanged', () => {
    const ctx = context(); settings(ctx);
    assert.throws(() => importApiConfig(ctx, { apiUrl: ['invalid'] }));
    assert.equal(getSettings(ctx).apiUrl, 'https://old.example/v1');
});
test('JSON correction recovers when a compatible model first returns an array', async () => {
    const ctx = context(); let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: calls === 1 ? '[]' : '{"ok":true}' } }] })); };
    assert.deepEqual(await callAnalyzer(settings(ctx), ctx, { systemPrompt: 'JSON', payload: {} }), { ok: true });
    assert.equal(calls, 2);
});
