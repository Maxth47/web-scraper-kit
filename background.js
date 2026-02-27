let extractedData = [];

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// ── Debugger-based scroll for Google Maps ──
// Google Maps ignores programmatic scroll — only trusted input events load more results.
// Google Maps uses virtual scrolling — only ~8 items in DOM at any time.
// We must extract data DURING scrolling to capture all items.

function sendDebuggerCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

function detachDebugger(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      resolve();
    });
  });
}

// The extraction function that runs inside the page context.
// It extracts data from all currently visible .Nv2PK items.
function extractVisibleItems() {
  const feed = document.querySelector('div[role="feed"]');
  if (!feed) return { items: [], ended: false };

  const cards = feed.querySelectorAll(".Nv2PK");
  const text = feed.textContent || "";
  const ended =
    text.includes("You've reached the end") ||
    text.includes("No more results");

  const items = [];

  for (const item of cards) {
    const data = {
      name: "",
      address: "",
      phone: "",
      website: "",
      rating: "",
      reviewCount: "",
      category: "",
      hours: "",
      priceLevel: "",
    };

    // Name
    const nameEl =
      item.querySelector(".fontHeadlineSmall") ||
      item.querySelector('[class*="fontHead"]');
    if (nameEl) {
      data.name = nameEl.textContent?.trim() || "";
    }
    if (!data.name) {
      const link =
        item.querySelector("a.hfpxzc") ||
        item.querySelector('a[href*="/maps/place/"]');
      if (link) {
        data.name = link.getAttribute("aria-label") || "";
      }
    }

    // Skip items with no name
    if (!data.name) continue;

    // Rating & Review Count
    const ratingImg = item.querySelector('span[role="img"]');
    if (ratingImg) {
      const ariaLabel = ratingImg.getAttribute("aria-label") || "";
      const ratingMatch = ariaLabel.match(/([\d.]+)\s*star/i);
      if (ratingMatch) data.rating = ratingMatch[1];
      const reviewMatch = ariaLabel.match(/([\d,]+)\s*[Rr]eview/);
      if (reviewMatch) data.reviewCount = reviewMatch[1].replace(/,/g, "");
    }

    if (!data.rating) {
      const spans = item.querySelectorAll("span");
      for (const span of spans) {
        const t = span.textContent?.trim() || "";
        if (/^\d\.\d$/.test(t)) {
          data.rating = t;
          break;
        }
      }
    }

    if (!data.reviewCount) {
      const allText = item.textContent || "";
      const parenMatch = allText.match(/\(([\d,]+)\)/);
      if (parenMatch) data.reviewCount = parenMatch[1].replace(/,/g, "");
    }

    // Parse W4Efsd info sections
    const w4Sections = item.querySelectorAll(".W4Efsd");
    const infoLines = [];

    w4Sections.forEach((section) => {
      const nested = section.querySelector(":scope > .W4Efsd");
      const target = nested || section;
      const spans = target.querySelectorAll(":scope > span");
      const parts = [];
      spans.forEach((span) => {
        const text = span.textContent?.trim();
        if (text && text !== "·" && text !== "· " && text.length > 0) {
          parts.push(text.replace(/^·\s*/, "").trim());
        }
      });
      if (parts.length > 0) {
        infoLines.push(parts);
      }
    });

    const seen = new Set();
    for (const parts of infoLines) {
      const lineText = parts.join(" ");
      if (seen.has(lineText)) continue;
      seen.add(lineText);
      if (/^\d\.\d.*\(\d/.test(lineText)) continue;

      for (const part of parts) {
        if (!part || part.length === 0) continue;

        if (
          !data.hours &&
          /\b(open|closed|opens?|closes?|24\s*hours?)\b/i.test(part)
        ) {
          data.hours = part.trim();
          continue;
        }

        if (!data.priceLevel && /^\$/.test(part)) {
          data.priceLevel = part;
          continue;
        }

        if (
          !data.category &&
          part.length < 35 &&
          !/\d/.test(part) &&
          !part.includes(",") &&
          !/\b(open|closed|closes?|opens?)\b/i.test(part)
        ) {
          data.category = part;
          continue;
        }

        if (
          !data.address &&
          (/\d+\s+\w/.test(part) || part.includes(",")) &&
          part.length > 5 &&
          part.length < 120 &&
          !/star|review|\(\d/i.test(part)
        ) {
          data.address = part;
          continue;
        }
      }
    }

    // Website
    const allLinks = item.querySelectorAll("a[href]");
    for (const link of allLinks) {
      const href = link.href || "";
      if (
        href &&
        !href.includes("google.com") &&
        !href.includes("google.") &&
        !href.includes("gstatic") &&
        !href.includes("googleapis") &&
        !href.startsWith("javascript") &&
        !href.startsWith("data:")
      ) {
        data.website = href;
        break;
      }
    }

    // Phone
    const telLink = item.querySelector('a[href^="tel:"]');
    if (telLink) {
      data.phone = telLink.href.replace("tel:", "").trim();
    }

    items.push(data);
  }

  return { items, ended };
}

let shouldStopScroll = false;

async function performScrollAndExtract(tabId) {
  try {
    await attachDebugger(tabId);
  } catch (e) {
    if (!e.message.includes("Another debugger is already attached")) {
      throw e;
    }
  }

  try {
    // Get the scroll target coordinates — the center of the results panel
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const feed = document.querySelector('div[role="feed"]');
        if (!feed) return null;
        const rect = feed.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      },
    });

    const coords = result?.result;
    if (!coords) {
      await detachDebugger(tabId);
      return { error: "Could not find results panel." };
    }

    // Accumulate all unique items by name
    const allItems = new Map();
    let stableRounds = 0;
    const maxStableRounds = 5;
    let previousSize = 0;

    while (stableRounds < maxStableRounds && !shouldStopScroll) {
      // Extract currently visible items
      const [extractResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractVisibleItems,
      });

      const { items, ended } = extractResult?.result || {
        items: [],
        ended: false,
      };

      // Merge into accumulated results (keyed by name to deduplicate)
      for (const item of items) {
        if (item.name && !allItems.has(item.name)) {
          allItems.set(item.name, item);
        }
      }

      // Report progress
      chrome.runtime
        .sendMessage({
          type: "progress",
          status: "scrolling",
          count: allItems.size,
          total: 0,
        })
        .catch(() => {});

      if (ended) break;

      // Check if we're still finding new items
      if (allItems.size === previousSize) {
        stableRounds++;
      } else {
        stableRounds = 0;
      }
      previousSize = allItems.size;

      // Synthesize a real scroll gesture via the debugger
      await sendDebuggerCommand(tabId, "Input.synthesizeScrollGesture", {
        x: coords.x,
        y: coords.y,
        yDistance: -600,
        speed: 800,
        repeatCount: 1,
        repeatDelayMs: 100,
      });

      // Wait for content to load
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 500));
    }

    // One final extraction after the last scroll
    if (!shouldStopScroll) {
      const [finalExtract] = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractVisibleItems,
      });
      const { items: finalItems } = finalExtract?.result || { items: [] };
      for (const item of finalItems) {
        if (item.name && !allItems.has(item.name)) {
          allItems.set(item.name, item);
        }
      }
    }

    await detachDebugger(tabId);
    return { data: Array.from(allItems.values()) };
  } catch (e) {
    await detachDebugger(tabId).catch(() => {});
    throw e;
  }
}

