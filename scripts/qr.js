export const QR_BUTTON_ID = 'wm-floating-orb';

const registration = Object.freeze({
    dom_id: QR_BUTTON_ID,
    group_name: '世界修改器',
    button_name: '打开世界修改器',
});

export function syncQrRegistration(enabled, targetWindow = globalThis.window, targetDocument = globalThis.document) {
    if (!targetWindow) return false;
    const registry = Array.isArray(targetWindow.qrAssistantExtensionApi)
        ? targetWindow.qrAssistantExtensionApi.filter((item) => item?.dom_id !== QR_BUTTON_ID)
        : [];
    if (enabled) registry.push({ ...registration });
    if (enabled || Array.isArray(targetWindow.qrAssistantExtensionApi)) {
        targetWindow.qrAssistantExtensionApi = registry;
    }
    if (!enabled) {
        targetDocument?.getElementById(QR_BUTTON_ID)?.classList.remove('qrq-hidden-by-plugin', 'qrq-whitelisted-original');
    }
    return enabled;
}
