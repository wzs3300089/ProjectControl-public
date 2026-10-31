# 项目总控台：给 Codex 的安装与验收说明

请将本文件和整个安装包交给对方的 Codex。先完整阅读，再按步骤操作；如果环境或权限不满足，向用户说明具体问题，不要改动其他插件或覆盖已有数据。

## 包内结构

- `marketplace/.agents/plugins/marketplace.json`：Codex 本地插件源。
- `marketplace/plugins/project-control/`：标准插件清单、MCP 配置、已构建界面和服务。
- `source/`：可阅读和修改的源代码。安装时不需要执行 npm install。
- `licenses/`：上游及打包依赖的许可证。

本包不包含原作者的项目数据库、Codex 凭据或自动对话钩子。数据库默认位于当前用户的 `~/.codex/project-control/data/`，与插件缓存分开，更新和卸载插件时应保留；如设置 `PROJECT_CONTROL_DATA_DIR`，以该目录为准。不要把这个目录当成测试临时目录删除。

项目及需求可绑定本机 Codex 项目与聊天，AI 可使用选择的模型和思维长度。适配器读取本机 Codex 项目、聊天归属及模型元数据，并通过宿主提供的本地通道发送；插件配置显式继承 `CODEX_APP_TOOLS_PIPE_PATH`，不要记录或公开其值。此能力依赖当前客户端内部格式和通道，可能随客户端版本变化，不支持远程项目或云项目。面板发送成功仅表示宿主接收，不等于 AI 已完成任务。

插件使用 Codex 支持的 `.codex-plugin/plugin.json` 和 `.mcp.json` 兼容格式，MCP 工作目录以插件根目录为基准；该格式用于在当前客户端正确继承宿主通道。

## 安装

1. 确认使用支持本地插件和本地 MCP 的 Codex 桌面版，且在本机执行。Windows 为主要目标环境；其他系统未验收。检查 `node --version` 是 Node.js 24，并确认 Codex 启动的环境能找到 `node`；本包不自带 Node。如果缺少，请告知用户并按授权安装或配置，不能声称插件已经可用。
2. 将**整个解压目录**保存到不会被清理的固定位置；本地 marketplace 引用此目录。检查对方已有的插件及同名 marketplace，避免覆盖或更改其他条目。本包插件标识为 `project-control@project-control-distribution`。
3. 在 Codex CLI 中执行 `codex plugin marketplace add "<解压目录>/marketplace"`，用实际绝对路径替换尖括号，并使用 `codex plugin marketplace list` 核对。该命令会修改当前用户的 Codex 插件源配置；不要直接覆写整个配置文件或已有 marketplace。
4. 此版本 CLI 支持时，可执行 `codex plugin add project-control@project-control-distribution`，再用 `codex plugin list` 确认安装并启用。否则按客户端提示刷新或重启 Codex 桌面应用，在插件目录中选择「项目总控台」插件源，安装并启用「项目总控台」。工作区策略、客户端版本和用户权限可能要求用户确认；如果客户端无法提供安装入口，不要绕过限制。
5. 在一个本地 Codex 聊天中打开右侧「＋ → 更多工具… → 项目总控台」。如果没有入口，检查插件启用状态、MCP 服务启动日志、Node 版本与插件源路径；必要时请用户重开聊天或重新启用插件。

### 从旧安装包升级

先核对已配置的 `project-control-distribution` 插件源及路径。仅替换该源内本插件的文件，保留其他插件和用户数据；然后执行 `codex plugin add project-control@project-control-distribution` 并用 `codex plugin list` 核对版本为 `0.2.0`。如插件源位置改变，应先按 Codex 的 marketplace 管理命令更新该来源，不能覆盖整个配置。重启或重新启用插件，再关闭旧面板并重新打开。不得删除 `~/.codex/project-control/data/`，该目录中的项目在升级后应继续可读。

## 验收

1. 首次安装且无已有数据时，左上角为「项目总控台」，主区域只有「创建项目」按钮。已有数据则必须保持不变，不要清空它来复现空状态。
2. 在隔离的数据目录进行写入测试：启动测试服务时设置 `PROJECT_CONTROL_DATA_DIR` 指向新建的临时目录；创建测试项目、模块和需求，保存并重启后检查内容，核实删除有需求的项目会被阻止。测试后仅清理明确由本次测试创建的临时数据。
3. 正式面板做只读核对：打开后项目及模块显示正确。实际写入或删除正式数据只在用户要求时进行。
4. 核对 AI 填充是否能够向当前聊天提交请求，等待实际回执并确认预览。消息送达、实际回答、变更确认分别报告；不能仅凭发送成功宣称完整通过。没有用户授权不要在正式数据上执行变更。
5. 报告插件源是否注册、插件是否启用、右侧面板是否打开、测试数据是否重启回读、AI 流程是否实际验证，以及未验证项。

本包不提供实时多人同步，用户各自的数据保存在各自的电脑上。`source/` 是供继续开发的源码：在此目录用 Node.js 24 安装依赖后，依次运行 `node scripts/build.mjs` 和 `node scripts/build-package.mjs`；产物在 `source/release/project-control-codex/`。打包脚本拒绝覆盖已有交付目录。不要把插件缓存当作源码目录。
