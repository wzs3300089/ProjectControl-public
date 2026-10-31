/**
 * 把需求数据变成可交给 Agent 的提示词，以及常用文档草稿。
 * 面板生成文本，并通过现有消息接口发送到当前 Codex 聊天；也可复制与导出。
 */
import { clampProgress, formatRemaining, latestUpdate, openTodos, overview, projectRisk, sortByRisk } from './analysis.js'
const KIND_LABELS = { note: '记录', progress: '进展', blocker: '阻塞', decision: '决策' }

function bullets(items, empty = '（暂无）') {
  if (!items || items.length === 0) return empty
  return items.map((item) => `- ${item}`).join('\n')
}

/** 开发交接保留完整需求内容，只选择开发相关字段，不复用包含排期的汇报摘要。 */
export function buildDevelopmentPrompt({ project, workspace }) {
  if (!project?.id || !workspace?.id || project.workspaceId !== workspace.id) {
    throw new Error('需求或所属项目不匹配，请刷新后重新发送。')
  }
  const updates = (Array.isArray(project.updates) ? project.updates : []).slice()
    .sort((a, b) => String(b?.at ?? '').localeCompare(String(a?.at ?? '')))
  const todos = Array.isArray(project.todos) ? project.todos : []
  const pending = todos.filter(item => item.done !== true)
  const completed = todos.filter(item => item.done === true)
  const todoLine = item => `${item.title}${item.id ? `（待跟进 ID：${JSON.stringify(item.id)}）` : ''}`
  return [
    '请开发下面这条需求，实际完成必要的分析、实现和验证。',
    '先检查当前代码、项目规则和已有实现，复用合适能力，依据已有进展继续推进。若需求、验收标准、代码位置或实现边界有疑问，请向我澄清；能独立推进的部分继续处理，不要臆测关键业务规则。',
    '',
    '开发与进度回写要求：',
    '我通过「发送开发需求」授权你执行本需求，并在完成一个计划里程碑、完成部分可验证成果或整个需求时，直接更新本需求的进展记录、完成比例和待跟进；全部验收完成时同步更新需求状态，无需就这些进度回写重复确认。',
    '1. 开始前及每次回写前，调用 project_control_projects_read 读取最新 revision/state；在 state.projects 中同时按下方需求 ID 和 workspaceId 定位，不能只按名称匹配。若需求已删除、移动或内容发生影响开发的变化，先向我澄清。',
    '2. 在该需求的 updates 中追加简报，保留原有记录。每次里程碑只写一条，text 固定按下面三行组织（使用真实换行），总计尽量控制在 100–180 字，每行 1–2 个要点，只写本次新增结果：',
    '完成：本次成果；完成比例及简短依据\n验证：实际验证及结论；未验证项明确注明\n待办：下一步或阻塞；没有则写“无”',
    '详细命令、文件清单、轮次 ID、排查过程等留在聊天或验收文档，简报必要时只附一个文档位置；不要重复需求说明或累计复述全部历史。每条新记录使用唯一 id、真实 ISO 时间 at、kind（progress/blocker/decision/note）及 text。',
    '3. 按实际已完成且验证的工作调整 progress（0–100）。部分完成或仍有验收阻塞时不能报 100，也不能设为“已完成”；全部需求与验收完成后，必须在同一次保存中设置 progress=100、status="已完成"，并核对本需求范围内的 todos 已完成，不要只更新百分比而遗漏需求状态。',
    '4. 更新 todos：按待跟进 ID 标记已完成项（done=true、doneAt 为实际完成时间），保留历史；为未完成工作、阻塞和待我澄清的问题补充具体事项，避免重复。新事项使用唯一 id、title、done=false，不编造负责人或截止日期。',
    '5. 调用 project_control_projects_write({revision,state}) 保存，只改这条需求的 updates、progress、todos、updatedAt，以及全部验收完成时的 status；完整保留最新 state 中其他字段、需求、项目和模块。发生版本冲突时重新读取并合并本次进展，检查是否已写入以免重复，不覆盖他人修改。',
    '6. 保存后再次读取确认进展、完成比例、需求状态和待跟进均已正确落盘，再向我简短报告；最终交付必须同时核对 progress=100 与 status="已完成"。若工具不可用或保存失败，明确说明未回写及原因，保留待写内容，不声称已经更新。',
    '上述授权仅适用于本需求的开发进度回写；业务范围变化或其他需新增授权的操作仍应先向我确认。',
    '',
    '需求定位：',
    `- 所属项目：${workspace.name || workspace.id}`,
    `- workspaceId：${JSON.stringify(workspace.id)}`,
    `- 需求 ID（state.projects[].id）：${JSON.stringify(project.id)}`,
    project.module ? `- 所属模块：${project.module}` : '',
    workspace.codexProject?.path ? `- 已绑定代码目录：${workspace.codexProject.path}` : '',
    '',
    `## 需求名称\n${project.name || '未命名需求'}`,
    `## 需求说明\n${project.summary || '（未填写，请先澄清要交付的内容）'}`,
    project.link ? `## 相关链接\n${project.link}` : '',
    project.tags?.length ? `## 相关标签\n${project.tags.join('、')}` : '',
    `## 已登记完成比例\n${clampProgress(project)}%（需结合代码与验证核实）`,
    `## 进展记录（新→旧，共 ${updates.length} 条）`,
    bullets(updates.map(item => `[${KIND_LABELS[item.kind] ?? '记录'}] ${item.text}`)),
    `## 待跟进记录（未完成 ${pending.length} 项）`,
    bullets(pending.map(todoLine)),
    `## 已完成待跟进（${completed.length} 项）`,
    bullets(completed.map(todoLine)),
  ].filter(row => row !== '').join('\n\n')
}

