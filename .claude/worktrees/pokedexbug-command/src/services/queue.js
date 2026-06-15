const MAX_QUEUE_SIZE = 50;

const queue = [];
let processing = false;

function enqueue(fn) {
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift();
    console.warn(`Issue queue full (${MAX_QUEUE_SIZE}). Dropped oldest item.`);
  }
  queue.push(fn);
  processNext();
}

async function processNext() {
  if (processing || queue.length === 0) return;
  processing = true;

  const fn = queue.shift();
  try {
    await fn();
  } catch (err) {
    console.error('Queue item failed:', err);
  }

  processing = false;
  processNext();
}

module.exports = { enqueue };