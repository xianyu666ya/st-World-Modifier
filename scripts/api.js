/**
 * World Modulator —— API 调用层（2026-10-23 二改：独立鉴权、CSRF、连接诊断）
 *
 * 两种模式：
 *   'main'   —— 复用酒馆主模型的连接配置（oai_settings），但独立发起请求
 *   'custom' —— 使用插件自己填写的 Base URL / Key / 模型
 *
 * 传输策略（与 BS BioTracker 一致，逐级降级）：
 *   1) 宿主代理 /api/backends/chat-completions/generate（由酒馆转发，避开 CORS）
 *   2) 浏览器直连（CORS 允许时）
 *
 * 输出要求为 JSON，失败时自动追问一次纠错。
 */

import { MODULE_NAME } from './prompts.js';

const DEBUG_LAST_REQUEST_KEY = `__${MODULE_NAME}_debug_last_request__`;
const DEBUG_LAST_RESPONSE_KEY = `__${MODULE_NAME}_debug_last_response__`;

export const DEFAULT_TIMEOUT_MS = 120000;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 1800000;
const MAX_RETRIES = 2;

// ─────────────────────────────────────────────
// JSON 提取
// ─────────────────────────────────────────────

/**
 * 从模型输出中尽力提取 JSON 对象。
 * 依次尝试：直接解析 → ```json 围栏 → 首个 { 到末个 }。
 */
export function extractJson(text) {
    if (!text) return null;
    const raw = String(text).trim();
    try {
        return JSON.parse(raw);
    } catch { /* 继续 */ }

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
        try {
            return JSON.parse(fenced[1].trim());
        } catch { /* 继续 */ }
    }

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            return JSON.parse(raw.slice(start, end + 1));
        } catch { /* 继续 */ }
    }
    return null;
}

// ─────────────────────────────────────────────
// 连接配置解析
// ─────────────────────────────────────────────

/**
 * 解析出本次请求实际使用的连接参数。
 * @param {object} settings 插件设置
 * @param {object} ctx 宿主 context
 * @returns {{apiUrl:string, apiKey:string, model:string, source:'main'|'custom'}}
 */
export function resolveConnection(settings, ctx) {
    const mode = settings?.apiMode === 'custom' ? 'custom' : 'main';

    if (mode === 'main') {
        const oai = ctx?.chatCompletionSettings || null;
        // 主模型走的是「自定义(兼容)」通道时，配置在那里
        const apiUrl = normalizeBase(
            oai?.custom_url
            || oai?.reverse_proxy
            || '',
        );
        const apiKey = String(oai?.proxy_password || oai?.custom_api_key || '');
        const model = String(oai?.custom_model || oai?.openai_model || oai?.model || '');
        return { apiUrl, apiKey: apiKey.trim(), model: model.trim(), source: 'main', transport: settings?.apiTransport || 'auto', includeHeaders: oai?.custom_include_headers || '' };
    }

    return {
        apiUrl: normalizeBase(settings?.apiUrl || ''),
        apiKey: String(settings?.apiKey || '').trim(),
        model: String(settings?.model || '').trim(),
        source: 'custom',
        transport: settings?.apiTransport || 'auto',
    };
}

/** 归一化 Base URL：去掉尾部斜杠与常见端点后缀 */
export function normalizeBase(url) {
    let base = String(url || '').trim().replace(/\/+$/, '');
    if (!base) return '';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(base) && !/^https?:\/\//i.test(base)) throw new Error('API 地址仅支持 http:// 或 https://。');
    if (!/^https?:\/\//i.test(base) && !base.startsWith('/')) {
        const host = base.split(/[/:]/)[0];
        base = `${isLocalHost(host) ? 'http' : 'https'}://${base}`;
    }
    base = base.replace(/\/(chat\/completions|completions|models|responses|messages)$/i, '');
    try {
        const parsed = new URL(base);
        if (parsed.pathname === '/') base = `${parsed.origin}/v1`;
    } catch { /* Relative bases are resolved by the browser. */ }
    return base.replace(/\/+$/, '');
}

