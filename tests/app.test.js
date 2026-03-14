const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../src/app');
const { createPasswordHash } = require('../src/auth');

class MemoryRepository {
  constructor() {
    this.settings = {
      eventName: 'テストイベント',
      eventDate: '2026-03-12',
      eventEndDate: '2026-03-13',
      timezone: 'Asia/Tokyo',
      publicHostname: 'example.com',
      staffPasswordHash: createPasswordHash('secret123')
    };
    this.events = [];
    this.eventId = 1;
  }

  async getSettings() {
    return this.settings;
  }

  async getDashboardData() {
    const total = this.events.reduce((sum, event) => sum + event.delta, 0);
    const availableDates = buildDateRange(this.settings.eventDate, this.settings.eventEndDate || this.settings.eventDate);
    const selectedDate = availableDates[0];
    const bucketMap = new Map();

    for (const event of this.events) {
      const bucket = new Date(event.occurredAt);
      bucket.setUTCMinutes(0, 0, 0);
      const key = bucket.toISOString();
      bucketMap.set(key, (bucketMap.get(key) || 0) + event.delta);
    }

    const hourlyComparison = buildHourlyComparison(this.events, availableDates);

    return {
      total,
      overallTotal: total,
      availableDates,
      selectedDate,
      dailyTotals: availableDates.map((date) => ({
        date,
        total
      })),
      hourlyBuckets: [...bucketMap.entries()]
        .map(([hourBucket, bucketTotal]) => ({ hourBucket, total: bucketTotal }))
        .sort((a, b) => (a.hourBucket < b.hourBucket ? 1 : -1)),
      hourlyComparison,
      recentEvents: [...this.events].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1)).slice(0, 20)
    };
  }

  async listCountEvents(limit = 200) {
    return [...this.events]
      .filter((event) => !event.deletedAt)
      .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
      .slice(0, limit);
  }

  async listAllCountEvents() {
    return [...this.events].filter((event) => !event.deletedAt);
  }

  async getCountEventById(id) {
    return this.events.find((event) => event.id === id) || null;
  }

  async updateCountEvent(id, input) {
    const event = this.events.find((item) => item.id === id);
    if (!event) {
      return null;
    }
    event.occurredAt = input.occurredAt;
    event.delta = input.delta;
    event.reason = input.reason;
    return event;
  }

  async deleteCountEvent(id) {
    const index = this.events.findIndex((event) => event.id === id);
    if (index === -1) {
      return false;
    }
    if (this.events[index].deletedAt) {
      return false;
    }
    this.events[index].deletedAt = new Date().toISOString();
    return true;
  }

  async restoreCountEvent(id) {
    const event = this.events.find((item) => item.id === id);
    if (!event || !event.deletedAt) {
      return false;
    }
    event.deletedAt = '';
    return true;
  }

  async createCountEvent(input) {
    const event = {
      id: this.eventId++,
      createdAt: new Date().toISOString(),
      deletedAt: '',
      ...input
    };
    this.events.push(event);
    return event;
  }
}

