// Nothing to process yet. This timer only keeps the process alive; the BullMQ
// worker replaces it. 2 ** 31 - 1 is the longest delay a Node timer accepts.
const keepAlive = setInterval(() => {}, 2 ** 31 - 1);

console.log('worker running');

function shutdown(signal: NodeJS.Signals) {
  console.log(`worker received ${signal}, closing`);
  clearInterval(keepAlive);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
