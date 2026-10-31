export async function mountNoteForm({ readNote, saveNote }) {
  const note = document.querySelector('#note');
  const status = document.querySelector('#status');
  const save = document.querySelector('#save');
  const reload = document.querySelector('#reload');
  const feedback = document.querySelector('#feedback');
  let saved, busy = false;
  const selected = () => document.querySelector('input[name="status"]:checked').value;
  const dirty = () => !!saved && (note.value !== saved.text || selected() !== saved.status);
  function message(text, error = false) { feedback.textContent = text; feedback.classList.toggle('error', error); }
  function render() {
    document.querySelector('#count').textContent = `${note.value.length.toLocaleString()} 字`;
    const badge = document.querySelector('#badge');
    badge.textContent = selected() === 'completed' ? '完成' : '待完成';
    badge.classList.toggle('completed', selected() === 'completed');
    note.disabled = status.disabled = busy || !saved;
    save.disabled = busy || !dirty();
    reload.disabled = busy;
    save.textContent = busy ? '处理中…' : '保存';
  }
  function apply(value) {
    saved = value;
    note.value = value.text;
    document.querySelector(`input[value="${value.status}"]`).checked = true;
  }
  async function load(manual = false) {
    if (busy) return;
    if (dirty() && (!manual || !confirm('重新读取会丢弃尚未保存的修改，是否继续？'))) return;
    busy = true; render();
    try {
      apply(await readNote());
      message(saved.updatedAt ? `已读取 · ${new Date(saved.updatedAt).toLocaleString('zh-CN', { hour12: false })}` : '可以开始记录了');
    } catch (error) { message(`读取失败：${error.message}`, true); }
    finally { busy = false; render(); }
  }
  async function persist() {
    if (busy || !dirty()) return;
    const input = { text: note.value, status: selected(), revision: saved.revision };
    busy = true; render();
    try {
      apply(await saveNote(input));
      message(`已保存 · ${new Date(saved.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`);
    } catch (error) { message(`保存失败：${error.message}`, true); }
    finally { busy = false; render(); }
  }
  function edited() { render(); message(dirty() ? '有未保存的修改' : '内容未改动'); }
  note.addEventListener('input', edited);
  status.addEventListener('change', edited);
  save.addEventListener('click', persist);
  reload.addEventListener('click', () => load(true));
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); persist(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  window.addEventListener('focus', () => load());
  window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
  await load();
}
