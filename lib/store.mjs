import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { validateShot } from './catalog.mjs';

export class Store {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, shot_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_shot ON attempts(project_id,shot_id) WHERE status IN ('queued','uploading','submitting','unknown','generating','downloading','query_paused','artifact_missing','download_failed');
      CREATE TABLE IF NOT EXISTS assets(cache_key TEXT PRIMARY KEY, asset_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS presets(id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  projects() { return this.db.prepare('SELECT data FROM projects ORDER BY rowid DESC').all().map(row => JSON.parse(row.data)); }
  project(id) { const row = this.db.prepare('SELECT data FROM projects WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
  saveProject(project) { this.db.prepare('INSERT INTO projects VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(project.id, JSON.stringify(project)); }
  deleteProject(id) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM attempts WHERE project_id=?').run(id);
      for (const row of this.db.prepare('SELECT id,data FROM exports').all()) {
        if (JSON.parse(row.data).projectId === id) this.db.prepare('DELETE FROM exports WHERE id=?').run(row.id);
      }
      this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
    });
  }
  attempts() { return this.db.prepare('SELECT data FROM attempts ORDER BY rowid').all().map(row => JSON.parse(row.data)); }
  attempt(id) { const row = this.db.prepare('SELECT data FROM attempts WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
  saveAttempt(attempt) { this.db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(attempt.id, attempt.projectId, attempt.shotId, attempt.status, JSON.stringify(attempt)); }
  settings() { const row = this.db.prepare('SELECT data FROM settings WHERE id=1').get(); return { concurrency: 1, ...(row ? JSON.parse(row.data) : {}) }; }
  saveSettings(settings) { this.db.prepare('INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(settings)); }
  asset(key) { const row = this.db.prepare('SELECT * FROM assets WHERE cache_key=?').get(key); return row && row.created_at > Date.now() - 6 * 3600_000 ? row.asset_id : null; }
  saveAsset(key, id) { this.db.prepare('INSERT INTO assets VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET asset_id=excluded.asset_id,created_at=excluded.created_at').run(key, id, Date.now()); }
  clearAssets() { this.db.exec('DELETE FROM assets'); }
  presets() { return this.db.prepare('SELECT data FROM presets ORDER BY rowid DESC').all().map(row => JSON.parse(row.data)); }
  savePreset(value) { this.db.prepare('INSERT INTO presets VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id, JSON.stringify(value)); }
  deletePreset(id) { this.db.prepare('DELETE FROM presets WHERE id=?').run(id); }
  saveExport(value) { this.db.prepare('INSERT INTO exports VALUES(?,?)').run(value.id, JSON.stringify(value)); }
  close() { this.db.close(); }
}

export function importProject(result, name) {
  const permanentCodes = new Set(['LINK_NOT_IMPORTED', 'TEXT_READ_ERROR', 'MEDIA_READ_ERROR', 'EMPTY_MEDIA', 'PROMPT_COUNT', 'IGNORED_FILE']);
  return {
    id: randomUUID(), name: String(name || result.name).slice(0, 100), sourcePath: result.sourcePath,
    createdAt: new Date().toISOString(), revision: 1, paused: false,
    importIssues: result.issues,
    shots: result.shots.map(shot => {
      const mediaFiles = (shot.mediaFiles || shot.references).map(file => ({ ...file, id: randomUUID() }));
      return {
        id: randomUUID(), sequence: shot.sequence, name: shot.name, prompt: shot.prompt,
        parameters: { ...shot.parameters, generateType: null },
        mediaFiles,
        references: shot.references.map(ref => ({ ...ref, id: mediaFiles.find(file => file.relativePath === ref.relativePath).id })),
        notes: shot.notes, acceptedAttemptId: null, acceptedCandidate: null,
        importIssues: shot.issues.filter(item => permanentCodes.has(item.code)),
      };
    }),
  };
}

export function publicProject(project, attempts) {
  return { ...project, shots: project.shots.map(shot => {
    const history = attempts.filter(attempt => attempt.projectId === project.id && attempt.shotId === shot.id);
    return { ...shot, validation: validateShot(shot), latestAttemptId: history.at(-1)?.id || null };
  }) };
}
