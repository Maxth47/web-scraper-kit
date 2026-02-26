// ── Theme toggle ──
const themeToggle = document.getElementById("themeToggle");
const savedTheme = localStorage.getItem("theme");
if (savedTheme === "dark") document.body.classList.add("dark");

themeToggle.addEventListener("click", () => {
  document.body.classList.toggle("dark");
  const isDark = document.body.classList.contains("dark");
  localStorage.setItem("theme", isDark ? "dark" : "light");
});

// ── DOM refs ──
const fetchResult = document.getElementById("fetchResult");
const fetchProgressBar = document.getElementById("fetchProgressBar");
const fetchCount = document.getElementById("fetchCount");
const fetchStats = document.getElementById("fetchStats");
const extractResult = document.getElementById("extractResult");
const extractProgressBar = document.getElementById("extractProgressBar");
const extractCount = document.getElementById("extractCount");
const extractStats = document.getElementById("extractStats");
const optimizeBtn = document.getElementById("optimizeBtn");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const downloadBtn = document.getElementById("downloadBtn");
const jsonBtn = document.getElementById("jsonBtn");
const excelBtn = document.getElementById("excelBtn");
const copyBtn = document.getElementById("copyBtn");
const exportCount = document.getElementById("exportCount");
const errorMsg = document.getElementById("errorMsg");
const errorText = document.getElementById("errorText");

// Data tab refs
const dataCount = document.getElementById("dataCount");
const dataDownloadBtn = document.getElementById("dataDownloadBtn");
const dataClearBtn = document.getElementById("dataClearBtn");
const dataEmpty = document.getElementById("dataEmpty");
const dataTableWrap = document.getElementById("dataTableWrap");
const dataBody = document.getElementById("dataBody");

// History tab refs
const historyEmpty = document.getElementById("historyEmpty");
const historyList = document.getElementById("historyList");

let extractedData = [];
let historyEntries = [];

// Load history from localStorage
try {
  historyEntries = JSON.parse(localStorage.getItem("extractionHistory") || "[]");
} catch (e) {
  historyEntries = [];
}

// ── Tab switching ──
const tabs = document.querySelectorAll(".tab");
const tabContents = document.querySelectorAll(".tab-content");

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;
    tabs.forEach((t) => t.classList.remove("active"));
    tabContents.forEach((tc) => tc.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + target).classList.add("active");

    // Refresh tab content when switching
    if (target === "data") refreshDataTab();
    if (target === "history") renderHistory();
  });
});

// ── Inline progress helpers ──
function setActionProgress(barEl, count, total) {
  if (total > 0) {
    const pct = Math.round((count / total) * 100);
    barEl.style.width = pct + "%";
  }
}

function showResult(resultEl) {
  resultEl.classList.add("visible");
}

function hideResult(resultEl) {
  resultEl.classList.remove("visible");
}

function resetResult(resultEl, barEl) {
  barEl.style.width = "0%";
  barEl.classList.remove("done");
  hideResult(resultEl);
}

// Step progress: mark number done, line green, next step pending ring
const stepEls = document.querySelectorAll(".step");

function markStepDone(stepIndex) {
  const step = stepEls[stepIndex - 1];
  if (!step) return;
  const num = step.querySelector(".step-number");
  const line = step.querySelector(".step-line");
  if (num) { num.classList.add("done"); num.classList.remove("pending"); }
  if (line) line.classList.add("done");
  // Next step gets pending ring
  const nextStep = stepEls[stepIndex];
  if (nextStep) {
    const nextNum = nextStep.querySelector(".step-number");
    if (nextNum && !nextNum.classList.contains("done")) nextNum.classList.add("pending");
  }
}

function resetStepDone(stepIndex) {
  const step = stepEls[stepIndex - 1];
  if (!step) return;
  const num = step.querySelector(".step-number");
  const line = step.querySelector(".step-line");
  if (num) { num.classList.remove("done"); num.classList.remove("pending"); }
  if (line) line.classList.remove("done");
  // Also remove pending from next step
  const nextStep = stepEls[stepIndex];
  if (nextStep) {
    const nextNum = nextStep.querySelector(".step-number");
    if (nextNum) nextNum.classList.remove("pending");
  }
}