/** 主模型连接是否可用（用于界面提示） */
export function isMainConnectionAvailable(ctx) {
    if (typeof ctx?.generateRaw === 'function') return true;
    const oai = ctx?.chatCompletionSettings;
    if (!oai) return false;
    const url = oai.custom_url || oai.reverse_proxy;
    return Boolean(String(url || '').trim());
}

// ─────────────────────────────────────────────
// 安全校验
// ─────────────────────────────────────────────

function isLocalHost(host) {
    const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
    if (h === '::1' || h === '::') return true;
    if (h.includes(':')) {
        const head = h.split(':')[0];
        return /^fe[89ab]/.test(head) || /^f[cd]/.test(head);
    }
    const parts = h.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts;
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
}

/**
 * 校验直连地址：http 仅允许本机/内网，避免 API Key 明文外传。
 * 无 scheme 的相对路径放行，交给浏览器解析。
 */
export function assertSafeUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return;
    if (!/^https?:/i.test(raw)) {
        const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i);
        if (scheme && !/^\d+$/.test(raw.slice(scheme[0].length))) {
            throw new Error('API 地址仅支持 http:// 或 https://。');
        }
        return;
    }
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('API 地址无法解析。');
    }
    if (parsed.protocol !== 'http:') return;
    if (!isLocalHost(parsed.hostname)) {
        throw new Error('使用 http:// 时仅允许本机或内网地址；公网地址请改用 https://。');
    }
}

/** 错误文本脱敏，避免 Key 泄漏到界面 */
export function sanitizeErrorText(text) {
    return String(text || '')
        .replace(/("?(?:authorization|api[-_]?key|proxy[-_]?password|token)"?\s*[:=]\s*")[^"]{4,}(")/gi, '$1***$2')
        .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, '$1***')
        .slice(0, 400);
}

function resolveTimeout(settings) {
    const raw = Number(settings?.apiTimeoutMs);
    if (!Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
    if (raw <= 0) return 0;
    return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(raw)));
}

// ─────────────────────────────────────────────
// 请求头
// ─────────────────────────────────────────────

function buildAuthHeaders(connection) {
    const headers = { 'Content-Type': 'application/json' };
    if (connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;
    return headers;
}

/** 宿主代理请求头：带上 CSRF token 等 */
function buildProxyHeaders(ctx) {
    const headers = { 'Content-Type': 'application/json' };
    try {
        const hostHeaders = ctx?.getRequestHeaders?.()
            || globalThis.SillyTavern?.getContext?.()?.getRequestHeaders?.()
            || globalThis.SillyTavern?.getRequestHeaders?.() || null;
        if (hostHeaders && typeof hostHeaders === 'object') {
            for (const [key, value] of Object.entries(hostHeaders)) {
                if (value !== null && value !== undefined && value !== '') headers[key] = String(value);
            }
        }
    } catch { /* ignore */ }
    try {
        const token = document?.cookie?.match(/(?:^|;\s*)csrf_token=([^;]+)/)?.[1];
        if (token && !headers['X-CSRF-Token']) headers['X-CSRF-Token'] = decodeURIComponent(token);
    } catch { /* ignore */ }
    return headers;
}

function isCrossOrigin(url) {
    try {
        if (typeof location === 'undefined' || !location?.origin) return false;
        return new URL(url, location.href).origin !== location.origin;
    } catch {
        return false;
    }
}

function shouldUseProxy(url, transport = 'auto') {
    if (transport === 'proxy') return true;
    if (transport === 'direct') return false;
    return isCrossOrigin(url);
}

function shouldFallbackFromProxy(status, text) {
    return status === 405 || status === 501
        || status === 404 && /cannot\s+post|no\s+route|<!doctype|<html/i.test(String(text || ''));
}

/** JSON is valid YAML; quoting also handles punctuation in API keys correctly. */
export function buildProxyConnection(connection) {
    return {
        chat_completion_source: 'custom', custom_url: connection.apiUrl,
        reverse_proxy: connection.apiUrl, proxy_password: connection.apiKey,
        custom_include_headers: connection.source === 'custom' || connection.apiKey
            ? JSON.stringify({ Authorization: connection.apiKey ? `Bearer ${connection.apiKey}` : '' })
            : connection.includeHeaders || '',
    };
}

// ─────────────────────────────────────────────
// 传输
// ─────────────────────────────────────────────

async function fetchWithTimeout(url, options, timeoutMs) {
    const { signal: externalSignal, ...rest } = options;
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    let timedOut = false;
    const onExternalAbort = () => controller?.abort();
    if (controller) {
        rest.signal = controller.signal;
        if (limit > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                try { controller.abort(); } catch { /* ignore */ }
            }, limit);
        }
        if (externalSignal) {
            if (externalSignal.aborted) {
                try { controller.abort(); } catch { /* ignore */ }
            } else {
                externalSignal.addEventListener('abort', onExternalAbort, { once: true });
            }
        }
    }
    try {
        const response = await fetch(url, rest);
        const text = await response.text();
        return { response, text };
    } catch (error) {
        if (timedOut) throw new Error(`请求超过 ${Math.round(limit / 1000)} 秒未响应，已终止。`);
        throw error;
    } finally {
        if (timer) clearTimeout(timer);
        externalSignal?.removeEventListener('abort', onExternalAbort);
    }
}

