# 拾念 · 灵感收件箱

随手存下一个念头，在新内容里找回旧灵感。手机与电脑网页均可使用，可在支持的浏览器添加到主屏幕。

**在线使用：从仓库的 Deployments 或 Pages 入口打开已发布网页。**

第一版为网页应用（PWA），不是微信原生小程序。

## 已实现

- 文字记录、原话保留、简短标题、标签、下一步与来源链接。
- 搜索、按标签查看、归档和恢复。
- 中文及英文词语匹配推荐旧卡片；说明共同词语，支持确认、忽略、撤销关联。
- **连接用户自己的模型服务**：支持非流式 Chat Completions 兼容 HTTP 接口。可手动查看请求后调用，也可主动开启“新卡片保存后自动整理”。
- 模型结果的结构检查、请求与卡片 ID 检查、过期结果拒绝，以及关联原文引用检查。模型整理不改写原话；关联建议需要逐条确认。
- 无 API 密钥时，可复制请求到常用 AI 软件，将 JSON 结果粘贴回来、预览并确认。
- JSON 备份导出与合并导入，已有同 ID 卡片保留当前版本。
- 首次联网访问后缓存应用文件，支持离线记录。

## 依赖怎么解决

应用没有第三方运行依赖，没有安装步骤，没有框架构建工具、外部字体、CDN、模型 SDK 或数据库服务。

| 环节 | 依赖 | 由谁提供 |
| --- | --- | --- |
| 本地整理、记录和关联 | 现代浏览器 | 使用者 |
| 网页发布 | GitHub Pages + 官方 GitHub Actions | 仓库维护者 |
| 自动 AI 整理 | 兼容接口、可用模型和允许跨域的服务 | 每位使用者自己 |
| 本地开发及单元测试 | Node.js 22 或更高版本 | 开发者 |

GitHub Actions 固定官方 action 的提交版本，不执行 npm install。GitHub Pages 仅发布 `site/`，不上传测试或个人备份。

## 连接自己的模型

点击右上角 **连接我的模型**，填写：

1. 完整接口地址，例如 `https://your-model-service.example/v1/chat/completions`。必须包含 `/chat/completions`；这是格式示例，不是可用服务。
2. 服务提供的模型 ID。
3. 自己的 API 密钥。免密的个人服务可以留空。

“保存并测试”会发送一句固定测试文字，不发送卡片，可能产生少量费用。“保存本次连接”只保存当前页面的配置，并不证明能成功调用。

密钥仅保留在当前页面内存，不写入 localStorage、sessionStorage、备份或仓库。页面刷新或关闭后需要重新连接。浏览器密码管理器、扩展或设备本身不在应用控制范围内。只向你填写的服务发送请求，拒绝重定向，禁止在 URL 中携带密钥。仅使用你信任的网站版本、服务和限额密钥；前端程序运行时必然能够使用你输入的凭据。

**服务必须允许网页跨域访问（CORS）**，通常需要允许来源 `你的网页来源`、POST、Content-Type 和 Authorization。并非所有服务都支持浏览器直接访问。接口不允许时，需要使用自己的可信网关，或复制请求到现有 AI 软件。本项目没有公共转发服务，不会代收所有人的模型密钥。

本机服务支持 `http://localhost:端口/v1/chat/completions` 或 `http://127.0.0.1:端口/v1/chat/completions`，仍受浏览器的本地网络、跨域与 HTTPS 安全策略限制；从本地预览访问通常更易配置。原生 Anthropic Messages、Gemini generateContent、OpenAI Responses 等其他协议没有适配，需由使用者自己的兼容网关转换。

选择 **新卡片保存后自动整理** 时，每次保存会发送当前原话及最多三张按本地词语匹配选出的候选卡片。一次只处理一个模型请求；已有请求进行时，新卡片先保存，可随后手动整理。每次最多输出约 2500 tokens，客户端等待 60 秒。取消请求或超时不能保证服务端取消计费。自动整理授权随页面刷新清除。

手动调用先查看请求，返回后预览并确认保存。自动整理在用户主动开启后更新标题、标签和下一步；所有模式均保留原话，候选关联均需手动确认。第一版的候选检索是词语匹配，不是全库语义检索；完全不同措辞的相关想法可能漏掉。

## 数据与范围

默认不向模型发送内容；没有统计脚本或应用账号。卡片保存在当前浏览器的 localStorage，**没有跨设备同步**。浏览器清理网站数据、无痕模式退出或更换设备时可能丢失，请定期导出备份。GitHub Pages 的宿主方仍有其自身访问日志，公开代码不代表所有网络活动匿名。

本地标题是文字截取，标签是词语规则。关键词关联、模型输出与原文引用通过检查，均不代表事实正确、因果关系或独立证据。可以不接受任何关联。

第一版不抓取网页正文、不后台监控、不读取其他 AI 的登录状态、不提供微信原生小程序、语音转写服务或云端同步。语音记录可以使用手机键盘自带语音输入。

设计容量上限为 3000 张卡片、10000 条确认关联，实际容量受浏览器存储额度限制。写入失败会提示，不将失败写入显示为成功。损坏存储会停止写入保护原始内容，可先导出原始存储。

## 本地运行

```sh
node scripts/serve.mjs
```

访问 `http://127.0.0.1:4173/`。默认只监听本机。也可用任何静态网页服务器托管 `site/`；ES 模块和服务工作线程需要 HTTP(S)，请不要双击打开 HTML。

## 检查与发布

```sh
node --test
```

单元测试包含：原话保留、危险 URL 拒绝、相关与无关卡片区分、忽略和确认状态、备份合并、AI 伪造引用拒绝、过期请求拒绝、模型请求范围及错误信息隐藏。

浏览器检查脚本 `scripts/browser-check.mjs` 需要开发者已有的 Playwright，通过 `PLAYWRIGHT_MODULE` 指定其模块路径；它不属于应用运行依赖，不会在页面加载。其模型响应使用测试桩，不能证明真实模型服务的密钥、额度或 CORS 可用。

仓库 Settings → Pages 使用 GitHub Actions。推送 main 后自动运行单元测试，发布 `site/`。

## 官方参考

- [GitHub Pages 静态站点说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [GitHub Pages 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [浏览器 CORS 机制](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)
- [Chat Completions 兼容接口示例：DeepSeek 官方文档](https://api-docs.deepseek.com/api/create-chat-completion/)
- [ChatGPT 与 API 计费独立](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform)

版本：0.1.0。
