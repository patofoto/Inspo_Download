// On Tumblr pages: remembers the element last right-clicked, so "Download to Network Drive" can
// find the post that image belongs to (the context menu itself doesn't say which element).
document.addEventListener("contextmenu", (e) => {
  window.__inspoContextTarget = e.target;
}, true);