/** 单个需求的 Markdown 摘要，提示词和文档草稿共用。 */
export function projectBrief(project, today) {
  const risk = projectRisk(project, today)
  const updates = (Array.isArray(project?.updates) ? project.updates : [])
    .slice()
    .sort((a, b) => String(b?.at ?? '').localeCompare(String(a?.at ?? '')))
  const todos = openTodos(project)
  const doneTodos = (Array.isArray(project?.todos) ? project.todos : []).filter((todo) => todo?.done === true)
  return [
    `### ${project?.name ?? '未命名需求'}`,
    `- 模块：${project?.module || '其他项目'}`,
    `- 状态：${project?.status || '进行中'}`,
    `- 进度：${clampProgress(project)}%`,
    `- 负责人：${project?.owner || '未指定'}`,
    `- 起止：${project?.startedOn || '未填'} → ${project?.dueDate || '未排期'}（${formatRemaining(project?.dueDate, today)}）`,
    `- 时间风险：${risk.label} — ${risk.detail}`,
    project?.link ? `- 链接：${project.link}` : '',
    project?.summary ? `- 一句话说明：${project.summary}` : '',
    project?.tags?.length ? `- 标签：${project.tags.join('、')}` : '',
    '',
    `**进展记录（新→旧，共 ${updates.length} 条）**`,
    bullets(updates.slice(0, 20).map((item) => `${String(item.at).slice(0, 10)} [${KIND_LABELS[item.kind] ?? '记录'}] ${item.text}`)),
    '',
    `**未完成待跟进（${todos.length} 项）**`,
    bullets(todos.map((todo) => `${todo.title}${todo.dueDate ? `（截止 ${todo.dueDate}）` : ''}${todo.owner ? ` — ${todo.owner}` : ''}`)),
    '',
    `**已完成待跟进（${doneTodos.length} 项）**`,
    bullets(doneTodos.slice(0, 10).map((todo) => todo.title))
  ].filter((row) => row !== '').join('\n')
}

/** 全部需求按风险排序的 Markdown 摘要。 */
export function portfolioBrief(projects, today) {
  const sorted = sortByRisk(projects, today)
  if (sorted.length === 0) return '（工作台里还没有需求）'
  return sorted.map((item) => projectBrief(item.project, today)).join('\n\n')
}

function portfolioNumbers(projects, today) {
  const data = overview(projects, today)
  const modules = data.modules.filter((item) => item.total > 0)
    .map((item) => `- ${item.module}：${item.total} 个（进行中 ${item.active}、危险 ${item.danger}、待跟进 ${item.openTodos}）`)
  return [
    `- 需求总数：${data.total}`,
    `- 状态分布：${Object.entries(data.byStatus).map(([key, value]) => `${key} ${value}`).join('、') || '无'}`,
    `- 风险分布：${Object.entries(data.byRisk).map(([key, value]) => `${key} ${value}`).join('、') || '无'}`,
    '- 按模块：',
    bullets(modules)
  ].join('\n')
}

/**
 * 「让 Agent 分析进展」的提示词。
 * @param options - projects（全部需求）、project（可选，聚焦一个需求）、today。
 */
export function buildAnalysisPrompt({ projects = [], project = null, today }) {
  const scope = project ? '下面这一个需求' : '下面这些需求'
  const body = project ? projectBrief(project, today) : portfolioBrief(projects, today)
  return [
    `你是我的需求推进助理。今天是 ${today}。`,
    `请基于${scope}的登记数据做一次进展分析，不要编造数据里没有的事实；信息不足时明确说「数据不足」。`,
    '',
    '请按这个结构输出：',
    '1. 当前状态判断：哪些在正轨、哪些已经偏了，用一两句话给结论。',
    '2. 时间风险：逐个说明剩余时间与进度的匹配情况，标出最可能来不及的需求和判断依据。',
    '3. 阻塞与依赖：从进展记录里找出被人或外部条件卡住的点。',
    '4. 下一步动作：给我 3-5 条具体、可执行的动作，每条写明针对哪个需求、建议完成时间。',
    '5. 需要我补充的信息：列出你判断时需要但我没登记的内容。',
    '',
    '---',
    '',
    body
  ].join('\n')
}

