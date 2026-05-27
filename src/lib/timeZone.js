const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function normalizeHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function isValidTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== "string") {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function getRequestTimeZone(req) {
  const requested =
    normalizeHeaderValue(req?.query?.timeZone) ||
    normalizeHeaderValue(req?.headers?.["x-time-zone"]) ||
    normalizeHeaderValue(req?.headers?.["x-user-time-zone"]) ||
    process.env.APP_TIME_ZONE ||
    "UTC";

  return isValidTimeZone(requested) ? requested : "UTC";
}

function getDateParts(date, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(date).map((part) => [part.type, part.value])
    );

    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
    };
  } catch {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
  }
}

function formatDateKey(date = new Date(), timeZone = "UTC") {
  const parts = getDateParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function getRequestDateKey(req, fallbackDate = new Date()) {
  const explicitDate =
    normalizeHeaderValue(req?.query?.date) ||
    normalizeHeaderValue(req?.query?.today);

  if (DATE_KEY_PATTERN.test(String(explicitDate || ""))) {
    return String(explicitDate).slice(0, 10);
  }

  return formatDateKey(fallbackDate, getRequestTimeZone(req));
}

function lastDayOfMonth(monthKey) {
  const [year, month] = String(monthKey).split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function getCurrentMonthRange(date = new Date(), timeZone = "UTC") {
  const today = formatDateKey(date, timeZone);
  const currentMonthKey = today.slice(0, 7);
  const monthRange = getMonthRange(currentMonthKey);

  return {
    today,
    currentMonthKey,
    start: monthRange.start,
    end: monthRange.end,
    year: Number(today.slice(0, 4)),
    month: Number(today.slice(5, 7)),
    day: Number(today.slice(8, 10)),
  };
}

function getMonthRange(monthKey) {
  return {
    start: `${monthKey}-01`,
    end: `${monthKey}-${pad2(lastDayOfMonth(monthKey))}`,
  };
}

function addMonthsToMonthKey(monthKey, delta) {
  const [year, month] = String(monthKey).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + Number(delta || 0), 1));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

module.exports = {
  addMonthsToMonthKey,
  formatDateKey,
  getCurrentMonthRange,
  getMonthRange,
  getRequestDateKey,
  getRequestTimeZone,
};
