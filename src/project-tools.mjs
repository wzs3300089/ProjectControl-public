import { z } from 'zod';
import { projectRequestIdSchema, projectRequestSchema, projectProposalSchema, projectWriteSchema, StateError } from './project-store.mjs';
import { readCodexProjects } from './codex-projects.mjs';
import { readCodexAi, sendCodexAi } from './codex-ai.mjs';
import { REASONING_EFFORTS } from './console/shared/ai-settings.js';
import { readRequirementThreads, sendRequirementAi, writeWithThreadValidation } from './requirement-chat.mjs';

const empty = z.strictObject({});
const toolActions = {
  project_control_codex_ai_read: { schema: empty, run: (_store, _input, context) => readCodexAi(context) },
  project_control_codex_ai_send: { schema: z.strictObject({ text: z.string().trim().min(1).max(200000),
    settings: z.strictObject({ model: z.string().trim().min(1).max(200), reasoningEffort: z.enum(REASONING_EFFORTS) }),
    requirement: z.strictObject({ requirementId: z.string().trim().min(1).max(120), workspaceId: z.string().trim().min(1).max(120),
      expectedThreadId: z.string().uuid().nullable() }).optional() }),
    run: (store, input, context) => input.requirement ? sendRequirementAi(store, input, context) : sendCodexAi(input, context) },
  project_control_codex_threads: { schema: z.strictObject({ workspaceId: z.string().trim().min(1).max(120), threadId: z.string().uuid().optional() }),
    run: (store, input, context) => readRequirementThreads(store, input, context) },
  project_control_codex_projects: { schema: z.strictObject({ onOpen: z.boolean().optional() }),
    run: (store, input, context) => readCodexProjects({ ...context, store, onOpen: input.onOpen === true }) },
  project_control_projects_read: { schema: empty, run: (store) => store.read() },
  project_control_projects_write: { schema: projectWriteSchema, run: (store, input, context) => writeWithThreadValidation(store, input, context) },
  project_control_request_create: { schema: projectRequestSchema, run: (store, input) => store.createRequest(input) },
  project_control_request_read: { schema: projectRequestIdSchema, run: (store, { requestId }) => store.readRequest(requestId) },
  project_control_request_cancel: { schema: projectRequestIdSchema, run: (store, { requestId }) => store.cancelRequest(requestId) },
  project_control_propose_plan: { schema: projectProposalSchema, run: (store, input) => store.propose(input) },
  project_control_context: { schema: empty, run: (store) => ({ ...store.read(), hooksEnabled: false }) },
};

/** MCP 与本机 HTTP 预览共用的白名单执行入口，返回领域结果并保留业务错误状态码。 */
export function executeProjectTool(store, name, args = {}, context = {}) {
  if (!Object.hasOwn(toolActions, name)) throw new StateError('项目工具不存在。', 404);
  const action = toolActions[name];
  const parsed = action.schema.safeParse(args);
  if (!parsed.success) throw new StateError(`项目输入无效：${parsed.error.issues[0]?.message ?? '格式不正确'}。`);
  return action.run(store, parsed.data, context);
}

const output = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value,
});

const failure = (error) => {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  return { ...output({ error: error instanceof Error ? error.message : '项目操作失败。', status }), isError: true };
};

/** 注册项目文档与 Codex 预览工具；钩子只提供上下文接口，不启动任何自动执行。 */
export function registerProjectTools(server, store) {
  const register = (name, title, description, readOnlyHint, visibility = ['app', 'model']) => {
    server.registerTool(name, {
      title, description, inputSchema: toolActions[name].schema,
      annotations: { readOnlyHint, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility }, 'openai/widgetAccessible': true },
    }, async (input, extra) => {
      try { return output(await executeProjectTool(store, name, input, { meta: extra._meta })); }
      catch (error) { return failure(error); }
    });
  };

  register('project_control_codex_ai_read', '读取 Codex 模型选项',
    '只读取得本机 Codex 模型目录、支持的思维长度和调用聊天已保存的模型配置。不会读取聊天正文或修改模型。', true);
  register('project_control_codex_ai_send', '按所选模型发送到当前 Codex 聊天',
    '仅供总控台用户点击发送：指定 requirement 时按已保存且归属匹配的绑定发送，未绑定则在需求所属 Codex 项目（或无项目）创建对话并自动绑定。其他入口沿用当前聊天。失败或结果未知不得自动重发。', false, ['app']);
  register('project_control_codex_threads', '读取需求可绑定的 Codex 对话',
    '取得当前 workspace 对应本机 Codex 项目的未归档对话，自动解除已不存在的本机项目绑定，并清理确认已删除或归档的需求对话绑定；读取失败或归属不明不清理。threadId 可检查表单未保存的选择。未绑定项目只返回明确无项目对话，不读取聊天正文、不修改 Codex 数据。', false, ['app']);

  register('project_control_codex_projects', '读取 Codex 项目绑定选项',
    '取得本机 Codex 项目列表及调用聊天所属项目；成功读取后自动解除总控台中已不存在的本机项目绑定及其需求对话绑定，读取失败或远程项目不清理。仅打开总控台时传 onOpen=true，尚无聊天归属时按桌面当前选择定位；已有归属优先。不会读取聊天内容或修改 Codex 数据。', false);

  register('project_control_projects_read', '读取项目总控台',
    '读取完整状态与最新 revision；workspaces 为项目及模块，projects 为需求，workspaceId 标识所属项目。', true);
  register('project_control_projects_write', '保存项目总控台',
    '整体保存项目状态；revision 必须来自最新读取，并保留无关数据。AI 填充请求须先提交预览，经用户确认后保存。若用户已明确授权开发进度回写，可直接更新指定需求的 updates、progress、todos、updatedAt；进展按“完成/验证/待办”三行简报，尽量 100–180 字。全部需求与验收完成时，必须同次写入 progress=100、status="已完成"；部分完成或有验收阻塞不能标记完成。按需求 ID 与 workspaceId 定位，保存后回读比例与状态，其他变更仍需相应授权。',
    false);
  register('project_control_request_create', '创建 Codex 项目请求',
    '记录用户指令及 workspaceId 并返回 requestId；多项目时必须指定当前项目，计划仅操作该项目的需求。',
    false);
  register('project_control_request_read', '读取 Codex 项目请求',
    '按 requestId 读取原指令、请求版本、状态与生成的预览计划。',
    true);
  register('project_control_request_cancel', '取消 Codex 项目请求',
    '取消指定请求；取消后不能再提交预览，不改变项目数据。',
    false);
  register('project_control_propose_plan', '提交项目变更预览',
    '仅提交预览：先读取 requestId 对应原指令及 workspaceId，读取最新数据并只使用该项目的需求，再提交 plan={intent,reply,actions}。actions 支持 add、update、delete、addTodo、doneTodo、addLog；target 是需求 ID 或名称。不可用此工具管理项目或模块，计划不直接写入，必须等用户确认。',
    false);
  register('project_control_context', '读取项目钩子上下文',
    '只读取得当前 revision/state 供未来钩子复用；hooksEnabled=false，当前不会注册或启用任何自动钩子。',
    true);
}
