export function createBoundedTtlStore({ maxEntries }) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('A bounded store requires a positive entry limit.');
  }

  const entries = new Map();

  function prune(now = Date.now()) {
    for (const [key, value] of entries) {
      if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= now) {
        entries.delete(key);
      }
    }
  }

  function get(key, now = Date.now()) {
    const value = entries.get(key);

    if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= now) {
      entries.delete(key);
      return null;
    }

    return value;
  }

  return {
    get size() {
      return entries.size;
    },
    get,
    set(key, value, now = Date.now()) {
      if (!entries.has(key) && entries.size >= maxEntries) {
        prune(now);

        if (entries.size >= maxEntries) {
          return false;
        }
      }

      entries.set(key, value);
      return true;
    },
    take(key, now = Date.now()) {
      const value = get(key, now);

      if (!value) {
        return null;
      }

      entries.delete(key);
      return value;
    },
    delete(key) {
      return entries.delete(key);
    },
    deleteWhere(predicate) {
      let deleted = 0;

      for (const [key, value] of entries) {
        if (predicate(value, key)) {
          entries.delete(key);
          deleted += 1;
        }
      }

      return deleted;
    },
    entries() {
      return [...entries.entries()];
    },
    prune
  };
}

export function createSlidingWindowLimiter({ limit, windowMs, maxKeys = 10_000 }) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) {
    throw new RangeError('A sliding-window limiter requires positive integer limits.');
  }

  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw new RangeError('A sliding-window limiter requires a positive key limit.');
  }

  const entries = new Map();
  let nextCapacityPruneAt = 0;

  function prune(now = Date.now()) {
    let earliestExpiry = Number.POSITIVE_INFINITY;

    for (const [key, timestamps] of entries) {
      const recent = timestamps.filter((timestamp) => now - timestamp < windowMs);

      if (recent.length === 0) {
        entries.delete(key);
      } else {
        entries.set(key, recent);
        earliestExpiry = Math.min(earliestExpiry, recent[0] + windowMs);
      }
    }

    nextCapacityPruneAt = Math.min(now + Math.min(windowMs, 1_000), earliestExpiry);
  }

  return {
    get size() {
      return entries.size;
    },
    consume(key, now = Date.now()) {
      const recent = (entries.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);

      if (recent.length >= limit) {
        entries.set(key, recent);
        return false;
      }

      if (!entries.has(key) && entries.size >= maxKeys) {
        if (now >= nextCapacityPruneAt) {
          prune(now);
        }

        if (entries.size >= maxKeys) {
          return false;
        }
      }

      recent.push(now);
      entries.set(key, recent);
      return true;
    },
    prune
  };
}

export function createFixedWindowLimiter({ limit, windowMs, maxKeys = 10_000 }) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) {
    throw new RangeError('A fixed-window limiter requires positive integer limits.');
  }

  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw new RangeError('A fixed-window limiter requires a positive key limit.');
  }

  const entries = new Map();
  let nextCapacityPruneAt = 0;

  function prune(now = Date.now()) {
    let earliestExpiry = Number.POSITIVE_INFINITY;

    for (const [key, entry] of entries) {
      if (now - entry.startedAt >= windowMs) {
        entries.delete(key);
      } else {
        earliestExpiry = Math.min(earliestExpiry, entry.startedAt + windowMs);
      }
    }

    nextCapacityPruneAt = Math.min(now + Math.min(windowMs, 1_000), earliestExpiry);
  }

  return {
    get size() {
      return entries.size;
    },
    consume(key, now = Date.now()) {
      const existing = entries.get(key);

      if (existing && now - existing.startedAt < windowMs) {
        if (existing.count >= limit) {
          return false;
        }

        existing.count += 1;
        return true;
      }

      if (!existing && entries.size >= maxKeys) {
        if (now >= nextCapacityPruneAt) {
          prune(now);
        }

        if (entries.size >= maxKeys) {
          return false;
        }
      }

      entries.set(key, { count: 1, startedAt: now });
      return true;
    },
    prune
  };
}
