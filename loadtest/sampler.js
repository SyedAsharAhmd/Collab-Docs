// Preloaded into a server process by the load tests (node --import). Prints the
// process's own CPU and memory once a second, so the server code stays unchanged.
let lastCpu = process.cpuUsage();
let lastTime = performance.now();

setInterval(() => {
  const now = performance.now();
  const cpu = process.cpuUsage(lastCpu);
  // Percent of one core. Node runs JavaScript on one thread, so ~100 means saturated.
  const cpuPercent = ((cpu.user + cpu.system) / 1000 / (now - lastTime)) * 100;
  lastCpu = process.cpuUsage();
  lastTime = now;
  const rssMb = process.memoryUsage().rss / 1048576;
  console.log(`LOADTEST_STATS ${JSON.stringify({ cpu: Math.round(cpuPercent), rssMb: Math.round(rssMb) })}`);
}, 1000).unref();
