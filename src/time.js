function formatDateTime(value, timeZone) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function formatHourBucket(value, timeZone) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit'
  }).format(new Date(value));
}

module.exports = {
  formatDateTime,
  formatHourBucket
};
