(() => {
  let isExtracting = false;
  let shouldStop = false;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "start-extraction") {
      if (isExtracting) {
        sendResponse({ error: "Extraction already in progress." });
        return true;
      }
      shouldStop = false;
      isExtracting = true;
      sendResponse({ success: true });
      runExtraction();
      return true;
    }

    if (message.type === "stop-extraction") {
      shouldStop = true;
      sendResponse({ success: true });
      return true;
    }
  });

  function sendProgress(status, count, total) {
    chrome.runtime.sendMessage({
      type: "progress",
      status,
      count,
      total,
    });
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
    return Array.from(feed.querySelectorAll(':scope > div > div[jsaction]')).filter(
      (el) => el.querySelector('a[href*="/maps/place/"]')
    );
  }

  async function autoScroll() {
    sendProgress("scrolling", 0, 0);
    const feed = getResultsFeed();
    if (!feed) {
      sendProgress("error", 0, 0);
      return false;
    }

    const scrollContainer =
      feed.closest('div[role="main"]')?.querySelector("div[tabindex='-1']") ||
      feed.parentElement;

    let previousCount = 0;
    let stableRounds = 0;
    const maxStableRounds = 3;

    while (!shouldStop) {
      const items = getResultItems();
      const currentCount = items.length;

      sendProgress("scrolling", currentCount, 0);

      if (currentCount === previousCount) {
        stableRounds++;
        if (stableRounds >= maxStableRounds) {
          // Check for "end of list" marker
          const endMarker = feed.querySelector(
            'span.fontBodyMedium:not([class*="fontTitle"])'
          );
          if (
            endMarker &&
            endMarker.textContent.includes("You've reached the end")
          ) {
            break;
          }
          // Also break if truly stable
          if (stableRounds >= maxStableRounds + 2) break;
        }
      } else {
        stableRounds = 0;
      }

      previousCount = currentCount;

      // Scroll the feed container
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      } else {
        feed.scrollTop = feed.scrollHeight;
      }

      await sleep(1500 + Math.random() * 500);
    }

    return !shouldStop;
  }

  function extractTextNear(element, label) {
    if (!element) return "";
    const text = element.textContent || "";
    return text.trim();
  }

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
    };

    // Name: typically in a heading-like element or an anchor with specific class
    const nameEl =
      item.querySelector(".fontHeadlineSmall") ||
      item.querySelector('a[aria-label] div[class*="fontHead"]') ||
      item.querySelector("a[aria-label]");
    if (nameEl) {
      data.name =
        nameEl.getAttribute("aria-label") || nameEl.textContent?.trim() || "";
    }

    // Rating & reviews from aria-label like "4.5 stars 200 Reviews"
    const ratingEl = item.querySelector('span[role="img"]');
    if (ratingEl) {
      const ariaLabel = ratingEl.getAttribute("aria-label") || "";
      const ratingMatch = ariaLabel.match(/([\d.]+)\s*star/i);
      if (ratingMatch) data.rating = ratingMatch[1];
      const reviewMatch = ariaLabel.match(/([\d,]+)\s*review/i);
      if (reviewMatch) data.reviewCount = reviewMatch[1].replace(/,/g, "");
    }

    // If rating not found via aria-label, try text content
    if (!data.rating) {
      const spans = item.querySelectorAll("span");
      for (const span of spans) {
        const text = span.textContent?.trim() || "";
        if (/^\d\.\d$/.test(text)) {
          data.rating = text;
          break;
        }
      }
    }

    // Review count from parenthesized number like (200)
    if (!data.reviewCount) {
      const allText = item.textContent || "";
      const parenMatch = allText.match(/\(([\d,]+)\)/);
      if (parenMatch) data.reviewCount = parenMatch[1].replace(/,/g, "");
    }

    // Extract info lines: category, address, hours, phone, website
    // These are typically in spans/divs after the rating section
    const infoContainer = item.querySelectorAll(
      '.fontBodyMedium, [class*="fontBody"]'
    );
    const infoTexts = [];
    infoContainer.forEach((el) => {
      const directText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE || n.tagName === "SPAN")
        .map((n) => n.textContent?.trim())
        .filter(Boolean)
        .join(" ");
      if (directText && directText.length > 1) {
        infoTexts.push(directText);
      }
    });

    // Parse info lines heuristically
    for (const text of infoTexts) {
      // Phone patterns
      if (
        /[\(+]?\d{1,4}[\s\-\)]+\d/.test(text) &&
        text.replace(/[\s\-\(\)]/g, "").length >= 10 &&
        !data.phone
      ) {
        const phoneMatch = text.match(
          /[\(+]?\d[\d\s\-\(\)]{8,}/
        );
        if (phoneMatch) data.phone = phoneMatch[0].trim();
      }

      // Website (link element)
      if (!data.website) {
        const linkEls = item.querySelectorAll("a[href]");
        for (const link of linkEls) {
          const href = link.href || "";
          if (
            href &&
            !href.includes("google.com") &&
            !href.includes("gstatic") &&
            !href.startsWith("javascript")
          ) {
            data.website = href;
            break;
          }
        }
      }

      // Category: usually short text like "Coffee shop", "Restaurant"
      if (
        !data.category &&
        text.length < 40 &&
        !text.includes("Open") &&
        !text.includes("Closed") &&
        !/\d{3}/.test(text)
      ) {
        // Likely a category if it's a short descriptor
        const parts = text.split("·").map((p) => p.trim());
        if (parts.length > 0 && parts[0].length < 30) {
          data.category = parts[0];
        }
      }

      // Hours
      if (/open|closed|hours|24\s*hours/i.test(text) && !data.hours) {
        const hoursMatch = text.match(
          /(open|closed|opens?|closes?)[\s·:]*[^·]*/i
        );
        if (hoursMatch) data.hours = hoursMatch[0].trim();
      }

      // Address: typically contains street indicators or comma-separated location
      if (
        !data.address &&
        (text.includes(",") || /\d+\s+\w+\s+(st|ave|rd|blvd|dr|ln|way|ct)/i.test(text))
      ) {
        data.address = text.split("·")[0]?.trim() || text;
      }
    }

    // Fallback address extraction from W-prefixed divs or detail divs
    if (!data.address) {
      const allDivs = item.querySelectorAll("div, span");
      for (const div of allDivs) {
        const t = div.textContent?.trim() || "";
        if (
          t.length > 10 &&
          t.length < 100 &&
          t.includes(",") &&
          !t.includes("star") &&
          !t.includes("review")
        ) {
          data.address = t;
          break;
        }
      }
    }

    return data;
  }

  async function extractWithClickThrough(items) {
    const results = [];
    const total = items.length;

    for (let i = 0; i < items.length; i++) {
      if (shouldStop) break;

      sendProgress("extracting", i + 1, total);

      // First extract what we can from the list view
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
                  phoneButton.getAttribute("aria-label")?.replace(/Phone:\s*/i, "").trim() ||
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
                  addressButton.getAttribute("aria-label")?.replace(/Address:\s*/i, "").trim() ||
                  addressButton.textContent?.trim() ||
                  "";
              }
            }

            // Hours
            if (!baseData.hours) {
              const hoursEl = detailPanel.querySelector(
                'div[aria-label*="hour"], button[aria-label*="hour"]'
              );
              if (hoursEl) {
                const label = hoursEl.getAttribute("aria-label") || "";
                baseData.hours =
                  label.split(".")[0]?.trim() || hoursEl.textContent?.trim() || "";
              }
            }

            // Category
            if (!baseData.category) {
              const categoryButton = detailPanel.querySelector(
                'button[jsaction*="category"]'
              );
              if (categoryButton) {
                baseData.category = categoryButton.textContent?.trim() || "";
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

  async function runExtraction() {
    try {
      // Step 1: Auto-scroll to load all results
      const scrolled = await autoScroll();
      if (shouldStop) {
        sendProgress("stopped", 0, 0);
        isExtracting = false;
        return;
      }

      // Step 2: Get all result items
      const items = getResultItems();
      if (items.length === 0) {
        sendProgress("error", 0, 0);
        isExtracting = false;
        return;
      }

      sendProgress("extracting", 0, items.length);

      // Step 3: Extract data with click-through for missing fields
      const results = await extractWithClickThrough(items);

      if (shouldStop) {
        sendProgress("stopped", results.length, items.length);
        isExtracting = false;
        return;
      }

      // Step 4: Send results to background
      chrome.runtime.sendMessage({
        type: "extraction-data",
        data: results,
      });

      sendProgress("done", results.length, results.length);
    } catch (err) {
      console.error("Extraction error:", err);
      sendProgress("error", 0, 0);
    } finally {
      isExtracting = false;
    }
  }
})();
