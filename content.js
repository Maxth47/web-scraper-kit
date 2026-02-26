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
      if (isExtracting) {
        sendResponse({ error: "Extraction already in progress." });
        return true;
      }
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
      let enrichedCount = 0;

      for (let i = 0; i < data.length; i++) {
        if (shouldStop) break;

        const item = data[i];
        const needsDetail = !item.phone || !item.website || !item.address;
        if (!needsDetail) {
          enrichedCount++;
          continue;
        }

        sendProgress("extracting-details", i + 1, total);

        try {
          // Find the matching listing in the current DOM by searching for its name
          // We need to scroll it into view first — use the feed's aria-label search
          const link = findListingLink(item.name);
          if (!link) {
            enrichedCount++;
            continue;
          }

          link.click();
          await sleep(2500 + Math.random() * 500);

          // Wait for detail panel to load
          let retries = 0;
          let detailLoaded = false;
          while (retries < 4 && !detailLoaded) {
            detailLoaded = !!document.querySelector(
              'button[data-item-id*="phone"], button[data-item-id*="address"], a[data-item-id*="authority"]'
            );
            if (!detailLoaded) {
              await sleep(800);
              retries++;
            }
          }

          if (detailLoaded) {
            if (!item.phone) {
              const phoneBtn = document.querySelector(
                'button[data-item-id*="phone"]'
              );
              if (phoneBtn) {
                const label = phoneBtn.getAttribute("aria-label") || "";
                item.phone =
                  label.replace(/^Phone:\s*/i, "").trim() ||
                  phoneBtn.textContent?.replace(/[^\d\s\-\(\)+]/g, "").trim() ||
                  "";
              }
            }

            if (!item.website) {
              const webLink = document.querySelector(
                'a[data-item-id*="authority"]'
              );
              if (webLink) {
                item.website = webLink.href || "";
              }
            }

            if (!item.address) {
              const addrBtn = document.querySelector(
                'button[data-item-id*="address"]'
              );
              if (addrBtn) {
                const label = addrBtn.getAttribute("aria-label") || "";
                item.address =
                  label.replace(/^Address:\s*/i, "").trim() ||
                  addrBtn.textContent?.trim() ||
                  "";
              }
            }

            if (!item.hours) {
              const hoursEl = document.querySelector(
                '[data-item-id*="oh"], [aria-label*="hour" i]'
              );
              if (hoursEl) {
                const label = hoursEl.getAttribute("aria-label") || "";
                item.hours =
                  label.split(".")[0]?.trim() ||
                  hoursEl.textContent?.trim() ||
                  "";
              }
            }

            if (!item.category) {
              const catBtn = document.querySelector(
                'button[jsaction*="category"]'
              );
              if (catBtn) {
                item.category = catBtn.textContent?.trim() || "";
              }
            }
          }

          // Go back to list
          const backBtn = document.querySelector(
            'button[aria-label="Back"], button[jsaction*="back"]'
          );
          if (backBtn) {
            backBtn.click();
            await sleep(2000 + Math.random() * 500);
          } else {
            history.back();
            await sleep(2500);
          }

          // Wait for list to reappear
          let listRetries = 0;
          while (
            listRetries < 5 &&
            !document.querySelector('div[role="feed"]')
          ) {
            await sleep(800);
            listRetries++;
          }
        } catch (e) {
          console.warn("Click-through failed for item", item.name, e);
        }

        enrichedCount++;
      }

      // Send enriched results to background
      chrome.runtime.sendMessage({
        type: "extraction-data",
        data: data,
      });

      sendProgress(
        shouldStop ? "stopped" : "done",
        data.length,
        data.length
      );
    } catch (err) {
      console.error("Enrichment error:", err);
      // Still send what we have
      chrome.runtime.sendMessage({
        type: "extraction-data",
        data: data,
      });
      sendProgress("done", data.length, data.length);
    } finally {
      isExtracting = false;
    }
  }

  // Find a listing link by business name (searches current DOM)
  function findListingLink(name) {
    const links = document.querySelectorAll("a.hfpxzc");
    for (const link of links) {
      const label = link.getAttribute("aria-label") || "";
      if (label === name) return link;
    }
    // Fuzzy match: check if label contains the name or vice versa
    for (const link of links) {
      const label = link.getAttribute("aria-label") || "";
      if (label.includes(name) || name.includes(label)) return link;
    }
    return null;
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
