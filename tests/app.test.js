const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../src/app');
const { createPasswordHash } = require('../src/auth');

class MemoryRepository {
  constructor() {
    this.settings = {
      eventName: 'テストイベント',
      eventDate: '2026-03-12',
      timezone: 'Asia/Tokyo',
      publicHostname: 'example.com',
      staffPasswordHash: createPasswordHash('secret123')
    };
    this.events = [];
    this.notes = [];
    this.eventId = 1;
    this.noteId = 1;
  }

  async getSettings() {
    return this.settings;
  }

  async getDashboardData() {
    const total = this.events.reduce((sum, event) => sum + event.delta, 0);
    const bucketMap = new Map();

    for (const event of this.events) {
      const bucket = new Date(event.occurredAt);
      bucket.setUTCMinutes(0, 0, 0);
      const key = bucket.toISOString();
      bucketMap.set(key, (bucketMap.get(key) || 0) + event.delta);
    }

    return {
      total,
      hourlyBuckets: [...bucketMap.entries()]
        .map(([hourBucket, bucketTotal]) => ({ hourBucket, total: bucketTotal }))
        .sort((a, b) => (a.hourBucket < b.hourBucket ? 1 : -1)),
      recentEvents: [...this.events].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1)).slice(0, 20),
      notes: [...this.notes].sort((a, b) => (a.notedAt < b.notedAt ? 1 : -1)).slice(0, 20)
    };
  }

  async listCountEvents(limit = 200) {
    return [...this.events].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1)).slice(0, limit);
  }

  async listAllCountEvents() {
    return [...this.events];
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
    this.events.splice(index, 1);
    return true;
  }

  async listNotes(limit = 500) {
    return [...this.notes].sort((a, b) => (a.notedAt < b.notedAt ? 1 : -1)).slice(0, limit);
  }

  async createCountEvent(input) {
    const event = {
      id: this.eventId++,
      createdAt: new Date().toISOString(),
      ...input
    };
    this.events.push(event);
    return event;
  }

  async createNote(input) {
    const note = {
      id: this.noteId++,
      createdAt: new Date().toISOString(),
      ...input
    };
    this.notes.push(note);
    return note;
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

    const createNote = await fetch(`${baseUrl}/notes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        cookie
      },
      body: JSON.stringify({
        body: '入口が混雑'
      })
    });
    assert.equal(createNote.status, 201);

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
    assert.equal(dashboard.notes.length, 1);

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

    assert.equal(response.status, 401);
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
