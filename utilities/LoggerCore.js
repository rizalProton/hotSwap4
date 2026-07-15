const fs = require('fs');
const path = require('path');
const logDir = 'log';
const FILE_LOGS_DISABLED = ['1', 'true', 'yes', 'on'].includes(String(process.env.DISABLE_FILE_LOGS || '').toLowerCase()) ||
  ['0', 'false', 'off'].includes(String(process.env.LOG_TO_FILE || '').toLowerCase());

const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // GMT+8 Singapore
function toLocalISOString(ms) {
  return new Date(ms + TZ_OFFSET_MS).toISOString().replace('Z', '+08:00');
}
// Create the log directory if it does not exist
if (!FILE_LOGS_DISABLED && !fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// prepare logging
let logger;
try {
  const { createLogger, format, transports } = require('winston');
  const { combine, timestamp, label, printf } = format;

  const tsFormat = () => toLocalISOString(Date.now());
  const myFormat = printf(info => {
    return `${info.timestamp} [${info.label}] ${info.level}: ${info.message}`;
  });

  logger = createLogger({
    silent: FILE_LOGS_DISABLED,
    format: combine(
      label({ label: '' }),
      timestamp({ format: tsFormat }),
      myFormat
    ),
    transports: FILE_LOGS_DISABLED ? [] : [
      // colorize the output to the console
      new transports.File({
        timestamp: tsFormat,
        filename: `${logDir}/error.log`,
        level: 'error'
      }),
      new transports.File({
        timestamp: tsFormat,
        filename: `${logDir}/combined.log`,
        level: 'info'
      }),
      new transports.File({
        filename: `${logDir}/debug.log`,
        timestamp: tsFormat,
        level: 'debug'
      })
    ]
  });
} catch (_error) {
  const writeFallback = (level, message) => {
    if (FILE_LOGS_DISABLED) return;
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
    const line = `${toLocalISOString(Date.now())} [] ${level}: ${message}\n`;
    const file = level === 'error' ? 'error.log' : level === 'debug' ? 'debug.log' : 'combined.log';
    fs.appendFileSync(path.join(logDir, file), line);
  };
  logger = {
    info: (message) => writeFallback('info', message),
    error: (message) => writeFallback('error', message),
    debug: (message) => writeFallback('debug', message),
    warn: (message) => writeFallback('warn', message),
  };
}

module.exports = logger;

function normalizeJson(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => (
    typeof item === 'bigint' ? item.toString() : item
  )));
}

function appendJsonLine(file, payload) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(normalizeJson(payload))}\n`);
}

async function timingTrace(event, fields = {}, options = {}) {
  const nowMs = Date.now();
  const payload = {
    event,
    at: toLocalISOString(nowMs),
    nowMs,
    ...fields,
  };

  if (options.connection && fields.slot == null) {
    try {
      payload.slot = await options.connection.getSlot(options.commitment || 'confirmed');
    } catch (error) {
      payload.slotError = error.message || String(error);
    }
  }

  const traceDisabled = options.file === false ||
    ['0', 'false', 'off'].includes(String(process.env.TIMING_TRACE_LOG || '').toLowerCase());
  const file = traceDisabled ? null : (options.file || path.join(logDir, 'timing_trace.jsonl'));
  appendJsonLine(file, payload);
  if (!FILE_LOGS_DISABLED) {
    logger.info(`[timing] ${event} ${JSON.stringify(normalizeJson(fields))}`);
  }
  return payload;
}

function createTimingTrace(context = {}, options = {}) {
  const startedAtMs = Date.now();
  let previousAtMs = startedAtMs;
  const events = [];

  return {
    events,
    async mark(event, fields = {}, markOptions = {}) {
      const nowMs = Date.now();
      const payload = await timingTrace(event, {
        ...context,
        ...fields,
        elapsedMs: nowMs - startedAtMs,
        sincePreviousMs: nowMs - previousAtMs,
      }, { ...options, ...markOptions });
      previousAtMs = nowMs;
      events.push(payload);
      return payload;
    },
    summary() {
      return {
        startedAt: toLocalISOString(startedAtMs),
        eventCount: events.length,
        elapsedMs: Date.now() - startedAtMs,
        events,
      };
    },
  };
}

module.exports.timingTrace = timingTrace;
module.exports.createTimingTrace = createTimingTrace;
