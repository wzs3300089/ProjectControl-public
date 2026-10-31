import { createHash } from 'node:crypto';

export const assetPath = 'webview/assets/app-primary-83c2b5ae05b6.js';
export const sourceHash = '95df06e345fff6467c417120f0c8aca01323fc25f3451418bcb586226ec6bf61';
export const originalHandler = 'e=>{if(p){Ox(t,c,{state:{...e,sidebarPrimaryContent:!0,entrypoint:`global`,mcpAppDeepLink:{path:[],query:[]}}});return}Ox(t,c,{state:{...e,sidebarPrimaryContent:!0}})}';

// These names refer to the verified closure in this exact installed client build:
// d = entry source, t = client scope, hh = existing MCP tool caller,
// Ar = toast store, Ox = existing navigation function.
export const popupGuard = `if(d?.hostId===\`local\`&&d?.server===\`project_control\`&&d?.pluginId===\`project-control-test@project-control-local\`){
void hh(t,d.hostId,d.server,\`project_control_open\`,{}).then(r=>{
if(r?.isError)throw Error(\`项目便签工具返回错误\`);
if(r?.structuredContent?.window!==\`open_requested\`)throw Error(\`项目便签服务需要重新加载\`);
}).catch(()=>{t.get(Ar).danger(\`无法打开项目便签浮窗，请重新加载项目便签插件后重试。\`)});
return;
}`;
export const patchedHandler = 'e=>{' + popupGuard + originalHandler.slice('e=>{'.length);

export function patchAsset(source) {
  const actual = createHash('sha256').update(source).digest('hex');
  if (actual !== sourceHash) throw new Error(`客户端版本或内容不匹配，停止修改：${actual}`);
  const text = source.toString('utf8');
  const marker = `onSelect:${originalHandler},quickAction:v,alwaysNavigate:p`;
  if (text.split(marker).length !== 2) throw new Error('入口处理函数不是唯一匹配，停止修改');
  return Buffer.from(text.replace(marker, `onSelect:${patchedHandler},quickAction:v,alwaysNavigate:p`));
}