function startTestServer() {
  const repo = new MemoryRepository();
  const app = createApp({
    repo,
    config: {
      sessionSecret: 'session-secret',
      eventTimezone: 'Asia/Tokyo',
      eventName: 'テストイベント'
    }
  });

  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`
      });
    });
  });
}

async function stopTestServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function testLoginRejectsInvalidPassword() {
  const { server, baseUrl } = await startTestServer();

  try {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({ password: 'wrong' })
    });

    assert.equal(response.status, 401);
  } finally {
    await stopTestServer(server);
  }
}

async function testAuthenticatedUserFlow() {
  const { server, baseUrl } = await startTestServer();

  try {
    const loginResponse = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html'
      },
      body: 'password=secret123',
      redirect: 'manual'
    });

    assert.equal(loginResponse.status, 302);
    const cookie = loginResponse.headers.get('set-cookie');
    assert.ok(cookie);

    const createEvent = await fetch(`${baseUrl}/count-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        cookie
      },
      body: JSON.stringify({
        kind: 'increment',
        delta: 5,
        reason: '団体'
      })
    });
    assert.equal(createEvent.status, 201);

    const createCorrection = await fetch(`${baseUrl}/count-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        cookie
      },
      body: JSON.stringify({
        kind: 'correction',
        delta: -1,
        reason: '重複修正'
      })
    });
    assert.equal(createCorrection.status, 201);

    const dashboardResponse = await fetch(`${baseUrl}/dashboard`, {
      headers: {
        accept: 'application/json',
        cookie
      }
    });
    assert.equal(dashboardResponse.status, 200);

    const dashboard = await dashboardResponse.json();
    assert.equal(dashboard.total, 4);
    assert.equal(dashboard.recentEvents.length, 2);

    const tabletResponse = await fetch(`${baseUrl}/tablet`, {
      headers: {
        accept: 'text/html',
        cookie
      }
    });
    assert.equal(tabletResponse.status, 200);
    const tabletHtml = await tabletResponse.text();
    assert.match(tabletHtml, /Tablet/);
    assert.match(tabletHtml, /全画面表示/);

    const csvResponse = await fetch(`${baseUrl}/export.csv`, {
      headers: {
        cookie
      }
    });
    assert.equal(csvResponse.status, 200);

    const csv = await csvResponse.text();
    assert.match(csv, /count_event/);
    assert.match(csv, /hourly_bucket/);
  } finally {
    await stopTestServer(server);
  }
}

async function testLogEntriesCanBeUpdatedAndDeleted() {
  const { server, baseUrl } = await startTestServer();

  try {
    const loginResponse = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html'
      },
      body: 'password=secret123',
      redirect: 'manual'
    });

    const cookie = loginResponse.headers.get('set-cookie');
    assert.ok(cookie);

    const createEvent = await fetch(`${baseUrl}/count-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        cookie
      },
      body: JSON.stringify({
        delta: 4,
        reason: '初回'
      })
    });
    assert.equal(createEvent.status, 201);

    const eventsResponse = await fetch(`${baseUrl}/count-events`, {
      headers: {
        accept: 'application/json',
        cookie
      }
    });
    const eventsPayload = await eventsResponse.json();
    const eventId = eventsPayload.events[0].id;

    const updateResponse = await fetch(`${baseUrl}/count-events/${eventId}/update`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        cookie
      },
      body: JSON.stringify({
        delta: 2,
        reason: '修正後',
        occurredAt: '2026-03-13T10:30:00+09:00'
      })
    });
    assert.equal(updateResponse.status, 201);

    const updatedEventsResponse = await fetch(`${baseUrl}/count-events`, {
      headers: {
        accept: 'application/json',
        cookie
      }
    });
    const updatedEventsPayload = await updatedEventsResponse.json();
    assert.equal(updatedEventsPayload.events[0].delta, 2);
    assert.equal(updatedEventsPayload.events[0].reason, '修正後');

    const deleteResponse = await fetch(`${baseUrl}/count-events/${eventId}/delete`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        cookie
      }
    });
    assert.equal(deleteResponse.status, 201);

    const afterDeleteResponse = await fetch(`${baseUrl}/count-events`, {
      headers: {
        accept: 'application/json',
        cookie
      }
    });
    const afterDeletePayload = await afterDeleteResponse.json();
    assert.equal(afterDeletePayload.events.length, 0);

    const restoreResponse = await fetch(`${baseUrl}/count-events/${eventId}/restore`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        cookie
      }
    });
    assert.equal(restoreResponse.status, 201);

    const afterRestoreResponse = await fetch(`${baseUrl}/count-events`, {
      headers: {
        accept: 'application/json',
        cookie
      }
    });
    const afterRestorePayload = await afterRestoreResponse.json();
    assert.equal(afterRestorePayload.events.length, 1);
  } finally {
    await stopTestServer(server);
  }
}

async function testProtectedEndpointsRequireAuth() {
  const { server, baseUrl } = await startTestServer();

  try {
    const response = await fetch(`${baseUrl}/dashboard`, {
      headers: {
        accept: 'application/json'
      }
    });
    const tabletResponse = await fetch(`${baseUrl}/tablet`, {
      headers: {
        accept: 'text/html'
      },
      redirect: 'manual'
    });

    assert.equal(response.status, 401);
    assert.equal(tabletResponse.status, 302);
  } finally {
    await stopTestServer(server);
  }
}

async function run() {
  const tests = [
    ['login rejects invalid password', testLoginRejectsInvalidPassword],
    ['authenticated user flow', testAuthenticatedUserFlow],
    ['log entries can be updated and deleted', testLogEntriesCanBeUpdatedAndDeleted],
    ['protected endpoints require auth', testProtectedEndpointsRequireAuth]
  ];

  for (const [name, fn] of tests) {
    await fn();
    console.log(`PASS ${name}`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

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

function buildHourlyComparison(events, availableDates) {
  const hours = Array.from({ length: 24 }, (_value, index) => String(index).padStart(2, '0'));
  const series = availableDates.slice(0, 2).map((date, index) => {
    const totals = Array.from({ length: 24 }, () => 0);
    for (const event of events) {
      const eventDate = new Date(event.occurredAt).toISOString().slice(0, 10);
      if (eventDate !== date) {
        continue;
      }
      const hour = new Date(event.occurredAt).getUTCHours();
      totals[hour] += event.delta;
    }
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
