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

  app.get('/', requireAuth, async (_req, res) => {
    const settings = await repo.getSettings();
    const dashboard = await repo.getDashboardData(settings.timezone);
    const editingEvent = res.locals.editEventId ? await repo.getCountEventById(res.locals.editEventId) : null;
    res.render('index', {
      dashboard,
      settings,
      editingEvent
    });
  });

  app.get('/dashboard', requireAuth, async (_req, res) => {
    const settings = await repo.getSettings();
    const dashboard = await repo.getDashboardData(settings.timezone);
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
    const occurredAt = parseIsoOrNow(req.body.occurredAt);

    if (!Number.isInteger(delta) || delta === 0) {
      return handleInvalidRequest(req, res, '人数は 0 以外の整数で入力してください。');
    }
    if (!occurredAt) {
      return handleInvalidRequest(req, res, '日時の形式が不正です。');
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

  app.post('/notes', requireAuth, async (req, res) => {
    const body = String(req.body.body || '').trim();
    const notedAt = parseIsoOrNow(req.body.notedAt);

    if (!body) {
      return handleInvalidRequest(req, res, 'メモ内容を入力してください。');
    }
    if (!notedAt) {
      return handleInvalidRequest(req, res, '日時の形式が不正です。');
    }

    await repo.createNote({
      body,
      notedAt
    });

    return handleSuccess(req, res, 'メモを追加しました。');
  });

  app.get('/export.csv', requireAuth, async (_req, res) => {
    const settings = await repo.getSettings();
    const events = await repo.listAllCountEvents();
    const dashboard = await repo.getDashboardData(settings.timezone);
    const notes = await repo.listNotes(500);

    const lines = [
      `event_name,${escapeCsv(settings.eventName)}`,
      `event_date,${escapeCsv(settings.eventDate)}`,
      `timezone,${escapeCsv(settings.timezone)}`,
      '',
      'type,occurred_at,kind,delta,reason',
      ...events.map((event) =>
        ['count_event', event.occurredAt, event.kind, String(event.delta), event.reason].map(escapeCsv).join(',')
      ),
      '',
      'type,noted_at,body',
      ...notes.map((note) =>
        ['note', note.notedAt, note.body].map(escapeCsv).join(',')
      ),
      '',
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
    timezone: settings.timezone,
    publicHostname: settings.publicHostname
  };
}

function handleInvalidRequest(req, res, message) {
  if (req.accepts('html')) {
    setFlashCookie(res, { error: message }, {
      secure: req.secure || req.protocol === 'https' || process.env.NODE_ENV === 'production'
    });
    const editQuery = req.body.editEventId ? `?editEventId=${encodeURIComponent(req.body.editEventId)}` : '';
    return res.redirect('/' + editQuery + '#log');
  }
  return res.status(400).json({ error: message });
}

function handleSuccess(req, res, message) {
  if (req.accepts('html')) {
    setFlashCookie(res, { notice: message }, {
      secure: req.secure || req.protocol === 'https' || process.env.NODE_ENV === 'production'
    });
    return res.redirect('/#log');
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

module.exports = {
  createApp
};
