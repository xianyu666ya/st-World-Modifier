# 世界修改器 · World Modifier 2.0

基于 Mjbajj/st-World-Modulator 的二改版本。将原来的规则、档案与自动追踪界面，改为直接修改身份、人物认知和世界环境的简单面板。

## 使用

1. 打开酒馆中的一个聊天，点击悬浮的 ✦，或扩展菜单中的「世界修改器」。
2. 选择修改类型和对象，写下修改后的结果。
3. 点击「应用修改」，然后继续聊天。

例如：

- 我的身份 / 能力：我已经从普通人成为掌控时间与空间的神，可以自由使用这些力量。
- 人物认知，对象「林晚」：坚信我是自己的老师，并记得与我相识多年的经历。
- 世界 / 环境：当前世界进入永夜，天空中始终有两轮月亮。

直接应用不需要 API，不需要让分析模型把想法转换成规则。修改不会向聊天输入框发送消息，也不会自动触发主模型回复。

修改通过酒馆的提示词注入接口传递给主模型，从下一轮回复开始读取。最终叙事仍由模型生成；本插件不会改写已经生成的正文。

## 三个页面

- **直接修改**：修改类型、对象、结果和认知处理方式。内置三个示例；Ctrl / Cmd + Enter 快速应用。
- **已生效**：编辑、停用、启用或删除修改；撤销最近一条；查看实际注入内容。
- **设置**：暂停 / 恢复注入、深浅主题、可选 AI 连接、API 配置组和完整备份。

修改只作用于当前聊天。切换聊天时重新加载对应修改，刷新页面后仍然保留。编辑后的修改移到最后；同一事项冲突时，后面的内容优先。

人物认知只影响指定对象，不会自动把他的信念变成客观事实。其他类型可以选择同步相关人物认知、让他们察觉变化，或保留他人原有认知。

## 可选 AI 细化

「AI 帮我细化」可将简短想法补充成清楚的描述。结果只回填到输入框，用户点击应用后才生效。请求期间改动输入、应用修改或切换聊天，会丢弃旧结果。

旧版自动分析、推荐规则和成人档案表单不再进入日常操作。旧版角色档案、衣柜等存档保留在数据中，可以随备份导出；旧版规则会首次转换为可编辑的修改。

## API 配置与修复

默认使用酒馆主 API。支持宿主提供的 generateRaw；也保留自定义兼容连接的转发方式。

独立 API 使用 OpenAI 兼容的 Chat Completions 协议：

1. 设置 → API 模式 → 独立 API。
2. 填入基础地址、Key 和模型名称。
3. 点击「测试连接」。拉取模型是可选步骤，不支持模型列表的服务也可以直接测试。

支持基础地址或完整的 /v1/chat/completions 地址。只有域名时自动补 /v1；自定义路径保持不变。模型名称可以手填，拉取列表不会覆盖已经填写的模型。

原生 Anthropic Messages、Gemini 等接口地址不属于 OpenAI 兼容接口；可通过酒馆主连接使用相应服务。

本版本修复：

- 拉取模型与生成请求都显式携带独立 Key，避免错误使用酒馆保存的自定义 Key。
- 从当前酒馆 context 读取正确的请求头和 CSRF token。
- API Key 请求头使用合法 YAML / JSON 编码。
- 401 / 403 保留实际错误，不再全局关闭代理或掩盖成浏览器跨域错误。
- 默认不强制 response_format，以兼容仅支持普通文本 JSON 输出的服务。
- 支持自动、酒馆代理和浏览器直连。直连需要服务端允许跨域。
- API 配置组保留地址、Key、模型、温度、超时和请求方式。

导入 API 支持 JSON 文件或粘贴 JSON。字段可使用 apiUrl / apiKey / model，或 base_url / api_key / model；也可导入备份中的配置组。未标注 API 模式、但包含独立地址的配置组，会自动识别为独立配置。

## 安装这个二改版本

手机和电脑均可直接通过 GitHub 链接安装：

1. 打开酒馆 → 扩展 → 安装扩展。
2. 粘贴仓库地址：https://github.com/xianyu666ya/st-World-Modifier
3. 安装完成后刷新页面，打开聊天即可使用。

后续更新可在酒馆扩展管理中检查更新。本仓库是独立二改版，原作者仓库中的版本不会自动变成这个版本。

也可以使用本地代码或安装包。

压缩包里包含 st-World-Modulator 文件夹。将该文件夹替换到：

    SillyTavern/data/default-user/extensions/third-party/st-World-Modulator/

manifest.json、index.js、template.html 和 style.css 应位于插件文件夹根目录。替换后刷新酒馆页面。

避免同时启用旧版与二改版。更新前可以先从旧版导出备份。

## 备份

新版备份覆盖所有聊天、旧版存档、当前设置和连接配置组，也能恢复旧版 World Modulator 的单聊天备份。

默认不导出 API Key；完整迁移时勾选「导出时包含 API Key」。同一地址恢复不含 Key 的备份会保留已有密钥；更换地址而未提供 Key 时会清空旧密钥，防止将旧 Key 发到另一服务。

## 开发与验证

无需构建，直接由酒馆加载原生 JavaScript 模块。

    npm test

测试覆盖直接修改、认知范围、聊天隔离、旧版迁移、完整备份、API 导入、代理鉴权和取消请求。全部请求使用模拟数据，不需要真实 Key。

可选浏览器验证脚本为 tests/browser-smoke.mjs，需要 Playwright 和本机浏览器。可用 PLAYWRIGHT_MODULE 指定现有 Playwright 入口，用 BROWSER_EXECUTABLE 指定浏览器可执行文件，然后运行：

    node tests/browser-smoke.mjs

浏览器测试启动临时模拟宿主并在结束时关闭，只用于验证交互，不代表已连接用户的真实模型服务。

## 文件结构

    index.js               界面、聊天切换与交互
    template.html          三页主面板
    style.css              深浅主题与手机布局
    scripts/modifier.js    直接修改、优先级与旧规则迁移
    scripts/inject.js      当前聊天的修改注入
    scripts/api.js         主 API、独立 API 与模型列表
    scripts/backup.js      全量备份及 API 导入
    scripts/state.js       原有存储与 API 配置组

其余旧版模块保留以保存原项目结构，但不再驱动新版界面或自动分析。

## 来源与许可

- 原项目：[Mjbajj/st-World-Modulator](https://github.com/Mjbajj/st-World-Modulator)，Apache License 2.0。
- 原项目参考：[Liuuuu54/st_bs_biotracker](https://github.com/Liuuuu54/st_bs_biotracker)，Apache License 2.0。
- 宿主：[SillyTavern](https://github.com/SillyTavern/SillyTavern)。

保留原 LICENSE、LICENSE-BS-BioTracker 和相关归属。二改说明见 NOTICE 与 CHANGELOG.md。
