# 项目总控台 · Codex

## 项目介绍

项目总控台是运行在 Codex 桌面版中的本地项目管理插件，用于集中管理项目、模块、需求、进展和待跟进事项，并在需要时把工作交给 Codex 处理。

- 提供概览、模块看板、状态看板、列表、日历、时间线和待跟进七种视图，支持搜索与筛选。
- 项目可绑定本机 Codex 项目，并设置默认模型和思维长度；需求可绑定相应的本机 Codex 对话。
- 支持 AI 填充、需求开发与分析，以及周报、状态汇报、风险清单和会议纪要。AI 填充的变更需要在预览后确认。
- 数据保存在本机 SQLite 数据库中，不提供多人实时同步。绑定和 AI 发送依赖 Codex 桌面客户端的本地能力；远程和云项目不在当前支持范围内，客户端更新可能影响兼容性。

项目基于 `dsh-workbench-project-console@1.0.1` 的组件迁移，来源说明见 [UPSTREAM.md](src/console/UPSTREAM.md)，上游许可证见 [licenses](licenses/)。

## 安装方法

以下步骤从源码构建本地插件包，主要针对 Windows。需要支持本地插件和 MCP 的 Codex 桌面版，以及 Codex 启动环境可访问的 Node.js 24。其他操作系统尚未验收。

1. 克隆仓库并进入项目目录：

   ```powershell
   git clone https://github.com/wzs3300089/ProjectControl-public.git
   cd ProjectControl-public
   node --version
   ```

2. 安装依赖并构建插件包：

   ```powershell
   npm ci --ignore-scripts
   node scripts/build.mjs
   node scripts/build-package.mjs
   ```

   插件包生成在 `release/project-control-codex/`。打包脚本不会覆盖已有的同名输出目录；如果目录已存在，可使用 `node scripts/build-package.mjs --output <新目录>` 指定不存在的输出位置。

3. 将生成的整个插件包保存在不会被清理的固定位置。在 PowerShell 中进入该包所在目录，注册插件源并安装插件：

   ```powershell
   $marketplacePath = (Resolve-Path .\marketplace).Path
   codex plugin marketplace add "$marketplacePath"
   codex plugin add project-control@project-control-distribution
   codex plugin list
   ```

   若当前客户端不支持上述安装命令，请在 Codex 的插件界面中选择已注册的「项目总控台」插件源并安装、启用插件。详细说明及升级注意事项见 [安装说明](distribution/INSTALL.md)。

4. 重新打开 Codex 聊天，在右侧选择「＋ → 更多工具… → 项目总控台」。如果入口未出现，请检查插件是否启用、Node.js 版本和插件源路径。

## 使用方法

1. 在面板中创建项目，再通过项目菜单管理模块；在对应模块下创建需求，填写说明、进展和待跟进事项。
2. 使用顶部视图切换、搜索和筛选查看工作；有需求的项目或模块需先移走或删除其中的需求，才能删除。
3. 在项目设置中按需绑定本机 Codex 项目和默认模型；在需求中选择对应的 Codex 对话。未绑定对话时，需求发送会在对应项目或无项目范围内新建对话并在收到接收回执后保存绑定。
4. 在需求详情中使用 AI 助手发送开发或分析请求，或在项目中生成报告。发送成功表示宿主已接收消息，仍需等待 Codex 实际完成；结果不明确时先检查对应对话，避免重复发送。

插件包默认将数据保存在 `~/.codex/project-control/data/`；设置 `PROJECT_CONTROL_DATA_DIR` 时使用指定目录。更新或卸载插件前请保留该目录。独立网页预览可在源码目录执行 `npm run web`，默认访问 `http://127.0.0.1:43937/`；AI 发送功能需要 Codex 插件面板。
