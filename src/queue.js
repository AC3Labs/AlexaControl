'use strict';

// Runs outgoing Alexa calls one at a time with a minimum gap between them,
// and gives every call a timeout. Amazon rate limits this unofficial API, so
// a burst of button presses is spread out instead of sent all at once.

class TimeoutError extends Error {
  constructor(name, ms) {
    super(`${name} timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

class QueueFullError extends Error {
  constructor(max) {
    super(`Too many Alexa commands waiting (limit ${max}). Command dropped.`);
    this.name = 'QueueFullError';
  }
}

// Turns a Node style callback function into a promise with a timeout.
// A callback that arrives after the timeout is ignored. Some library methods
// never call back on bad input, which is why the timeout matters.
function callWithTimeout(name, fn, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TimeoutError(name, timeoutMs));
    }, timeoutMs);
    const done = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve(result);
    };
    try {
      fn(done);
    } catch (err) {
      done(err);
    }
  });
}

class RateLimitedQueue {
  constructor({ minGapMs = 350, maxPending = 50, defaultTimeoutMs = 15000 } = {}) {
    this.minGapMs = minGapMs;
    this.maxPending = maxPending;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.pending = [];
    this.running = false;
    this.lastFinished = 0;
    this.closed = false;
  }

  get size() {
    return this.pending.length;
  }

  // fn receives a Node style callback. Returns a promise for the result.
  add(name, fn, timeoutMs = this.defaultTimeoutMs) {
    if (this.closed) return Promise.reject(new Error('Queue is closed'));
    if (this.pending.length >= this.maxPending) return Promise.reject(new QueueFullError(this.maxPending));
    return new Promise((resolve, reject) => {
      this.pending.push({ name, fn, timeoutMs, resolve, reject });
      this.pump();
    });
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0 && !this.closed) {
        const wait = this.lastFinished + this.minGapMs - Date.now();
        if (wait > 0) await sleep(wait);
        const job = this.pending.shift();
        try {
          job.resolve(await callWithTimeout(job.name, job.fn, job.timeoutMs));
        } catch (err) {
          job.reject(err);
        } finally {
          this.lastFinished = Date.now();
        }
      }
    } finally {
      this.running = false;
    }
  }

  // Rejects everything still waiting. Used on shutdown and on logout.
  clear(reason = 'Queue cleared') {
    const jobs = this.pending.splice(0);
    for (const job of jobs) job.reject(new Error(reason));
  }

  close() {
    this.closed = true;
    this.clear('Plugin is shutting down');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { RateLimitedQueue, callWithTimeout, TimeoutError, QueueFullError, sleep };
