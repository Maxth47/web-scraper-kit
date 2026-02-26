let extractedData = [];

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "extraction-data") {
    extractedData = message.data;
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "get-data") {
    sendResponse({ data: extractedData });
    return true;
  }

  if (message.type === "clear-data") {
    extractedData = [];
    sendResponse({ success: true });
    return true;
  }

  // Relay messages from side panel to content script
  if (message.type === "start-extraction" || message.type === "stop-extraction") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].url && tabs[0].url.includes("google.com/maps")) {
        chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
          sendResponse(response || { success: true });
        });
      } else {
        sendResponse({ error: "Please navigate to Google Maps first." });
      }
    });
    return true;
  }
});
