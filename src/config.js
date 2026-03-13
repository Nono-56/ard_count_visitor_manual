function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadConfig() {
  return {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: Number(process.env.PORT || 3000),
    sqlitePath: required('SQLITE_PATH'),
    appPassword: required('APP_PASSWORD'),
    sessionSecret: required('SESSION_SECRET'),
    eventName: process.env.EVENT_NAME || '来場者数管理',
    eventDate: process.env.EVENT_DATE || new Date().toISOString().slice(0, 10),
    eventEndDate: process.env.EVENT_END_DATE || process.env.EVENT_DATE || new Date().toISOString().slice(0, 10),
    eventTimezone: process.env.EVENT_TIMEZONE || 'Asia/Tokyo',
    publicHostname: process.env.PUBLIC_HOSTNAME || 'localhost'
  };
}

module.exports = {
  loadConfig
};
