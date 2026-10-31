import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export const saveSchema = z.object({
  text: z.string().max(100000),
  status: z.enum(['pending', 'completed']),
  revision: z.number().int().nonnegative(),
});

export function openStore(filename) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS note (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
      revision INTEGER NOT NULL,
      updatedAt TEXT
    );
    INSERT OR IGNORE INTO note VALUES (1, '', 'pending', 0, NULL);`);
  const read = () => ({ ...db.prepare('SELECT text, status, revision, updatedAt FROM note WHERE id = 1').get() });
  return {
    read,
    save(input) {
      const { text, status, revision } = saveSchema.parse(input);
      const row = db.prepare(`UPDATE note SET text = ?, status = ?, revision = revision + 1,
        updatedAt = ? WHERE id = 1 AND revision = ? RETURNING text, status, revision, updatedAt`)
        .get(text, status, new Date().toISOString(), revision);
      if (!row) throw new Error('内容已在另一个窗口更新。请重新打开弹窗，再保存修改。');
      return { ...row };
    },
    close: () => db.close(),
  };
}
