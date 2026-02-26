(() => {
  let isExtracting = false;
  let shouldStop = false;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "enrich-data") {
      shouldStop = false;
      isExtracting = true;
      sendResponse({ success: true });
      runEnrichment(message.data);
      return true;
    }

    if (message.type === "stop-extraction") {
      shouldStop = true;
      sendResponse({ success: true });
      return true;
    }

    if (message.type === "get-listing-count") {
      const feed = document.querySelector('div[role="feed"]');
      const count = feed ? feed.querySelectorAll(".Nv2PK").length : 0;
      sendResponse({ count });
      return true;
    }
  });

  function sendProgress(status, count, total) {
    try {
      chrome.runtime.sendMessage({ type: "progress", status, count, total });
    } catch (e) {
      // Extension context may be invalidated
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getResultsFeed() {
    return (
      document.querySelector('div[role="feed"]') ||
      document.querySelector('div[aria-label*="Results"]')
    );
  }

  function getScrollContainer() {
    const feed = getResultsFeed();
    if (!feed) return null;
    return (
      feed.closest('div[role="main"]')?.querySelector("div[tabindex='-1']") ||
      feed.parentElement
    );
  }

  // ── Enrich pre-extracted data with click-through ──
  async function runEnrichment(data) {
    try {
      const total = data.length;
      const dataByName = new Map();
      for (const item of data) {
        if (item.name) dataByName.set(item.name, item);
      }

      sendProgress("extracting-details", 0, total);

      const feed = getResultsFeed();
      if (!feed) {
        console.warn("Enrichment: no feed found");
        finishEnrichment(data);
        return;
      }

      const scrollContainer = getScrollContainer();

      // Scroll to top
      if (scrollContainer) {
        scrollContainer.scrollTop = 0;
      } else {
        feed.scrollTop = 0;
      }
      await sleep(800);

      let processed = 0;
      let scrollMisses = 0;
      const maxScrollMisses = 30;
      const processedNames = new Set();

      while (processedNames.size < dataByName.size && scrollMisses < maxScrollMisses && !shouldStop) {
        // Get all currently visible listing links
        const links = document.querySelectorAll("a.hfpxzc");
        let foundNew = false;

        for (const link of links) {
          if (shouldStop) break;

          const label = link.getAttribute("aria-label") || "";
          if (!label || processedNames.has(label)) continue;

          const item = dataByName.get(label);
          if (!item) {
            processedNames.add(label); // skip unknown listings
            continue;
          }

          processedNames.add(label);
          foundNew = true;
          processed++;

          sendProgress("extracting-details", processed, total);

          try {
            // Scroll the link into view and click it
            link.scrollIntoView({ block: "center", behavior: "instant" });
            await sleep(300);
            link.click();
            await sleep(2000 + Math.random() * 500);

            // Wait for detail panel to load
            let detailLoaded = false;
            for (let r = 0; r < 8 && !detailLoaded; r++) {
              detailLoaded = !!document.querySelector(
                'button[data-item-id*="phone"], button[data-item-id*="address"], a[data-item-id*="authority"]'
              );
              if (!detailLoaded) await sleep(600);
            }

            if (detailLoaded) {
              extractDetailFields(item);
            }

            // Go back to list
            const backBtn = document.querySelector(
              'button[aria-label="Back"], button[jsaction*="back"]'
            );
            if (backBtn) {
              backBtn.click();
              await sleep(1500 + Math.random() * 500);
            } else {
              history.back();
              await sleep(2000);
            }

            // Wait for feed to reappear
            for (let r = 0; r < 10 && !getResultsFeed(); r++) {
              await sleep(600);
            }
            await sleep(300);
          } catch (e) {
            console.warn("Click-through failed for", label, e);
          }

          // After going back, the DOM has changed — break out of inner for loop
          // and re-query links in the next while iteration
          break;
        }

        if (shouldStop) break;

        // If we've processed all items, we're done
        if (processedNames.size >= dataByName.size) break;

        // No new item found in visible links — scroll down
        if (!foundNew) {
          scrollMisses++;
          if (scrollContainer) {
            scrollContainer.scrollTop += 400;
          } else {
            feed.scrollTop += 400;
          }
          await sleep(800);

          // Check for end of list
          const feedText = feed.textContent || "";
          if (feedText.includes("You've reached the end") || feedText.includes("No more results")) {
            break;
          }
        } else {
          scrollMisses = 0;
        }
      }

      finishEnrichment(data);
    } catch (err) {
      console.error("Enrichment error:", err);
      finishEnrichment(data);
    } finally {
      isExtracting = false;
    }
  }

  function extractDetailFields(item) {
    if (!item.phone) {
      const phoneBtn = document.querySelector('button[data-item-id*="phone"]');
      if (phoneBtn) {
        const label = phoneBtn.getAttribute("aria-label") || "";
        item.phone =
          label.replace(/^Phone:\s*/i, "").trim() ||
          phoneBtn.textContent?.replace(/[^\d\s\-\(\)+]/g, "").trim() || "";
      }
    }

    if (!item.website) {
      const webLink = document.querySelector('a[data-item-id*="authority"]');
      if (webLink) item.website = webLink.href || "";
    }

    if (!item.address) {
      const addrBtn = document.querySelector('button[data-item-id*="address"]');
      if (addrBtn) {
        const label = addrBtn.getAttribute("aria-label") || "";
        item.address =
          label.replace(/^Address:\s*/i, "").trim() ||
          addrBtn.textContent?.trim() || "";
      }
    }

    if (!item.hours) {
      const hoursEl = document.querySelector('[data-item-id*="oh"], [aria-label*="hour" i]');
      if (hoursEl) {
        const label = hoursEl.getAttribute("aria-label") || "";
        item.hours = label.split(".")[0]?.trim() || hoursEl.textContent?.trim() || "";
      }
    }

    if (!item.category) {
      const catBtn = document.querySelector('button[jsaction*="category"]');
      if (catBtn) item.category = catBtn.textContent?.trim() || "";
    }
  }

  function finishEnrichment(data) {
    chrome.runtime.sendMessage({ type: "extraction-data", data });
    sendProgress(shouldStop ? "stopped" : "done", data.length, data.length);
  }
})();
