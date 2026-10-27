// On every site: ⌥ Option + right-click opens Chrome's own menu even where the site blocks
// right-clicking (YouPic, for one), so "Download to Network Drive" is there. Registered on the
// window before the page's own scripts run, it stops the page from seeing that right-click. A
// plain right-click is left alone, so sites with their own right-click menus keep them.
window.addEventListener("contextmenu", (e) => {
  if (!e.altKey) return;
  window.__inspoContextTarget = e.target;   // tumblr-context.js won't see this click
  e.stopImmediatePropagation();
}, true);
