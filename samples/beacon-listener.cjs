const http = require("http");
const fs = require("fs");
const path = require("path");
const logFile = path.join(process.env.TEMP, "beacon-log.txt");
http
  .createServer((req, res) => {
    const line = new Date().toISOString() + " BEACON HIT: " + req.url;
    console.log(line);
    try {
      fs.appendFileSync(logFile, line + "\n");
    } catch (e) {
      console.error("log write failed:", e.message);
    }
    res.writeHead(204);
    res.end();
  })
  .listen(19999, "127.0.0.1", () => console.log("listener up, logging to " + logFile));
