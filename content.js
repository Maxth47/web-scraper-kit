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

  // ── Click through each item and extract detail panel data ──
  // Follows the reference's extractWithClickThrough pattern exactly
  async function extractWithClickThrough(items) {
    const results = [];
    const total = items.length;

    for (let i = 0; i < items.length; i++) {
      if (shouldStop) break;

      sendProgress("extracting-details", i + 1, total);

      // Extract what we can from the list view
      const baseData = extractFromListItem(items[i]);

      // Click the item to get detail panel data
      const link = items[i].querySelector('a[href*="/maps/place/"]');
      if (link && (!baseData.phone || !baseData.website || !baseData.hours)) {
        try {
          link.click();
          await sleep(2000 + Math.random() * 500);

          // Extract from the detail panel
          const detailPanel =
            document.querySelector('div[role="main"][aria-label]') ||
            document.querySelector(".m6QErb.WNBkOb");

          if (detailPanel) {
            // Phone
            if (!baseData.phone) {
              const phoneButton = detailPanel.querySelector(
                'button[data-item-id*="phone"], button[aria-label*="Phone"]'
              );
              if (phoneButton) {
                baseData.phone =
                  phoneButton
                    .getAttribute("aria-label")
                    ?.replace(/Phone:\s*/i, "")
                    .trim() ||
                  phoneButton.textContent?.trim() ||
                  "";
              }
            }

            // Website
            if (!baseData.website) {
              const websiteLink = detailPanel.querySelector(
                'a[data-item-id*="authority"], a[aria-label*="Website"]'
              );
              if (websiteLink) {
                baseData.website = websiteLink.href || "";
              }
            }

            // Address
            if (!baseData.address) {
              const addressButton = detailPanel.querySelector(
                'button[data-item-id*="address"], button[aria-label*="Address"]'
              );
              if (addressButton) {
                baseData.address =
                  addressButton
                    .getAttribute("aria-label")
                    ?.replace(/Address:\s*/i, "")
                    .trim() ||
                  addressButton.textContent?.trim() ||
                  "";
              }
            }

            // Hours
            if (!baseData.hours) {
              const hoursEl = detailPanel.querySelector(
                'div[aria-label*="hour" i], button[aria-label*="hour" i]'
              );
              if (hoursEl) {
                const label = hoursEl.getAttribute("aria-label") || "";
                baseData.hours =
                  label.split(".")[0]?.trim() ||
                  hoursEl.textContent?.trim() ||
                  "";
              }
            }

            // Category
            if (!baseData.category) {
              const categoryButton = detailPanel.querySelector(
                'button[jsaction*="category"]'
              );
              if (categoryButton) {
                baseData.category =
                  categoryButton.textContent?.trim() || "";
              }
            }
          }

          // Go back to list view
          const backButton = document.querySelector(
            'button[aria-label="Back"], button[jsaction*="back"]'
          );
          if (backButton) {
            backButton.click();
            await sleep(1500 + Math.random() * 500);
          }
        } catch (e) {
          console.warn("Click-through extraction failed for item", i, e);
        }
      }

      results.push(baseData);
    }

    return results;
  }

  // ── Main enrichment entry point ──
  async function runEnrichment(data) {
    try {
      sendProgress("extracting-details", 0, data.length);

      // Get all items currently in DOM (loaded by the fetch step)
      const items = getResultItems();

      if (items.length === 0) {
        console.warn("Enrichment: no items found in DOM");
        finishEnrichment(data);
        return;
      }

      // Run click-through enrichment on all DOM items
      const results = await extractWithClickThrough(items);

      if (shouldStop) {
        finishEnrichment(results.length > 0 ? results : data);
      } else {
        finishEnrichment(results);
      }
    } catch (err) {
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
