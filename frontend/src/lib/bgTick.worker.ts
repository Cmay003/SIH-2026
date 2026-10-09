// Dedicated-worker timer for useBackgroundRefetch. Timers in a page that has
// been hidden for a while are throttled by the browser (Chrome: about once a
// minute); timers inside a dedicated worker are not. Post a period in ms to
// start ticking, 0 to stop.
let id: ReturnType<typeof setInterval> | undefined;

self.onmessage = (e: MessageEvent<number>) => {
  clearInterval(id);
  id = undefined;
  if (e.data > 0) id = setInterval(() => self.postMessage("tick"), e.data);
};

export {}; // a module, not a global script
