const express = require('express');
const path = require('node:path');

const {
  clearSessionCookie,
  consumeFlashCookie,
  requireAuth,
  sessionMiddleware,
  setSessionCookie,
  setFlashCookie,
  verifyPassword
} = require('./auth');
const { formatDateTime } = require('./time');

function createApp({ repo, config }) {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(sessionMiddleware(config.sessionSecret));

  app.use(async (req, res, next) => {
    try {
      const settings = await repo.getSettings();
      const flash = consumeFlashCookie(req, res, {
        secure: config.nodeEnv === 'production'
      }) || {};
      res.locals.settings = settings;
      res.locals.isAuthenticated = Boolean(req.session);
      res.locals.error = flash.error || '';
      res.locals.notice = flash.notice || '';
      res.locals.selectedDate = String(req.query.day || '');
      res.locals.editEventId = Number.parseInt(String(req.query.editEventId || ''), 10) || null;
      res.locals.formatDateTime = (value) => formatDateTime(value, settings?.timezone || config.eventTimezone);
      res.locals.formatDateTimeInput = (value) => formatDateTimeInput(value, settings?.timezone || config.eventTimezone);
      res.locals.describeDelta = describeDelta;
      next();
    } catch (error) {
      next(error);
    }
  });

  app.get('/health', async (_req, res) => {
    const settings = await repo.getSettings();
    res.json({ ok: true, eventName: settings?.eventName || config.eventName });
  });

  app.get('/login', (req, res) => {
    if (req.session) {
      return res.redirect('/');
    }

    return res.render('login');
  });

  app.post('/auth/login', async (req, res) => {
    const settings = await repo.getSettings();
    const password = String(req.body.password || '');

    if (!settings || !verifyPassword(password, settings.staffPasswordHash)) {
      if (req.accepts('html')) {
        setFlashCookie(res, { error: 'パスワードが正しくありません。' }, {
          secure: config.nodeEnv === 'production'
        });
        return res.redirect('/login');
      }
      return res.status(401).json({ error: 'Invalid password' });
    }

    setSessionCookie(res, config.sessionSecret, {
      secure: config.nodeEnv === 'production'
    });

    if (req.accepts('html')) {
      setFlashCookie(res, { notice: 'ログインしました。' }, {
        secure: config.nodeEnv === 'production'
      });
      return res.redirect('/');
    }
    return res.status(200).json({ ok: true });
  });

  app.post('/auth/logout', (req, res) => {
    clearSessionCookie(res, {
      secure: config.nodeEnv === 'production'
    });
    setFlashCookie(res, { notice: 'ログアウトしました。' }, {
      secure: config.nodeEnv === 'production'
    });
    res.redirect('/login');
  });

  app.get('/', requireAuth, async (req, res) => {
    const settings = await repo.getSettings();
    const selectedDate = resolveSelectedDate(req.query.day, settings);
    const dashboard = await repo.getDashboardData(settings, selectedDate);
    const editingEvent = res.locals.editEventId ? await repo.getCountEventById(res.locals.editEventId) : null;
    res.render('index', {
      dashboard,
      settings,
      editingEvent
    });
  });

  app.get('/dashboard', requireAuth, async (req, res) => {
    const settings = await repo.getSettings();
    const selectedDate = resolveSelectedDate(req.query.day, settings);
    const dashboard = await repo.getDashboardData(settings, selectedDate);
    res.json({
      settings: sanitizeSettings(settings),
      ...dashboard
    });
  });

  app.get('/count-events', requireAuth, async (_req, res) => {
    const events = await repo.listCountEvents(200);
    res.json({ events });
  });

  app.post('/count-events', requireAuth, async (req, res) => {
    const delta = Number.parseInt(String(req.body.delta || ''), 10);
    const reason = String(req.body.reason || '').trim();
    const occurredAt = new Date().toISOString();

    if (!Number.isInteger(delta) || delta === 0) {
      return handleInvalidRequest(req, res, '人数は 0 以外の整数で入力してください。');
    }
    await repo.createCountEvent({
      kind: 'increment',
      delta,
      reason,
      occurredAt
    });

    return handleSuccess(req, res, '人数を記録しました。');
  });

  app.post('/count-events/:id/update', requireAuth, async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const delta = Number.parseInt(String(req.body.delta || ''), 10);
    const reason = String(req.body.reason || '').trim();
    const occurredAt = parseIsoOrNow(req.body.occurredAt);

    if (!Number.isInteger(id)) {
      return handleInvalidRequest(req, res, '対象の記録が見つかりません。');
    }
    if (!Number.isInteger(delta) || delta === 0) {
      return handleInvalidRequest(req, res, '人数は 0 以外の整数で入力してください。');
    }
    if (!occurredAt) {
      return handleInvalidRequest(req, res, '日時の形式が不正です。');
    }

    const existing = await repo.getCountEventById(id);
    if (!existing) {
      return handleInvalidRequest(req, res, '対象の記録が見つかりません。');
    }
    if (existing.deletedAt) {
      return handleInvalidRequest(req, res, '削除済みの記録は編集できません。');
    }

    await repo.updateCountEvent(id, {
      occurredAt,
      delta,
      reason
    });

    return handleSuccess(req, res, '操作ログを更新しました。');
  });

  app.post('/count-events/:id/delete', requireAuth, async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return handleInvalidRequest(req, res, '対象の記録が見つかりません。');
    }

    const deleted = await repo.deleteCountEvent(id);
    if (!deleted) {
      return handleInvalidRequest(req, res, '対象の記録が見つかりません。');
    }

    return handleSuccess(req, res, '操作ログを削除しました。');
  });

  app.post('/count-events/:id/restore', requireAuth, async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return handleInvalidRequest(req, res, '対象の記録が見つかりません。');
    }

    const restored = await repo.restoreCountEvent(id);
    if (!restored) {
      return handleInvalidRequest(req, res, '対象の記録が見つかりません。');
    }

    return handleSuccess(req, res, '操作ログを復元しました。');
  });

  app.get('/export.csv', requireAuth, async (_req, res) => {
    const settings = await repo.getSettings();
    const events = await repo.listAllCountEvents();
    const dashboard = await repo.getDashboardData(settings, settings.eventDate);

    const lines = [
      `event_name,${escapeCsv(settings.eventName)}`,
      `event_date,${escapeCsv(settings.eventDate)}`,
      `timezone,${escapeCsv(settings.timezone)}`,
      '',
      'type,occurred_at,kind,delta,reason',
      ...events.map((event) =>
        ['count_event', event.occurredAt, event.kind, String(event.delta), event.reason].map(escapeCsv).join(',')
      ),
      'type,hour_bucket,total',
      ...dashboard.hourlyBuckets.map((bucket) =>
        ['hourly_bucket', bucket.hourBucket, String(bucket.total)].map(escapeCsv).join(',')
      )
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="visitor-report.csv"');
    res.send(lines.join('\n'));
  });

  app.use((error, req, res, _next) => {
    console.error(error);
    if (req.accepts('html')) {
      return res.status(500).render('error', { error });
    }
    return res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
}

function sanitizeSettings(settings) {
  return {
    eventName: settings.eventName,
    eventDate: settings.eventDate,
    eventEndDate: settings.eventEndDate,
    timezone: settings.timezone,
    publicHostname: settings.publicHostname,
    day1Start: settings.day1Start,
    day1End: settings.day1End,
    day2Start: settings.day2Start,
    day2End: settings.day2End
  };
}

function handleInvalidRequest(req, res, message) {
  if (req.accepts('html')) {
    setFlashCookie(res, { error: message }, {
      secure: req.secure || req.protocol === 'https' || process.env.NODE_ENV === 'production'
    });
    return res.redirect(buildRedirectTarget(req));
  }
  return res.status(400).json({ error: message });
}

function handleSuccess(req, res, message) {
  if (req.accepts('html')) {
    setFlashCookie(res, { notice: message }, {
      secure: req.secure || req.protocol === 'https' || process.env.NODE_ENV === 'production'
    });
    return res.redirect(buildRedirectTarget(req));
  }
  return res.status(201).json({ ok: true, message });
}

function escapeCsv(value) {
  const text = String(value ?? '');
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function parseIsoOrNow(value) {
  if (!value) {
    return new Date().toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function formatDateTimeInput(value, timeZone) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(value));
  const entries = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${entries.year}-${entries.month}-${entries.day}T${entries.hour}:${entries.minute}`;
}

function describeDelta(delta) {
  if (delta > 0) {
    return `${delta}人`;
  }
  return `${Math.abs(delta)}人減`;
}

function resolveSelectedDate(value, settings) {
  const start = settings.eventDate;
  const end = settings.eventEndDate || settings.eventDate;
  const availableDates = [];
  const current = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);

  while (current <= endDate) {
    availableDates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  if (availableDates.includes(value)) {
    return value;
  }
  return availableDates[0];
}

function buildDashboardQuery(selectedDate, editEventId) {
  const params = new URLSearchParams();
  if (selectedDate) {
    params.set('day', selectedDate);
  }
  if (editEventId) {
    params.set('editEventId', editEventId);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

function buildRedirectTarget(req) {
  const base = '/' + buildDashboardQuery(req.body.selectedDate, req.body.editEventId);
  const returnToLog = String(req.body.returnToLog || '') === '1';
  return returnToLog ? `${base}#log` : base;
}

module.exports = {
  createApp
};