const DOC_KINDS = {
  weekly: '周报',
  status: '需求状态汇报',
  risk: '风险清单',
  meeting: '会议纪要骨架'
}

export function docKinds() {
  return Object.entries(DOC_KINDS).map(([value, label]) => ({ value, label }))
}

/**
 * 生成一份文档草稿（Markdown）。
 * @param kind - weekly | status | risk | meeting。
 * @param options - projects、project（可选）、today。
 */
export function buildDocDraft(kind, { projects = [], project = null, today }) {
  const only = project ? [project] : projects
  const label = DOC_KINDS[kind] ?? DOC_KINDS.status
  const title = project ? project.name : '全部需求'

  if (kind === 'risk') {
    const rows = sortByRisk(only, today).map((item) => {
      const risk = item.risk
      const todo = openTodos(item.project)
      return `| ${item.project.name} | ${item.project.module || '其他项目'} | ${item.project.status || '进行中'} | ${clampProgress(item.project)}% | ${item.project.dueDate || '未排期'} | ${risk.label} — ${risk.detail} | ${todo.length} |`
    })
    return [
      `# 风险清单 · ${title}`,
      '',
      `生成时间：${today}`,
      '',
      '| 需求 | 模块 | 状态 | 进度 | 截止 | 风险 | 待跟进 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      rows.length > 0 ? rows.join('\n') : '| （暂无需求） |  |  |  |  |  |  |',
      '',
      '## 处理建议',
      bullets(sortByRisk(only, today).filter((item) => item.risk.rank <= 4)
        .map((item) => `${item.project.name}：${item.risk.detail}，建议先确认责任人并给出新的交付时间。`), '（当前没有需要升级处理的风险）')
    ].join('\n')
  }

  if (kind === 'weekly') {
    return [
      `# 周报 · 需求推进（${today}）`,
      '',
      '## 一、整体情况',
      portfolioNumbers(only, today),
      '',
      '## 二、本周进展',
      portfolioBrief(only, today),
      '',
      '## 三、下周计划',
      bullets(only.flatMap((item) => openTodos(item).slice(0, 3).map((todo) =>
        `${item.name}：${todo.title}${todo.dueDate ? `（${todo.dueDate} 前）` : ''}`)), '（待跟进清单为空，请补充下周计划）'),
      '',
      '## 四、需要协调',
      bullets(sortByRisk(only, today).filter((item) => ['overdue', 'blocked', 'urgent', 'slipping'].includes(item.risk.level))
        .map((item) => `${item.project.name}：${item.risk.detail}`), '（暂无）')
    ].join('\n')
  }

  if (kind === 'meeting') {
    return [
      `# 会议纪要 · ${title}（${today}）`,
      '',
      '参加会议：',
      '',
      '## 一、需求现状',
      portfolioBrief(only, today),
      '',
      '## 二、讨论与结论',
      '- （待补充）',
      '',
      '## 三、行动项',
      '| 事项 | 负责人 | 截止 | 状态 |',
      '| --- | --- | --- | --- |',
      bullets(only.flatMap((item) => openTodos(item).map((todo) =>
        `| ${item.name}：${todo.title} | ${todo.owner || '待定'} | ${todo.dueDate || '待定'} | 未开始 |`)), '| （待补充） |  |  |  |')
    ].join('\n')
  }

  const rows = sortByRisk(only, today).map((item) => {
    const latest = latestUpdate(item.project)
    return [
      `### ${item.project.name}`,
      `- 模块／状态：${item.project.module || '其他项目'}／${item.project.status || '进行中'}`,
      `- 进度：${clampProgress(item.project)}%，${formatRemaining(item.project.dueDate, today)}`,
      `- 时间风险：${item.risk.label} — ${item.risk.detail}`,
      `- 最近进展：${latest ? `${String(latest.at).slice(0, 10)} ${latest.text}` : '无记录'}`,
      `- 下一步：${openTodos(item.project).map((todo) => todo.title).slice(0, 3).join('；') || '待补充'}`
    ].join('\n')
  })
  return [
    `# 需求状态汇报 · ${title}（${today}）`,
    '',
    '## 概要',
    portfolioNumbers(only, today),
    '',
    '## 需求明细',
    rows.length > 0 ? rows.join('\n\n') : '（暂无需求）'
  ].join('\n')
}

/** 面板上的「交付给谁」提示语，作者文档与界面共用。 */
export function deliveryHint(kind) {
  return `已生成「${DOC_KINDS[kind] ?? '文档'}」草稿：可以直接复制到旁边的会话里让 Agent 补全，也可以下载成 Markdown。`
}
