export function textLength(blocks) {
  let length = 0;
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') length += block.text.length;
  }
  return length;
}

// Never pass execution metadata, output text, or paths to the observer.
export function emitMetrics(ctx, config, event) {
  try {
    if (typeof config.onEvent === 'function') {
      const pending = config.onEvent(event);
      if (pending && typeof pending.then === 'function') Promise.resolve(pending).catch(() => {});
    } else {
      const pending = ctx.logger?.info?.('[tool-result-trimmer] metrics %o', event);
      if (pending && typeof pending.then === 'function') Promise.resolve(pending).catch(() => {});
    }
  } catch {
    // Observers are never allowed to affect a tool result.
  }
}