function showError(msg) {
  errorText.textContent = msg;
  errorMsg.classList.add("visible");
  setTimeout(() => {
    errorMsg.classList.remove("visible");
  }, 5000);
}

function setBusy(active) {
  optimizeBtn.disabled = active;
  startBtn.disabled = active;
  stopBtn.disabled = !active;
  if (active) {
    stopBtn.classList.add("visible");
  } else {
    stopBtn.classList.remove("visible");
  }
}

function updateResultCount(count) {
  fetchCount.textContent = count;
  extractCount.textContent = count;
  exportCount.textContent = count;
}

function setExportEnabled(enabled) {
  downloadBtn.disabled = !enabled;
  jsonBtn.disabled = !enabled;
  excelBtn.disabled = !enabled;
  copyBtn.disabled = !enabled;
}

// ── Data received → update data tab + save history ──
function onDataReceived() {
  refreshDataTab();
  dataDownloadBtn.disabled = extractedData.length === 0;
  dataClearBtn.disabled = extractedData.length === 0;
}

function saveToHistory(data, status) {
  if (data.length === 0) return;

  // Try to get the search query from the page title or URL
  const entry = {
    id: Date.now(),
    date: new Date().toISOString(),
    count: data.length,
    status: status,
    query: "", // Will be filled if we can detect it
  };

  // Try to detect search query from the active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].url) {
      const url = new URL(tabs[0].url);
      const searchParam = url.searchParams.get("q") || url.pathname.split("/search/")[1] || "";
      entry.query = decodeURIComponent(searchParam.replace(/\+/g, " "));
    }
    if (!entry.query && tabs[0]) {
      entry.query = (tabs[0].title || "").replace(" - Google Maps", "").trim();
    }

    historyEntries.unshift(entry);
    // Keep last 50 entries
    if (historyEntries.length > 50) historyEntries = historyEntries.slice(0, 50);
    localStorage.setItem("extractionHistory", JSON.stringify(historyEntries));
    renderHistory();
  });
}

// ── Listen for progress messages ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "progress") {

    if (message.status === "scrolling") {
      showResult(fetchResult);
      fetchCount.textContent = message.count || 0;
      // Indeterminate — pulse the bar, but don't overwrite if already done
      if (!fetchProgressBar.classList.contains("done")) {
        fetchProgressBar.style.width = "60%";
      }
    }

    if (message.status === "extracting" || message.status === "extracting-details") {
      showResult(extractResult);
      setActionProgress(extractProgressBar, message.count, message.total);
      updateResultCount(message.total || 0);
    }

    if (message.status === "optimize-done") {
      markStepDone(1);
      setBusy(false);
      updateResultCount(message.count || 0);
      fetchProgressBar.classList.add("done");
      fetchProgressBar.style.width = "100%";
      chrome.runtime.sendMessage({ type: "get-data" }, (response) => {
        if (response && response.data) {
          extractedData = response.data;
          setExportEnabled(extractedData.length > 0);
          onDataReceived();
          saveToHistory(extractedData, "optimize");
        }
      });
    }

    if (message.status === "done") {
      markStepDone(2);
      setBusy(false);
      updateResultCount(message.count || 0);
      extractProgressBar.classList.add("done");
      extractProgressBar.style.width = "100%";
      chrome.runtime.sendMessage({ type: "get-data" }, (response) => {
        if (response && response.data) {
          extractedData = response.data;
          setExportEnabled(extractedData.length > 0);
          onDataReceived();
          saveToHistory(extractedData, "extraction");
        }
      });
    }

    if (message.status === "stopped") {
      setBusy(false);
      // Hide progress bars but keep any counts shown
      fetchProgressBar.style.width = "0%";
      extractProgressBar.style.width = "0%";
      chrome.runtime.sendMessage({ type: "get-data" }, (response) => {
        if (response && response.data && response.data.length > 0) {
          extractedData = response.data;
          updateResultCount(extractedData.length);
          setExportEnabled(true);
          onDataReceived();
        }
      });
    }

    if (message.status === "error") {
      setBusy(false);
      fetchProgressBar.style.width = "0%";
      extractProgressBar.style.width = "0%";
    }
  }
});

