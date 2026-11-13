console.log("1. script started");

import("./src/config")
  .then(() => console.log("2. config loaded"))
  .then(() => import("./src/app"))
  .then((m) => {
    console.log("3. app module loaded");
    const server = m.createApp().listen(5000, (err?: Error) => {
      console.log("4. listen callback:", err ?? "listening on 5000");
    });
    server.on("error", (e) => console.log("server error:", e));
    setTimeout(() => console.log("5. still alive after 3s"), 3000);
  })
  .catch((e) => console.log("FAILED:", e));