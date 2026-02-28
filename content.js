(() => {
  let isExtracting = false;
  let shouldStop = false;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

  function sendDebug(msg) {
    try {
      chrome.runtime.sendMessage({ type: "debug-log", msg });
    } catch (e) {}
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

  function getResultItems() {
    const feed = getResultsFeed();
    if (!feed) return [];
    return Array.from(
      feed.querySelectorAll(":scope > div > div[jsaction]")
    ).filter((el) => el.querySelector('a[href*="/maps/place/"]'));
  }

  // ── Extract basic data from a list item (visible in feed) ──
  function extractFromListItem(item) {
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
      const link = item.querySelector('a[href*="/maps/place/"]');
      if (link) {
        data.name = link.getAttribute("aria-label") || "";
      }
    }

    // Rating & reviews from aria-label
    const ratingEl = item.querySelector('span[role="img"]');
    if (ratingEl) {
      const ariaLabel = ratingEl.getAttribute("aria-label") || "";
      const ratingMatch = ariaLabel.match(/([\d.]+)\s*star/i);
      if (ratingMatch) data.rating = ratingMatch[1];
      const reviewMatch = ariaLabel.match(/([\d,]+)\s*review/i);
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

    return data;
  }

  // ── Extract detail fields from the detail panel ──
  function extractDetailFromPanel(baseData) {
    const detailPanel =
      document.querySelector('div[role="main"][aria-label]') ||
      document.querySelector(".m6QErb.WNBkOb");

    if (!detailPanel) {
      sendDebug(`  detail panel: NOT FOUND`);
      return;
    }
    sendDebug(`  detail panel: found`);

    if (!baseData.phone) {
      const phoneButton = detailPanel.querySelector(
        'button[data-item-id*="phone"], button[aria-label*="Phone"]'
      );
      if (phoneButton) {
        baseData.phone =
          phoneButton.getAttribute("aria-label")?.replace(/Phone:\s*/i, "").trim() ||
          phoneButton.textContent?.trim() || "";
      }
    }

    if (!baseData.website) {
      const websiteLink = detailPanel.querySelector(
        'a[data-item-id*="authority"], a[aria-label*="Website"]'
      );
      if (websiteLink) baseData.website = websiteLink.href || "";
    }

    if (!baseData.address) {
      const addressButton = detailPanel.querySelector(
        'button[data-item-id*="address"], button[aria-label*="Address"]'
      );
      if (addressButton) {
        baseData.address =
          addressButton.getAttribute("aria-label")?.replace(/Address:\s*/i, "").trim() ||
          addressButton.textContent?.trim() || "";
      }
    }

    if (!baseData.hours) {
      const hoursEl = detailPanel.querySelector(
        'div[aria-label*="hour" i], button[aria-label*="hour" i]'
      );
      if (hoursEl) {
        const label = hoursEl.getAttribute("aria-label") || "";
        baseData.hours = label.split(".")[0]?.trim() || hoursEl.textContent?.trim() || "";
      }
    }

    if (!baseData.category) {
      const categoryButton = detailPanel.querySelector('button[jsaction*="category"]');
      if (categoryButton) baseData.category = categoryButton.textContent?.trim() || "";
    }

    sendDebug(`  got: phone=${baseData.phone || "-"} web=${baseData.website ? "yes" : "-"} addr=${baseData.address ? "yes" : "-"}`);
  }

  // ── Main enrichment entry point ──
  // Re-queries DOM items after each click+back to avoid stale references
  async function runEnrichment(data) {
    try {
      const total = data.length;
      sendDebug(`Enrichment started. Pre-fetched: ${total} items`);
      sendProgress("extracting-details", 0, total);

      const results = [];
      const processedNames = new Set();
      let processed = 0;

      while (!shouldStop) {
        // Fresh DOM query each round — items change after click+back
        const items = getResultItems();
        sendDebug(`DOM items found: ${items.length}`);

        if (items.length === 0) {
          sendDebug(`No items in DOM — waiting for list...`);
          // Wait for list to reappear
          for (let r = 0; r < 10 && getResultItems().length === 0; r++) {
            await sleep(600);
          }
          if (getResultItems().length === 0) {
            sendDebug(`List never reappeared — aborting`);
            break;
          }
          continue; // Re-query
        }

        let foundNew = false;

        for (let i = 0; i < items.length; i++) {
          if (shouldStop) break;

          const link = items[i].querySelector('a[href*="/maps/place/"]');
          const name =
            link?.getAttribute("aria-label") ||
            items[i].querySelector(".fontHeadlineSmall")?.textContent?.trim() ||
            "";

          if (!name || processedNames.has(name)) continue;
          processedNames.add(name);
          foundNew = true;
          processed++;

          sendProgress("extracting-details", processed, total);

          // Extract basic data from list view
          const baseData = extractFromListItem(items[i]);

          sendDebug(`[${processed}/${total}] "${name}"`);

          // Click through for detail data
          if (link && (!baseData.phone || !baseData.website || !baseData.hours)) {
            try {
              sendDebug(`  clicking...`);
              link.click();
              await sleep(2000 + Math.random() * 500);

              extractDetailFromPanel(baseData);

              // Go back to list view
              const backButton = document.querySelector(
                'button[aria-label="Back"], button[jsaction*="back"]'
              );
              if (backButton) {
                sendDebug(`  back → list`);
                backButton.click();
                await sleep(1500 + Math.random() * 500);
              } else {
                sendDebug(`  NO back button`);
              }

              // Wait for feed to reappear before continuing
              for (let r = 0; r < 10 && !getResultsFeed(); r++) {
                await sleep(600);
              }
              await sleep(300);
            } catch (e) {
              sendDebug(`  ERROR: ${e.message}`);
            }
          } else if (!link) {
            sendDebug(`  SKIP: no link`);
          } else {
            sendDebug(`  SKIP: has data`);
          }

          results.push(baseData);

          // Break after each click+back to re-query fresh DOM
          break;
        }

        if (shouldStop) break;
        if (processed >= total) break;

        // If no new items found this round, we've processed all visible items
        if (!foundNew) {
          sendDebug(`No new items — done`);
          break;
        }
      }

      sendDebug(`Enrichment complete: ${results.length} items`);
      finishEnrichment(results.length > 0 ? results : data);
    } catch (err) {
      sendDebug(`FATAL: ${err.message}`);
      console.error("Enrichment error:", err);
      finishEnrichment(data);
    } finally {
      isExtracting = false;
    }
  }

  function finishEnrichment(data) {
    chrome.runtime.sendMessage({ type: "extraction-data", data });
    sendProgress(shouldStop ? "stopped" : "done", data.length, data.length);
  }
})();