/**
 * 通过宿主代理发起请求。
 * @returns {Promise<{response:Response, text:string}>}
 */
async function postViaProxy(connection, body, timeoutMs, ctx, signal) {
    const proxyBody = {
        ...buildProxyConnection(connection),
        messages: body.messages,
        model: body.model,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        response_format: body.response_format,
        custom_include_body: body.response_format ? JSON.stringify({ response_format: body.response_format }) : undefined,
        stream: false,
    };
    for (const key of Object.keys(proxyBody)) {
        if (proxyBody[key] === undefined || proxyBody[key] === '') delete proxyBody[key];
    }
    return fetchWithTimeout(
        '/api/backends/chat-completions/generate',
        {
            method: 'POST',
            headers: buildProxyHeaders(ctx),
            body: JSON.stringify(proxyBody),
            cache: 'no-cache',
            credentials: 'same-origin', signal,
        },
        timeoutMs,
    );
}

/** 直接向 API 发起请求 */
async function postDirect(connection, body, timeoutMs, signal) {
    const url = `${connection.apiUrl}/chat/completions`;
    assertSafeUrl(connection.apiUrl);
    return fetchWithTimeout(
        url,
        {
            method: 'POST',
            headers: buildAuthHeaders(connection),
            body: JSON.stringify(body),
            cache: 'no-cache',
            signal,
        },
        timeoutMs,
    );
}

/**
 * 发起一次 chat/completions 请求，自动选择代理或直连。
 * @returns {Promise<string>} 模型返回的文本
 */
