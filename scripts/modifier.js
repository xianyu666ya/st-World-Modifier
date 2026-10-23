/** World Modifier: direct edits. Added for the 2026-10-23 derivative. */
import { getChatData, getSettings, saveSettings } from './state.js';

export const MODIFICATION_TYPES = Object.freeze({
    self: '我的身份 / 能力', cognition: '人物认知', world: '世界 / 环境', custom: '其他修改',
});
export const AWARENESS_MODES = Object.freeze({
    natural: '相关人物认为一直如此', noticed: '相关人物知道发生了变化', preserve: '保留其他人物原有认知',
});
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const id = () => globalThis.crypto?.randomUUID?.() || `wm-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function normalizeModification(value) {
    if (!record(value)) return null;
    const text = String(value.text || '').trim().slice(0, 16000);
    if (!text) return null;
    return {
        id: String(value.id || id()),
        type: Object.hasOwn(MODIFICATION_TYPES, value.type) ? value.type : 'custom',
        target: String(value.target || '世界').trim().slice(0, 120) || '世界',
        text,
        awareness: Object.hasOwn(AWARENESS_MODES, value.awareness) ? value.awareness : 'natural',
        enabled: value.enabled !== false,
        createdAt: Number(value.createdAt) || Date.now(), updatedAt: Number(value.updatedAt) || Date.now(),
    };
}

/** One-time migration; old archives remain available in backups. */
export function getModifications(ctx) {
    const data = getChatData(ctx);
    if (!Array.isArray(data.modifications)) data.modifications = [];
    if (data.modifierVersion !== 1) {
        data.modifications = data.modifications.map(normalizeModification).filter(Boolean);
        const rules = { ...getSettings(ctx)?.globalRules, ...data.rules };
        for (const [name, rule] of Object.entries(rules)) {
            if (!rule?.description) continue;
            data.modifications.push(normalizeModification({
                type: 'custom', target: name, text: rule.description,
                enabled: rule.enabled !== false && !Object.hasOwn(data.retiredRules || {}, name),
            }));
        }
        data.modifierVersion = 1;
        saveSettings(ctx);
    }
    return data.modifications;
}

export function saveModification(ctx, input, existingId = '') {
    const list = getModifications(ctx);
    const index = existingId ? list.findIndex((item) => item.id === existingId) : -1;
    if (existingId && index < 0) throw new Error('这条修改已经被删除，请重新添加。');
    if (!String(input?.text || '').trim()) throw new Error('请先写下希望修改成什么。');
    const previous = index >= 0 ? list[index] : null;
    const entry = normalizeModification({ ...previous, ...input, enabled: input.enabled ?? true, id: previous?.id || id(), updatedAt: Date.now() });
    if (index >= 0) list.splice(index, 1);
    list.push(entry);
    saveSettings(ctx);
    return entry;
}

export function toggleModification(ctx, entryId) {
    const entry = getModifications(ctx).find((item) => item.id === entryId);
    if (!entry) return false;
    entry.enabled = !entry.enabled;
    saveSettings(ctx);
    return true;
}

export function removeModification(ctx, entryId) {
    const list = getModifications(ctx);
    const index = list.findIndex((item) => item.id === entryId);
    if (index < 0) return false;
    list.splice(index, 1);
    saveSettings(ctx);
    return true;
}

export function undoLastModification(ctx) {
    const latest = [...getModifications(ctx)].reverse().find((item) => item.enabled);
    if (!latest) return null;
    latest.enabled = false;
    saveSettings(ctx);
    return latest;
}

export function renderModifications(entries, userName = '用户') {
    const active = entries.filter((item) => item.enabled);
    if (!active.length) return '';
    const blocks = active.map((item, index) => {
        const target = item.type === 'self' ? userName : item.target;
        const awareness = item.type === 'cognition'
            ? '只改写上述对象的认知与记忆；除非修改内容明确要求，不改变其他人物认知，也不将其信念自动变为客观事实。'
            : {
                natural: '同步受影响人物的认知与记忆，让他们自然接受结果，认为一直如此。',
                noticed: '落实修改结果；受影响人物保留修改前的记忆，能够察觉变化。',
                preserve: '落实修改结果；其他人物的原有认知和记忆不随之改写。',
            }[item.awareness];
        return `${index + 1}. 类型：${MODIFICATION_TYPES[item.type]}
对象：${target}
修改后的结果：${item.text}
认知处理：${awareness}`;
    });
    return `[世界修改器 · 当前已生效的修改]
以下是用户通过世界修改器直接确定的当前设定。它们已经生效，不是提议、愿望、待完成任务或需要角色批准的请求。
从下一段叙事开始落实这些结果，无需额外仪式、修炼、解释或确认。身份、能力和世界修改视为事实；认知修改只对指定对象生效。
同一事项出现冲突时，列表中更靠后的修改优先；无关事项同时保留。按设定自然续写，不要在正文复述本面板说明。

${blocks.join('\n\n')}
[/世界修改器]`;
}
