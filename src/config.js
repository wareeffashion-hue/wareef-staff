const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  dbPath: env.DB_PATH || './data/staff.db',
  secureCookies: env.SECURE_COOKIES === '1',
  // Saudi Arabia has no daylight saving, so a fixed offset is exact.
  tzOffsetMinutes: parseOffset(env.TZ_OFFSET || '+03:00'),
  adminUsername: (env.ADMIN_USERNAME || 'admin').trim().toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD || '',
  adminName: env.ADMIN_NAME || 'المدير',
  backupKeepDays: Number(env.BACKUP_KEEP_DAYS || 30),
};

function parseOffset(s) {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(s).trim());
  if (!m) return 180;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

export const MIN = 60_000;
export const DAY = 86_400_000;