async function postChat(connection, body, timeoutMs, ctx, signal) {
    if (!connection.apiUrl) throw new Error('尚未配置 API 地址。');
    if (!connection.model) throw new Error('尚未配置模型名称。');

    let result = null;
    let proxyError = null;

    if (shouldUseProxy(connection.apiUrl, connection.transport)) {
        try {
            result = await postViaProxy(connection, body, timeoutMs, ctx, signal);
            if (connection.transport !== 'proxy' && !result.response.ok && shouldFallbackFromProxy(result.response.status, result.text)) {
                result = null;
            }
        } catch (error) {
            if (signal?.aborted || connection.transport === 'proxy' || /超过.*秒/.test(error.message)) throw error;
            proxyError = error;
            result = null;
        }
    }

    if (!result) {
        try {
            result = await postDirect(connection, body, timeoutMs, signal);
        } catch (error) {
            if (proxyError) {
                console.warn(`[${MODULE_NAME}] 代理与直连均失败`, proxyError, error);
            }
            throw new Error(`无法连接到 API。请检查地址、密钥与服务状态。原始错误: ${sanitizeErrorText(error?.message || error)}`);
        }
    }

    if (!result.response.ok) {
        const detail = /csrf/i.test(result.text)
            ? '酒馆登录状态或 CSRF 校验失效，请刷新酒馆页面后重试。'
            : sanitizeErrorText(result.text);
        throw new Error(`API ${result.response.status}: ${detail}`);
    }

    let parsed;
    try {
        parsed = JSON.parse(result.text);
    } catch {
        throw new Error(`API 返回的不是 JSON: ${sanitizeErrorText(result.text).slice(0, 200)}`);
    }

    if (parsed?.error) throw new Error(`API 返回错误：${sanitizeErrorText(parsed.error?.message || JSON.stringify(parsed.error))}`);
    const rawContent = parsed?.choices?.[0]?.message?.content
        || parsed?.choices?.[0]?.text
        || parsed?.content?.[0]?.text
        || '';
    const content = Array.isArray(rawContent) ? rawContent.map((part) => typeof part === 'string' ? part : part?.text || '').join('\n') : rawContent;
    if (!String(content).trim()) {
        throw new Error('模型返回了空内容。');
    }
    return String(content);
}

// ─────────────────────────────────────────────
// 上层调用
// ─────────────────────────────────────────────

function isNonRetriable(error) {
    const message = String(error?.message || '');
    return /尚未配置|无法解析|仅允许|400|401|403|404|405|csrf|Unauthorized|invalid.?api.?key|Incorrect API key|超过.*秒未响应/i.test(message);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 调用分析模型，返回解析后的 JSON 对象。
 *
 * @param {object} settings 插件设置
 * @param {object} ctx 宿主 context
 * @param {{systemPrompt:string, payload:object}} params
 * @param {{signal?:AbortSignal}} options
 * @returns {Promise<object>}
 */
export async function callAnalyzer(settings, ctx, { systemPrompt, payload }, options = {}) {
    const connection = resolveConnection(settings, ctx);
    const timeoutMs = resolveTimeout(settings);
    const messages = [];

    // 套用预设：预设条目排在前面，插件自己的系统提示词与载荷始终追加在后面
    if (settings?.usePreset === true && String(settings?.presetName || '').trim()) {
        const presetMessages = buildPresetMessages(
            ctx,
            settings.presetName,
            settings.presetPromptOverrides?.[String(settings.presetName).trim()] || {},
            settings.presetApiId || 'openai',
        );
        messages.push(...presetMessages);
    }

    messages.push(
        { role: 'system', content: String(systemPrompt || '') },
        { role: 'user', content: JSON.stringify(payload ?? {}, null, 2) },
    );

    const body = {
        model: connection.model,
        messages,
        temperature: Number.isFinite(Number(settings?.temperature)) ? Number(settings.temperature) : 0.3,
        ...(settings?.strictJson === true ? { response_format: { type: 'json_object' } } : {}),
    };
    const requestContent = (requestBody) => connection.source === 'main' && typeof ctx?.generateRaw === 'function'
        ? ctx.generateRaw({
            systemPrompt: String(systemPrompt || ''),
            prompt: requestBody.messages.filter((message) => message.role !== 'system').map((message) => message.content).join('\n'),
        })
        : postChat(connection, requestBody, timeoutMs, ctx, options.signal);

    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        if (options.signal?.aborted) throw new Error('请求已取消。');
        try {
            const content = await requestContent(body);
            const parsed = extractJson(content);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                globalThis[DEBUG_LAST_RESPONSE_KEY] = { at: Date.now(), ok: true, content, parsed };
                return parsed;
            }

            // JSON 纠错：把模型的原答复回填，要求重发
            const retryBody = {
                ...body,
                temperature: 0.1,
                messages: [
                    ...messages,
                    { role: 'assistant', content },
                    {
                        role: 'user',
                        content: '你上一条回复不是合法 JSON。请只输出一个可直接 JSON.parse 的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。',
                    },
                ],
            };
            const retryContent = await requestContent(retryBody);
            const retryParsed = extractJson(retryContent);
            if (retryParsed && typeof retryParsed === 'object' && !Array.isArray(retryParsed)) {
                globalThis[DEBUG_LAST_RESPONSE_KEY] = { at: Date.now(), ok: true, content: retryContent, parsed: retryParsed, retried: true };
                return retryParsed;
            }

            throw new Error(`模型没有返回可解析的 JSON。原始回复: ${String(content).slice(0, 300)}`);
        } catch (error) {
            lastError = error;
            if (options.signal?.aborted) throw error;
            if (isNonRetriable(error) || attempt >= MAX_RETRIES) break;
            const delay = 1000 * (attempt + 1);
            console.warn(`[${MODULE_NAME}] 分析请求第 ${attempt + 1}/${MAX_RETRIES + 1} 次失败，${delay}ms 后重试`, error);
            await sleep(delay);
        }
    }
    globalThis[DEBUG_LAST_RESPONSE_KEY] = { at: Date.now(), ok: false, error: String(lastError?.message || lastError) };
    throw lastError || new Error('分析请求失败。');
}

