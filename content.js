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

    if (message.type === "get-listing-count") {
      const items = getResultItems();
      sendResponse({ count: items.length });
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

  // ── Find the results feed container ──
  function getResultsFeed() {
    return (
      document.querySelector('div[role="feed"]') ||
      document.querySelector('div[aria-label*="Results"]')
    );
  }

  // ── Find all result items using multiple selector strategies ──
  function getResultItems() {
    const feed = getResultsFeed();
    if (!feed) return [];

    // Strategy 1: .Nv2PK is the main result card class (most reliable)
    let items = Array.from(feed.querySelectorAll('.Nv2PK'));
    if (items.length > 0) return items;

    // Strategy 2: Find divs containing place links
    items = Array.from(feed.querySelectorAll('div'))
      .filter((el) => {
        const link = el.querySelector('a[href*="/maps/place/"]');
        if (!link) return false;
        // Only select the closest container that has the full card content
        const name = el.querySelector('.fontHeadlineSmall') || el.querySelector('[class*="fontHead"]');
        return !!name;
      });

    // Deduplicate: only keep the outermost match (no parent-child dupes)
    return items.filter(
      (el) => !items.some((other) => other !== el && other.contains(el))
    );
  }

  // ── Find the scrollable container for the results panel ──
  function getScrollContainer() {
    const feed = getResultsFeed();
    if (!feed) return null;

    // The scrollable div is typically .m6QErb with tabindex="-1" and overflow auto
    let el = feed.parentElement;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      const overflowY = style.overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight + 10
      ) {
        return el;
      }
      el = el.parentElement;
    }

    // Fallback: try known class
    return (
      document.querySelector(".m6QErb.DxyBCb.kA9KIf.dS8AEf") ||
      feed.closest('[tabindex="-1"]') ||
      feed.parentElement
    );
  }

  // ── Auto-scroll the results panel to load all items ──
  async function autoScroll() {
    sendProgress("scrolling", 0, 0);
    const feed = getResultsFeed();
    if (!feed) {
      sendProgress("error", 0, 0);
      return false;
    }

    const scrollContainer = getScrollContainer();
    if (!scrollContainer) {
      sendProgress("error", 0, 0);
      return false;
    }

    let previousCount = 0;
    let stableRounds = 0;
    const maxStableRounds = 5;

    while (!shouldStop) {
      const items = getResultItems();
      const currentCount = items.length;
      sendProgress("scrolling", currentCount, 0);

      if (currentCount === previousCount) {
        stableRounds++;

        // Check for "end of list" markers
        const endReached =
          feed.textContent.includes("You've reached the end") ||
          feed.textContent.includes("No more results") ||
          feed.querySelector('span[class*="fontBody"]:-webkit-any(:last-child)')?.textContent?.includes("end");

        if (endReached || stableRounds >= maxStableRounds) {
          break;
        }
      } else {
        stableRounds = 0;
      }

      previousCount = currentCount;

      // Scroll to bottom
      scrollContainer.scrollTop = scrollContainer.scrollHeight;

      // Randomized delay to avoid detection
      await sleep(1500 + Math.random() * 1000);
    }

    return !shouldStop;
  }

  // ── Extract data from a single list item card ──
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

    // ── Name ──
    const nameEl =
      item.querySelector(".fontHeadlineSmall") ||
      item.querySelector('[class*="fontHead"]');
    if (nameEl) {
      data.name = nameEl.textContent?.trim() || "";
    }
    // Fallback: aria-label on the main link
    if (!data.name) {
      const link = item.querySelector("a.hfpxzc") || item.querySelector('a[href*="/maps/place/"]');
      if (link) {
        data.name = link.getAttribute("aria-label") || "";
      }
    }

    // ── Rating & Review Count from aria-label ──
    const ratingImg = item.querySelector('span[role="img"]');
    if (ratingImg) {
      const ariaLabel = ratingImg.getAttribute("aria-label") || "";
      const ratingMatch = ariaLabel.match(/([\d.]+)\s*star/i);
      if (ratingMatch) data.rating = ratingMatch[1];
      const reviewMatch = ariaLabel.match(/([\d,]+)\s*[Rr]eview/);
      if (reviewMatch) data.reviewCount = reviewMatch[1].replace(/,/g, "");
    }

    // Fallback rating from text like "4.7"
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

    // Fallback review count from parenthesized number like (1,278)
    if (!data.reviewCount) {
      const allText = item.textContent || "";
      const parenMatch = allText.match(/\(([\d,]+)\)/);
      if (parenMatch) data.reviewCount = parenMatch[1].replace(/,/g, "");
    }

    // ── Parse W4Efsd info sections ──
    // Structure: multiple .W4Efsd elements containing category, address, hours, etc.
    const w4Sections = item.querySelectorAll(".W4Efsd");
    const infoLines = [];

    w4Sections.forEach((section) => {
      // Get the nested .W4Efsd if it exists (the actual info row)
      const nested = section.querySelector(":scope > .W4Efsd");
      const target = nested || section;

      const spans = target.querySelectorAll(":scope > span");
      const parts = [];
      spans.forEach((span) => {
        const text = span.textContent?.trim();
        if (text && text !== "·" && text !== "· " && text.length > 0) {
          // Clean leading middot
          parts.push(text.replace(/^·\s*/, "").trim());
        }
      });

      if (parts.length > 0) {
        infoLines.push(parts);
      }
    });

    // Parse the info lines
    // Typical pattern:
    //   Line 0: ["4.7(1,278)", "· $1–10"]  (rating row - skip)
    //   Line 1: ["Coffee shop", "", "1030 Washington St"]  (category + address)
    //   Line 2: same as line 1 (duplicate from nested structure)
    //   Line 3: ["Snug, minimalist cafe..."]  (description)
    //   Line 4: ["Open · Closes 2.00 pm"]  (hours)

    const seen = new Set();
    for (const parts of infoLines) {
      const lineText = parts.join(" ");

      // Skip duplicate lines
      if (seen.has(lineText)) continue;
      seen.add(lineText);

      // Skip rating line
      if (/^\d\.\d.*\(\d/.test(lineText)) continue;

      for (const part of parts) {
        if (!part || part.length === 0) continue;

        // Hours detection
        if (
          !data.hours &&
          /\b(open|closed|opens?|closes?|24\s*hours?)\b/i.test(part)
        ) {
          data.hours = part.trim();
          continue;
        }

        // Price level like "$1–10" or "$$"
        if (!data.priceLevel && /^\$/.test(part)) {
          data.priceLevel = part;
          continue;
        }

        // Category: short text, no digits, no commas (appears first in the info line)
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

        // Address: contains street number or comma-separated location
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

    // ── Website: look for non-Google external links ──
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

    // ── Phone: look for tel: links or phone patterns in text ──
    const telLink = item.querySelector('a[href^="tel:"]');
    if (telLink) {
      data.phone = telLink.href.replace("tel:", "").trim();
    }

    return data;
  }

  // ── Click-through extraction for missing fields ──
  async function enrichWithDetailPanel(items, results) {
    for (let i = 0; i < results.length; i++) {
      if (shouldStop) break;

      const data = results[i];
      const item = items[i];

      // Only click through if we're missing important fields
      const needsDetail = !data.phone || !data.website || !data.address;
      if (!needsDetail) continue;

      sendProgress("extracting-details", i + 1, results.length);

      try {
        // Click the main link overlay
        const link =
          item.querySelector("a.hfpxzc") ||
          item.querySelector('a[href*="/maps/place/"]');
        if (!link) continue;

        link.click();
        await sleep(2500 + Math.random() * 500);

        // Wait for detail panel to load - look for info buttons
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
          // Phone
          if (!data.phone) {
            const phoneBtn = document.querySelector(
              'button[data-item-id*="phone"]'
            );
            if (phoneBtn) {
              const label = phoneBtn.getAttribute("aria-label") || "";
              data.phone =
                label.replace(/^Phone:\s*/i, "").trim() ||
                phoneBtn.textContent?.replace(/[^\d\s\-\(\)+]/g, "").trim() ||
                "";
            }
          }

          // Website
          if (!data.website) {
            const webLink = document.querySelector(
              'a[data-item-id*="authority"]'
            );
            if (webLink) {
              data.website = webLink.href || "";
            }
          }

          // Address
          if (!data.address) {
            const addrBtn = document.querySelector(
              'button[data-item-id*="address"]'
            );
            if (addrBtn) {
              const label = addrBtn.getAttribute("aria-label") || "";
              data.address =
                label.replace(/^Address:\s*/i, "").trim() ||
                addrBtn.textContent?.trim() ||
                "";
            }
          }

          // Hours
          if (!data.hours) {
            const hoursEl = document.querySelector(
              '[data-item-id*="oh"], [aria-label*="hour" i]'
            );
            if (hoursEl) {
              const label = hoursEl.getAttribute("aria-label") || "";
              data.hours =
                label.split(".")[0]?.trim() || hoursEl.textContent?.trim() || "";
            }
          }

          // Category
          if (!data.category) {
            const catBtn = document.querySelector(
              'button[jsaction*="category"]'
            );
            if (catBtn) {
              data.category = catBtn.textContent?.trim() || "";
            }
          }
        }

        // Navigate back to the search results list
        const backBtn = document.querySelector(
          'button[aria-label="Back"], button[jsaction*="back"]'
        );
        if (backBtn) {
          backBtn.click();
          await sleep(2000 + Math.random() * 500);
        } else {
          // Fallback: use browser history
          history.back();
          await sleep(2500);
        }

        // Wait for list to reappear
        let listRetries = 0;
        while (listRetries < 5 && !getResultsFeed()) {
          await sleep(800);
          listRetries++;
        }
      } catch (e) {
        console.warn("Click-through failed for item", i, e);
      }
    }
  }

  // ── Main extraction flow ──
  async function runExtraction() {
    try {
      // Step 1: Auto-scroll to load all results
      await autoScroll();
      if (shouldStop) {
        sendProgress("stopped", 0, 0);
        isExtracting = false;
        return;
      }

      // Step 2: Get all loaded result items
      const items = getResultItems();
      if (items.length === 0) {
        sendProgress("error", 0, 0);
        isExtracting = false;
        return;
      }

      // Step 3: Extract data from list view
      sendProgress("extracting", 0, items.length);
      const results = [];
      for (let i = 0; i < items.length; i++) {
        if (shouldStop) break;
        sendProgress("extracting", i + 1, items.length);
        results.push(extractFromListItem(items[i]));
      }

      if (shouldStop) {
        sendProgress("stopped", results.length, items.length);
        isExtracting = false;
        return;
      }

      // Step 4: Enrich with click-through for missing phone/website
      await enrichWithDetailPanel(items, results);

      if (shouldStop) {
        sendProgress("stopped", results.length, items.length);
        isExtracting = false;
        return;
      }

      // Step 5: Send results to background
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
