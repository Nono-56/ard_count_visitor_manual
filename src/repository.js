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
        event_end_date TEXT NOT NULL DEFAULT '',
        timezone TEXT NOT NULL,
        public_hostname TEXT NOT NULL,
        day1_start TEXT NOT NULL DEFAULT '',
        day1_end TEXT NOT NULL DEFAULT '',
        day2_start TEXT NOT NULL DEFAULT '',
        day2_end TEXT NOT NULL DEFAULT '',
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
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        deleted_at TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS count_events_occurred_at_idx
      ON count_events (occurred_at DESC);
    `);
    ensureColumn(this.db, 'event_settings', 'event_end_date', `ALTER TABLE event_settings ADD COLUMN event_end_date TEXT NOT NULL DEFAULT ''`);
    ensureColumn(this.db, 'event_settings', 'day1_start', `ALTER TABLE event_settings ADD COLUMN day1_start TEXT NOT NULL DEFAULT ''`);
    ensureColumn(this.db, 'event_settings', 'day1_end', `ALTER TABLE event_settings ADD COLUMN day1_end TEXT NOT NULL DEFAULT ''`);
    ensureColumn(this.db, 'event_settings', 'day2_start', `ALTER TABLE event_settings ADD COLUMN day2_start TEXT NOT NULL DEFAULT ''`);
    ensureColumn(this.db, 'event_settings', 'day2_end', `ALTER TABLE event_settings ADD COLUMN day2_end TEXT NOT NULL DEFAULT ''`);
    ensureColumn(this.db, 'count_events', 'deleted_at', `ALTER TABLE count_events ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''`);
  }

  async close() {
    this.db?.close();
  }

  async syncSettings(settings) {
    const statement = this.db.prepare(`
      INSERT INTO event_settings (
        id, event_name, event_date, event_end_date, timezone, public_hostname,
        day1_start, day1_end, day2_start, day2_end,
        staff_password_hash, created_at, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE SET
        event_name = excluded.event_name,
        event_date = excluded.event_date,
        event_end_date = excluded.event_end_date,
        timezone = excluded.timezone,
        public_hostname = excluded.public_hostname,
        day1_start = excluded.day1_start,
        day1_end = excluded.day1_end,
        day2_start = excluded.day2_start,
        day2_end = excluded.day2_end,
        staff_password_hash = excluded.staff_password_hash,
        updated_at = CURRENT_TIMESTAMP
    `);
    statement.run(
      settings.eventName,
      settings.eventDate,
      settings.eventEndDate,
      settings.timezone,
      settings.publicHostname,
      settings.day1Start,
      settings.day1End,
      settings.day2Start,
      settings.day2End,
      settings.staffPasswordHash
    );
    return this.getSettings();
  }

  async getSettings() {
    const row = this.db.prepare(`
      SELECT id, event_name, event_date, event_end_date, timezone, public_hostname,
        day1_start, day1_end, day2_start, day2_end, staff_password_hash
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
      WHERE deleted_at = ''
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?
    `).all(limit);
    return rows.map(mapCountEvent);
  }

  async listAllCountEvents() {
    const rows = this.db.prepare(`
      SELECT id, occurred_at, kind, delta, reason, created_at
      FROM count_events
      WHERE deleted_at = ''
      ORDER BY occurred_at ASC, id ASC
    `).all();
    return rows.map(mapCountEvent);
  }

  async listAllCountEventsIncludingDeleted() {
    const rows = this.db.prepare(`
      SELECT id, occurred_at, kind, delta, reason, created_at, deleted_at
      FROM count_events
      ORDER BY occurred_at ASC, id ASC
    `).all();
    return rows.map(mapCountEvent);
  }

  async getCountEventById(id) {
    const row = this.db.prepare(`
      SELECT id, occurred_at, kind, delta, reason, created_at, deleted_at
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
      UPDATE count_events
      SET deleted_at = CURRENT_TIMESTAMP
      WHERE id = ? AND deleted_at = ''
    `).run(id);
    return result.changes > 0;
  }

  async restoreCountEvent(id) {
    const result = this.db.prepare(`
      UPDATE count_events
      SET deleted_at = ''
      WHERE id = ? AND deleted_at != ''
    `).run(id);
    return result.changes > 0;
  }

  async getDashboardData(settings, selectedDate) {
    const events = await this.listAllCountEvents();
    const allEvents = await this.listAllCountEventsIncludingDeleted();
    const availableDates = buildDateRange(settings.eventDate, settings.eventEndDate || settings.eventDate);
    const activeDate = availableDates.includes(selectedDate) ? selectedDate : availableDates[0];
    const selectedEvents = events.filter((event) => buildDateKey(event.occurredAt, settings.timezone) === activeDate);
    const hourlyBuckets = buildHourlyBuckets(selectedEvents, settings.timezone).slice(0, 24);
    const comparisonDates = availableDates.slice(0, 2);
    const hourlyComparison = buildHourlyComparison(events, settings.timezone, comparisonDates, 10, 21);
    const selectedLogEvents = allEvents
      .filter((event) => buildDateKey(event.occurredAt, settings.timezone) === activeDate)
      .sort(compareByOccurredDesc)
      .slice(0, 20);

    return {
      total: selectedEvents.reduce((sum, event) => sum + event.delta, 0),
      overallTotal: events.reduce((sum, event) => sum + event.delta, 0),
      availableDates,
      selectedDate: activeDate,
      dailyTotals: availableDates.map((date) => ({
        date,
        total: events
          .filter((event) => buildDateKey(event.occurredAt, settings.timezone) === date)
          .reduce((sum, event) => sum + event.delta, 0)
      })),
      hourlyBuckets,
      hourlyComparison,
      recentEvents: selectedLogEvents
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
  const values = getDateParts(value, timezone);
  return `${values.year}-${values.month}-${values.day}T${values.hour}:00:00`;
}

function buildDateKey(value, timezone) {
  const values = getDateParts(value, timezone);
  return `${values.year}-${values.month}-${values.day}`;
}

function buildHourlyComparison(events, timezone, dates, startHour = 0, endHour = 24) {
  const hours = Array.from({ length: endHour - startHour }, (_value, index) =>
    String(startHour + index).padStart(2, '0')
  );
  const series = dates.map((date, index) => {
    const totals = buildHourlyTotalsForDate(events, timezone, date, startHour, endHour);
    return {
      key: index === 0 ? 'day-a' : 'day-b',
      date,
      totals
    };
  });
  const maxTotal = Math.max(1, ...series.flatMap((entry) => entry.totals));
  const normalizedSeries = series.map((entry) => ({
    ...entry,
    percents: entry.totals.map((total) => Math.round((total / maxTotal) * 100))
  }));

  return { hours, series: normalizedSeries, maxTotal };
}

function buildHourlyTotalsForDate(events, timezone, dateKey, startHour = 0, endHour = 24) {
  const totals = Array.from({ length: endHour - startHour }, () => 0);
  for (const event of events) {
    if (buildDateKey(event.occurredAt, timezone) !== dateKey) {
      continue;
    }
    const parts = getDateParts(event.occurredAt, timezone);
    const hour = Number(parts.hour);
    if (Number.isInteger(hour) && hour >= startHour && hour < endHour) {
      totals[hour - startHour] += event.delta;
    }
  }
  return totals;
}

function getDateParts(value, timezone) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(value));

  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function buildDateRange(startDate, endDate) {
  const dates = [];
  const current = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}

function ensureColumn(db, tableName, columnName, sql) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(sql);
  }
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
    eventEndDate: row.event_end_date || row.event_date,
    timezone: row.timezone,
    publicHostname: row.public_hostname,
    day1Start: row.day1_start,
    day1End: row.day1_end,
    day2Start: row.day2_start,
    day2End: row.day2_end,
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
    createdAt: row.created_at,
    deletedAt: row.deleted_at || ''
  };
}

module.exports = {
  SQLiteRepository
};
