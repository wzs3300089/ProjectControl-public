import { mountNoteForm } from './note-form.mjs';

async function request(options) {
  const response = await fetch('/api/note', { cache: 'no-store', ...options });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `请求失败 (${response.status})`);
  return value;
}

await mountNoteForm({
  readNote: () => request(),
  saveNote: input => request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
});