// ── Message handling ──

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

  // Optimize fetch: scroll + extract only (no click-through enrichment)
  if (message.type === "optimize-fetch") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.url || !tab.url.includes("google.com/maps")) {
        sendResponse({ error: "Please navigate to Google Maps first." });
        return;
      }

      sendResponse({ success: true });
      shouldStopScroll = false;

      try {
        const result = await performScrollAndExtract(tab.id);

        if (result.error) {
          chrome.runtime
            .sendMessage({ type: "progress", status: "error", count: 0, total: 0 })
            .catch(() => {});
          return;
        }

        extractedData = result.data || [];

        if (shouldStopScroll) {
          chrome.runtime
            .sendMessage({
              type: "progress",
              status: "stopped",
              count: extractedData.length,
              total: extractedData.length,
            })
            .catch(() => {});
        } else {
          chrome.runtime
            .sendMessage({
              type: "progress",
              status: "optimize-done",
              count: extractedData.length,
              total: extractedData.length,
            })
            .catch(() => {});
        }
      } catch (e) {
        console.error("Optimize fetch failed:", e);
        chrome.runtime
          .sendMessage({ type: "progress", status: "error", count: 0, total: 0 })
          .catch(() => {});
      }
    });
    return true;
  }

  // Main extraction: send fetched data to content script for click-through enrichment
  if (message.type === "start-extraction") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.url || !tab.url.includes("google.com/maps")) {
        sendResponse({ error: "Please navigate to Google Maps first." });
        return;
      }

      const dataToEnrich = extractedData && extractedData.length > 0
        ? extractedData
        : [];

      if (dataToEnrich.length === 0) {
        sendResponse({ error: "No fetched listings. Run Fetch Listings first." });
        return;
      }

      // Re-inject content script in case context was invalidated, then send data
      chrome.scripting.executeScript(
        { target: { tabId: tab.id }, files: ["content.js"] },
        () => {
          chrome.tabs.sendMessage(tab.id, { type: "enrich-data", data: dataToEnrich }, (response) => {
            if (chrome.runtime.lastError) {
              sendResponse({ error: "Cannot connect to page. Refresh Google Maps and try again." });
              return;
            }
            sendResponse(response || { success: true });
          });
        }
      );
    });
    return true;
  }

  if (message.type === "stop-extraction") {
    shouldStopScroll = true;
    // Also relay to content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].url && tabs[0].url.includes("google.com/maps")) {
        chrome.tabs.sendMessage(tabs[0].id, message, () => {});
      }
    });
    sendResponse({ success: true });
    return true;
  }

  // Relay to content script
  if (message.type === "get-listing-count") {
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
