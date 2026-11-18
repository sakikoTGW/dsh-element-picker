/**
 * Keeps the MV3 service worker warm enough to poll while a session is open.
 *
 * Chrome stops an idle service worker after ~30 s; a page that messages it every
 * 20 s keeps it alive. Nothing is read from the page — this only sends a ping.
 */
const PING_MS = 20000

setInterval(() => {
  try {
    chrome.runtime.sendMessage({ type: 'dsh-ref-alive' })
  } catch (error) {
    /* extension reloaded; the next page load re-registers */
  }
}, PING_MS)
