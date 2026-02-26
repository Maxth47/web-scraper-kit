(() => {
  let isExtracting = false;
  let shouldStop = false;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Legacy: basic extraction (fallback if debugger scroll fails)
    if (message.type === "start-extraction" || message.type === "extract-data") {
      if (isExtracting) {
        sendResponse({ error: "Extraction already in progress." });
        return true;
      }
      shouldStop = false;
      isExtracting = true;
      sendResponse({ success: true });
      runBasicExtraction();
      return true;
    }

    // New: receive pre-extracted data from background, enrich with click-through
    if (message.type === "enrich-data") {
      // Reset state — allow new enrichment even if previous got stuck
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

  // ── Enrich pre-extracted data with click-through for missing fields ──
  async function runEnrichment(data) {
    try {
      const total = data.length;

      // Build a lookup map for quick matching
      const dataByName = new Map();
      for (const item of data) {
        if (item.name) dataByName.set(item.name, item);
      }

      sendProgress("extracting-details", 0, total);

      // Get all listing links currently in the feed
      // Google Maps virtualizes, so we need to process what's visible,
      // then scroll to reveal more
      const feed = document.querySelector('div[role="feed"]');
      if (!feed) {
        console.warn("Enrichment: no feed found");
        finishEnrichment(data);
        return;
      }

      let processed = 0;
      let scrollAttempts = 0;
      const maxScrollAttempts = 100;
      const processedNames = new Set();

      // Scroll to the top first
      feed.scrollTop = 0;
      await sleep(500);

      while (scrollAttempts < maxScrollAttempts && !shouldStop) {
        // Find all visible listing links
        const links = document.querySelectorAll("a.hfpxzc");
        let foundNew = false;

        for (const link of links) {
          if (shouldStop) break;

          const label = link.getAttribute("aria-label") || "";
          if (!label || processedNames.has(label)) continue;

          // Match to our data
          const item = dataByName.get(label);
          if (!item) continue;

          processedNames.add(label);
          foundNew = true;
          processed++;

          sendProgress("extracting-details", processed, total);

          try {
            link.scrollIntoView({ block: "center", behavior: "instant" });
            await sleep(200);
            link.click();
            await sleep(2000 + Math.random() * 500);

            // Wait for detail panel
            let detailLoaded = false;
            for (let r = 0; r < 5 && !detailLoaded; r++) {
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
            for (let r = 0; r < 8 && !document.querySelector('div[role="feed"]'); r++) {
              await sleep(600);
            }
          } catch (e) {
            console.warn("Click-through failed for", label, e);
          }
        }

        // If we've processed all items, we're done
        if (processedNames.size >= dataByName.size) break;

        // Scroll down to reveal more listings
        if (!foundNew) {
          scrollAttempts++;
        } else {
          scrollAttempts = 0;
        }

        feed.scrollTop += 300;
        await sleep(400);

        // Check for end of list
        const feedText = feed.textContent || "";
        if (feedText.includes("You've reached the end")) {
          // One more pass to catch the last items
          await sleep(300);
          const finalLinks = document.querySelectorAll("a.hfpxzc");
          for (const link of finalLinks) {
            if (shouldStop) break;
            const label = link.getAttribute("aria-label") || "";
            if (!label || processedNames.has(label)) continue;
            const item = dataByName.get(label);
            if (!item) continue;

            processedNames.add(label);
            processed++;
            sendProgress("extracting-details", processed, total);

            try {
              link.click();
              await sleep(2000 + Math.random() * 500);

              let detailLoaded = false;
              for (let r = 0; r < 5 && !detailLoaded; r++) {
                detailLoaded = !!document.querySelector(
                  'button[data-item-id*="phone"], button[data-item-id*="address"], a[data-item-id*="authority"]'
                );
                if (!detailLoaded) await sleep(600);
              }
              if (detailLoaded) extractDetailFields(item);

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
              for (let r = 0; r < 8 && !document.querySelector('div[role="feed"]'); r++) {
                await sleep(600);
              }
            } catch (e) {
              console.warn("Click-through failed for", label, e);
            }
          }
          break;
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

  // ── Fallback: basic extraction from currently visible items ──
  async function runBasicExtraction() {
    try {
      const feed = document.querySelector('div[role="feed"]');
      if (!feed) {
        sendProgress("error", 0, 0);
        isExtracting = false;
        return;
      }

      const cards = feed.querySelectorAll(".Nv2PK");
      if (cards.length === 0) {
        sendProgress("error", 0, 0);
        isExtracting = false;
        return;
      }

      sendProgress("extracting", 0, cards.length);
      const results = [];

      for (let i = 0; i < cards.length; i++) {
        if (shouldStop) break;
        sendProgress("extracting", i + 1, cards.length);
        const data = extractFromCard(cards[i]);
        if (data.name) results.push(data);
      }

      chrome.runtime.sendMessage({
        type: "extraction-data",
        data: results,
      });

      sendProgress(
        shouldStop ? "stopped" : "done",
        results.length,
        results.length
      );
    } catch (err) {
      console.error("Extraction error:", err);
      sendProgress("error", 0, 0);
    } finally {
      isExtracting = false;
    }
  }

  function extractFromCard(item) {
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

    const ratingImg = item.querySelector('span[role="img"]');
    if (ratingImg) {
      const ariaLabel = ratingImg.getAttribute("aria-label") || "";
      const ratingMatch = ariaLabel.match(/([\d.]+)\s*star/i);
      if (ratingMatch) data.rating = ratingMatch[1];
      const reviewMatch = ariaLabel.match(/([\d,]+)\s*[Rr]eview/);
      if (reviewMatch) data.reviewCount = reviewMatch[1].replace(/,/g, "");
    }

    if (!data.reviewCount) {
      const allText = item.textContent || "";
      const parenMatch = allText.match(/\(([\d,]+)\)/);
      if (parenMatch) data.reviewCount = parenMatch[1].replace(/,/g, "");
    }

    return data;
  }
})();