// ── Menu tab actions ──
optimizeBtn.addEventListener("click", () => {

  setBusy(true);
  resetStepDone(1);
  resetStepDone(2);
  resetResult(fetchResult, fetchProgressBar);
  resetResult(extractResult, extractProgressBar);
  showResult(fetchResult);
  setExportEnabled(false);
  extractedData = [];
  updateResultCount(0);
  errorMsg.classList.remove("visible");

  chrome.runtime.sendMessage({ type: "clear-data" });
  chrome.runtime.sendMessage({ type: "optimize-fetch" }, (response) => {
    if (chrome.runtime.lastError) {
      showError("Cannot connect. Make sure you're on Google Maps.");
      hideResult(fetchResult);
      setBusy(false);
      return;
    }
    if (response && response.error) {
      showError(response.error);
      hideResult(fetchResult);
      setBusy(false);
    }
  });
});

startBtn.addEventListener("click", () => {
  setBusy(true);
  resetStepDone(2);
  resetResult(extractResult, extractProgressBar);
  showResult(extractResult);
  setExportEnabled(false);
  errorMsg.classList.remove("visible");

  chrome.runtime.sendMessage({ type: "start-extraction" }, (response) => {
    if (chrome.runtime.lastError) {
      showError("Cannot connect. Make sure you're on Google Maps.");
      hideResult(extractResult);
      setBusy(false);
      return;
    }
    if (response && response.error) {
      showError(response.error);
      hideResult(extractResult);
      setBusy(false);
    }
  });
});

stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "stop-extraction" });
  setBusy(false);
});

downloadBtn.addEventListener("click", () => {
  downloadCSV();
});

