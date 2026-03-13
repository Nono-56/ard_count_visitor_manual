const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class SQLiteRepository {
  constructor(sqlitePath) {
    this.sqlitePath = sqlitePath;
    this.db = null;
  }

  async init() {
    const dir = path.dirname(this.sqlitePath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(this.sqlitePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS event_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        event_name TEXT NOT NULL,
        event_date TEXT NOT NULL,
        timezone TEXT NOT NULL,
        public_hostname TEXT NOT NULL,
        staff_password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );

      CREATE TABLE IF NOT EXISTS count_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('increment', 'correction')),
        delta INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );

      CREATE INDEX IF NOT EXISTS count_events_occurred_at_idx
      ON count_events (occurred_at DESC);

      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        noted_at TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );

      CREATE INDEX IF NOT EXISTS notes_noted_at_idx
      ON notes (noted_at DESC);
    `);
  }

  async close() {
    this.db?.close();
  }

  async syncSettings(settings) {
    const statement = this.db.prepare(`
      INSERT INTO event_settings (
        id, event_name, event_date, timezone, public_hostname, staff_password_hash, created_at, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE SET
        event_name = excluded.event_name,
        event_date = excluded.event_date,
        timezone = excluded.timezone,
        public_hostname = excluded.public_hostname,
        staff_password_hash = excluded.staff_password_hash,
        updated_at = CURRENT_TIMESTAMP
    `);
    statement.run(
      settings.eventName,
      settings.eventDate,
      settings.timezone,
      settings.publicHostname,
      settings.staffPasswordHash
    );
    return this.getSettings();
  }

  async getSettings() {
    const row = this.db.prepare(`
      SELECT id, event_name, event_date, timezone, public_hostname, staff_password_hash
      FROM event_settings
      WHERE id = 1
    `).get();
    return row ? mapSetting(row) : null;
  }

  async createCountEvent(input) {
    const result = this.db.prepare(`
      INSERT INTO count_events (occurred_at, kind, delta, reason)
      VALUES (?, ?, ?, ?)
    `).run(input.occurredAt, input.kind, input.delta, input.reason);

    const row = this.db.prepare(`
      SELECT id, occurred_at, kind, delta, reason, created_at
      FROM count_events
      WHERE id = ?
    `).get(result.lastInsertRowid);
    return mapCountEvent(row);
  }

  async listCountEvents(limit = 100) {
    const rows = this.db.prepare(`
      SELECT id, occurred_at, kind, delta, reason, created_at
      FROM count_events
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?
    `).all(limit);
    return rows.map(mapCountEvent);
  }

  async listAllCountEvents() {
    const rows = this.db.prepare(`
      SELECT id, occurred_at, kind, delta, reason, created_at
      FROM count_events
      ORDER BY occurred_at ASC, id ASC
    `).all();
    return rows.map(mapCountEvent);
  }

  async getCountEventById(id) {
    const row = this.db.prepare(`
      SELECT id, occurred_at, kind, delta, reason, created_at
      FROM count_events
      WHERE id = ?
    `).get(id);
    return row ? mapCountEvent(row) : null;
  }

  async updateCountEvent(id, input) {
    this.db.prepare(`
      UPDATE count_events
      SET occurred_at = ?, delta = ?, reason = ?
      WHERE id = ?
    `).run(input.occurredAt, input.delta, input.reason, id);
    return this.getCountEventById(id);
  }

  async deleteCountEvent(id) {
    const result = this.db.prepare(`
      DELETE FROM count_events
      WHERE id = ?
    `).run(id);
    return result.changes > 0;
  }

  async createNote(input) {
    const result = this.db.prepare(`
      INSERT INTO notes (noted_at, body)
      VALUES (?, ?)
    `).run(input.notedAt, input.body);

    const row = this.db.prepare(`
      SELECT id, noted_at, body, created_at
      FROM notes
      WHERE id = ?
    `).get(result.lastInsertRowid);
    return mapNote(row);
  }

  async listNotes(limit = 50) {
    const rows = this.db.prepare(`
      SELECT id, noted_at, body, created_at
      FROM notes
      ORDER BY noted_at DESC, id DESC
      LIMIT ?
    `).all(limit);
    return rows.map(mapNote);
  }

  async getDashboardData(timezone) {
    const events = await this.listAllCountEvents();
    const notes = await this.listNotes(20);
    const hourlyBuckets = buildHourlyBuckets(events, timezone).slice(0, 24);

    return {
      total: events.reduce((sum, event) => sum + event.delta, 0),
      hourlyBuckets,
      recentEvents: [...events].sort(compareByOccurredDesc).slice(0, 20),
      notes
    };
  }
}

function buildHourlyBuckets(events, timezone) {
  const map = new Map();

  for (const event of events) {
    const bucketKey = buildHourBucketKey(event.occurredAt, timezone);
    const current = map.get(bucketKey) || { hourBucket: bucketKey, label: bucketKey.replace('T', ' '), total: 0 };
    current.total += event.delta;
    map.set(bucketKey, current);
  }

  return [...map.values()].sort((a, b) => (a.hourBucket < b.hourBucket ? 1 : -1));
}

function buildHourBucketKey(value, timezone) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(value));

  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:00:00`;
}

function compareByOccurredDesc(a, b) {
  if (a.occurredAt === b.occurredAt) {
    return b.id - a.id;
  }
  return a.occurredAt < b.occurredAt ? 1 : -1;
}

function mapSetting(row) {
  return {
    id: row.id,
    eventName: row.event_name,
    eventDate: row.event_date,
    timezone: row.timezone,
    publicHostname: row.public_hostname,
    staffPasswordHash: row.staff_password_hash
  };
}

function mapCountEvent(row) {
  return {
    id: Number(row.id),
    occurredAt: row.occurred_at,
    kind: row.kind,
    delta: Number(row.delta),
    reason: row.reason,
    createdAt: row.created_at
  };
}

function mapNote(row) {
  return {
    id: Number(row.id),
    notedAt: row.noted_at,
    body: row.body,
    createdAt: row.created_at
  };
}

module.exports = {
  SQLiteRepository
};
