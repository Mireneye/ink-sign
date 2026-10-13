// Clicking the toolbar icon opens the signing tab (reusing one if it's already open).
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("app.html");
  const [tab] = await chrome.tabs.query({ url });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});