// ── CSV download (shared) ──
function downloadCSV() {
  if (extractedData.length === 0) return;

  const headers = ["Name", "Address", "Phone", "Website", "Rating", "Reviews", "Category", "Hours"];
  const csvRows = [headers.join(",")];

  for (const item of extractedData) {
    const row = [
      item.name,
      item.address,
      item.phone,
      item.website,
      item.rating,
      item.reviewCount,
      item.category,
      item.hours,
    ].map((val) => {
      const str = (val || "").toString().replace(/"/g, '""');
      return '"' + str + '"';
    });
    csvRows.push(row.join(","));
  }

  const csvContent = csvRows.join("\n");
  const blob = new Blob(["\uFEFF" + csvContent], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "google_maps_data_" + Date.now() + ".csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ── JSON download ──
function downloadJSON() {
  if (extractedData.length === 0) return;

  const jsonContent = JSON.stringify(extractedData, null, 2);
  const blob = new Blob([jsonContent], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "google_maps_data_" + Date.now() + ".json";
  a.click();
  URL.revokeObjectURL(url);
}

// ── Excel download ──
function downloadExcel() {
  if (extractedData.length === 0) return;

  const headers = ["Name", "Address", "Phone", "Website", "Rating", "Reviews", "Category", "Hours"];
  const rows = extractedData.map((item) => [
    item.name, item.address, item.phone, item.website,
    item.rating, item.reviewCount, item.category, item.hours,
  ]);

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Data");
  XLSX.writeFile(wb, "google_maps_data_" + Date.now() + ".xlsx");
}

// ── Copy to clipboard ──
function copyToClipboard() {
  if (extractedData.length === 0) return;

  const headers = ["Name", "Address", "Phone", "Website", "Rating", "Reviews", "Category", "Hours"];
  const rows = extractedData.map((item) =>
    [item.name, item.address, item.phone, item.website, item.rating, item.reviewCount, item.category, item.hours]
      .map((v) => (v || "").toString())
      .join("\t")
  );
  const text = headers.join("\t") + "\n" + rows.join("\n");

  navigator.clipboard.writeText(text).then(() => {
    const origLabel = copyBtn.querySelector(".export-label");
    const prev = origLabel.textContent;
    origLabel.textContent = "Copied!";
    setTimeout(() => {
      origLabel.textContent = prev;
    }, 1500);
  });
}

// ── Wire export buttons ──
jsonBtn.addEventListener("click", () => {
  downloadJSON();
});

excelBtn.addEventListener("click", () => {
  downloadExcel();
});

copyBtn.addEventListener("click", () => {
  copyToClipboard();
});

// ── Data tab ──
dataDownloadBtn.addEventListener("click", () => {
  downloadCSV();
});

dataClearBtn.addEventListener("click", () => {
  extractedData = [];
  resetStepDone(1);
  resetStepDone(2);
  chrome.runtime.sendMessage({ type: "clear-data" });
  refreshDataTab();
  setExportEnabled(false);
  dataDownloadBtn.disabled = true;
  dataClearBtn.disabled = true;
  updateResultCount(0);
  resetResult(fetchResult, fetchProgressBar);
  resetResult(extractResult, extractProgressBar);
});

function refreshDataTab() {
  dataCount.textContent = extractedData.length;
  dataDownloadBtn.disabled = extractedData.length === 0;
  dataClearBtn.disabled = extractedData.length === 0;

  if (extractedData.length === 0) {
    dataEmpty.style.display = "";
    dataTableWrap.style.display = "none";
    return;
  }

  dataEmpty.style.display = "none";
  dataTableWrap.style.display = "";

  dataBody.innerHTML = "";
  extractedData.forEach((item, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + (i + 1) + "</td>" +
      "<td title=\"" + escHTML(item.name) + "\">" + escHTML(item.name) + "</td>" +
      "<td>" + escHTML(item.rating || "\u2014") + "</td>" +
      "<td>" + escHTML(item.phone || "\u2014") + "</td>";
    dataBody.appendChild(tr);
  });
}

function escHTML(str) {
  const d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

// ── History tab ──
function renderHistory() {
  if (historyEntries.length === 0) {
    historyEmpty.style.display = "";
    historyList.innerHTML = "";
    return;
  }

  historyEmpty.style.display = "none";
  historyList.innerHTML = "";

  for (const entry of historyEntries) {
    const date = new Date(entry.date);
    const timeStr = date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    }) + " at " + date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });

    const div = document.createElement("div");
    div.className = "history-item";
    div.innerHTML =
      '<div class="history-icon">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>' +
          '<circle cx="12" cy="10" r="3"/>' +
        '</svg>' +
      '</div>' +
      '<div class="history-info">' +
        '<div class="history-query">' + escHTML(entry.query || "Google Maps extraction") + '</div>' +
        '<div class="history-meta">' + escHTML(entry.count + " listings \u00B7 " + timeStr) + '</div>' +
      '</div>' +
      '<div class="history-actions">' +
        '<button class="history-action-btn" data-id="' + entry.id + '" title="Remove">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<line x1="18" y1="6" x2="6" y2="18"/>' +
            '<line x1="6" y1="6" x2="18" y2="18"/>' +
          '</svg>' +
        '</button>' +
      '</div>';

    historyList.appendChild(div);
  }

  // Bind remove buttons
  historyList.querySelectorAll(".history-action-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = parseInt(btn.dataset.id);
      historyEntries = historyEntries.filter((e) => e.id !== id);
      localStorage.setItem("extractionHistory", JSON.stringify(historyEntries));
      renderHistory();
    });
  });
}

// ── Init ──
chrome.runtime.sendMessage({ type: "get-data" }, (response) => {
  if (response && response.data && response.data.length > 0) {
    extractedData = response.data;
    updateResultCount(extractedData.length);
    setExportEnabled(true);
    markStepDone(1);
    markStepDone(2);
    // Show completed state inline
    showResult(fetchResult);
    fetchProgressBar.classList.add("done");
    fetchProgressBar.style.width = "100%";
    showResult(extractResult);
    extractProgressBar.classList.add("done");
    extractProgressBar.style.width = "100%";
    onDataReceived();
  } else {
    fetchListingCount();
  }
});

function fetchListingCount() {
  chrome.runtime.sendMessage({ type: "get-listing-count" }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.count > 0) {
      updateResultCount(response.count);
    }
  });
}

setInterval(() => {
  if (extractedData.length === 0 && !startBtn.disabled) {
    fetchListingCount();
  }
}, 3000);

// Render history on load
renderHistory();