/**
 * 拉取模型列表（用于界面下拉）。
 * @returns {Promise<string[]>}
 */
export async function fetchModelList(settings, ctx) {
    const connection = resolveConnection(settings, ctx);
    if (!connection.apiUrl) throw new Error('请先填写 API 地址。');
    assertSafeUrl(connection.apiUrl);

    const url = `${connection.apiUrl}/models`;
    const timeoutMs = Math.min(resolveTimeout(settings) || DEFAULT_TIMEOUT_MS, 30000);

    let result = null;
    if (shouldUseProxy(connection.apiUrl, connection.transport)) {
        try {
            result = await fetchWithTimeout(
                '/api/backends/chat-completions/status',
                {
                    method: 'POST',
                    headers: buildProxyHeaders(ctx),
                    body: JSON.stringify({
                        ...buildProxyConnection(connection),
                    }),
                    credentials: 'same-origin',
                },
                timeoutMs,
            );
            if (!result.response.ok && connection.transport !== 'proxy' && shouldFallbackFromProxy(result.response.status, result.text)) result = null;
        } catch (error) {
            if (connection.transport === 'proxy') throw error;
            result = null;
        }
    }
    if (!result) {
        result = await fetchWithTimeout(url, { method: 'GET', headers: buildAuthHeaders(connection) }, timeoutMs);
    }
    if (!result.response.ok) throw new Error(`模型列表请求失败 ${result.response.status}：${sanitizeErrorText(result.text)}`);

    let data;
    try {
        data = JSON.parse(result.text);
    } catch {
        throw new Error('模型列表响应不是 JSON。');
    }
    if (data?.error) throw new Error(`模型列表返回错误：${sanitizeErrorText(data.error?.message || '请检查独立 Key；也可手动填写模型后测试连接。')}`);
    const items = Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.data?.data) ? data.data.data
        : Array.isArray(data?.models) ? data.models
            : Array.isArray(data) ? data : [];
    return items
        .map((item) => (typeof item === 'string' ? item.trim() : String(item?.id || item?.name || '').trim()))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
}

/** 记录最近一次发往模型的完整请求（调试用） */
export function recordDebugRequest(entry) {
    globalThis[DEBUG_LAST_REQUEST_KEY] = { at: Date.now(), ...entry };
}

// ─────────────────────────────────────────────
// 预设（读取 ST 预设管理器）
// ─────────────────────────────────────────────

/**
 * 列出 ST 中可用的预设名。
 *
 * ST 的 getPresetManager(apiId).getAllPresets() 返回的是「名称字符串数组」，
 * 而 getPresetList() 返回 { presets, preset_names } 对象。两者都要兼容，
 * 早期版本直接用 Object.keys() 取数组会得到 '0','1','2' 这样的索引。
 *
 * @returns {{names: string[], activeName: string}}
 */
export function listPresets(ctx, apiId = 'openai') {
    const names = [];
    let activeName = '';
    try {
        const manager = ctx?.getPresetManager?.(apiId);
        if (!manager) return { names, activeName };

        if (typeof manager.getSelectedPresetName === 'function') {
            activeName = String(manager.getSelectedPresetName() || '').trim();
        }

        if (typeof manager.getAllPresets === 'function') {
            const all = manager.getAllPresets();
            if (Array.isArray(all)) {
                for (const item of all) {
                    const name = String(item || '').trim();
                    if (name) names.push(name);
                }
            } else if (all && typeof all === 'object') {
                // 兼容可能返回 {name: preset} 的实现
                for (const key of Object.keys(all)) {
                    const name = String(key || '').trim();
                    if (name) names.push(name);
                }
            }
        }

        if (names.length === 0 && typeof manager.getPresetList === 'function') {
            const data = manager.getPresetList();
            const source = data?.preset_names && typeof data.preset_names === 'object'
                ? Object.keys(data.preset_names)
                : (data?.presets && typeof data.presets === 'object' ? Object.keys(data.presets) : []);
            for (const key of source) {
                const name = String(key || '').trim();
                if (name) names.push(name);
            }
        }
    } catch (error) {
        console.warn(`[${MODULE_NAME}] 读取预设列表失败`, error);
    }

    return {
        names: [...new Set(names)].sort((a, b) => a.localeCompare(b)),
        activeName,
    };
}

/**
 * 取某个预设里的提示词条目列表。
 *
 * @returns {Array<{identifier:string, name:string, enabled:boolean, role:string, content:string}>}
 */
export function getPresetPrompts(ctx, presetName, apiId = 'openai') {
    const name = String(presetName || '').trim();
    if (!name) return [];
    try {
        const manager = ctx?.getPresetManager?.(apiId);
        if (!manager || typeof manager.getCompletionPresetByName !== 'function') return [];
        const preset = manager.getCompletionPresetByName(name);
        const prompts = Array.isArray(preset?.prompts) ? preset.prompts : [];
        return prompts.map((prompt, index) => ({
            identifier: String(prompt?.identifier || `prompt-${index}`),
            name: String(prompt?.name || prompt?.identifier || `条目 ${index + 1}`),
            enabled: prompt?.enabled !== false,
            role: String(prompt?.role || 'system'),
            system_prompt: Boolean(prompt?.system_prompt),
            marker: Boolean(prompt?.marker),
            content: String(prompt?.content || ''),
        }));
    } catch (error) {
        console.warn(`[${MODULE_NAME}] 读取预设「${name}」条目失败`, error);
        return [];
    }
}

/**
 * 按覆盖表把预设转成可发给模型的 messages。
 *
 * 只处理 system / user / assistant 三种常规角色的普通条目；
 * marker、system_prompt 等 ST 内部标记条目跳过（它们要靠 ST 主流程展开，
 * 独立调用时无法正确还原，硬塞反而会污染提示词）。
 *
 * @returns {Array<{role:string, content:string}>}
 */
export function buildPresetMessages(ctx, presetName, overrides = {}, apiId = 'openai') {
    const prompts = getPresetPrompts(ctx, presetName, apiId);
    const messages = [];
    for (const prompt of prompts) {
        if (prompt.marker) continue;
        if (!String(prompt.content || '').trim()) continue;
        const enabled = Object.hasOwn(overrides, prompt.identifier)
            ? Boolean(overrides[prompt.identifier])
            : prompt.enabled;
        if (!enabled) continue;
        const role = ['system', 'user', 'assistant'].includes(prompt.role) ? prompt.role : 'system';
        messages.push({ role, content: prompt.content });
    }
    return messages;
}

export function getDebugInfo() {
    return {
        request: globalThis[DEBUG_LAST_REQUEST_KEY] || null,
        response: globalThis[DEBUG_LAST_RESPONSE_KEY] || null,
    };
}
