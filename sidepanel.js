const statusEl = document.getElementById("status");
const statusDot = document.getElementById("statusDot");
const statusCard = document.getElementById("statusCard");
const progressSection = document.getElementById("progressSection");
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");
const progressPct = document.getElementById("progressPct");
const resultCount = document.getElementById("resultCount");
const fieldCount = document.getElementById("fieldCount");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const downloadBtn = document.getElementById("downloadBtn");
const errorMsg = document.getElementById("errorMsg");
const errorText = document.getElementById("errorText");

let extractedData = [];

const STATUS_LABELS = {
  idle: "Ready to extract",
  scrolling: "Loading all results...",
  extracting: "Extracting business data...",
  done: "Extraction complete",
  error: "Not on a Google Maps search page",
  stopped: "Extraction stopped",
};

function setStatus(status) {
  statusEl.textContent = STATUS_LABELS[status] || status;
  statusDot.className = "status-indicator " + status;

  statusCard.className = "card";
  if (status === "scrolling" || status === "extracting") {
    statusCard.classList.add("active");
  } else if (status === "done") {
    statusCard.classList.add("done");
  } else if (status === "error" || status === "stopped") {
    statusCard.classList.add("error");
  }
}

function setProgress(count, total) {
  if (total > 0) {
    progressSection.classList.add("visible");
    const pct = Math.round((count / total) * 100);
    progressBar.style.width = pct + "%";
    progressText.textContent = count + " of " + total;
    progressPct.textContent = pct + "%";
  }
}

function showError(msg) {
  errorText.textContent = msg;
  errorMsg.classList.add("visible");
  setTimeout(() => {
    errorMsg.classList.remove("visible");
  }, 5000);
}

function setExtracting(active) {
  startBtn.disabled = active;
  stopBtn.disabled = !active;
}

function updateResultCount(count) {
  resultCount.textContent = count;
}

// Listen for progress messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "progress") {
    setStatus(message.status);

    if (message.status === "scrolling") {
      updateResultCount(message.count || 0);
      progressSection.classList.remove("visible");
    }

    if (message.status === "extracting") {
      setProgress(message.count, message.total);
      updateResultCount(message.total || 0);
    }

    if (message.status === "done") {
      setExtracting(false);
      updateResultCount(message.count || 0);
      progressBar.classList.add("done");
      setProgress(message.count, message.count);
      chrome.runtime.sendMessage({ type: "get-data" }, (response) => {
        if (response && response.data) {
          extractedData = response.data;
          downloadBtn.disabled = extractedData.length === 0;
        }
      });
    }

    if (message.status === "error" || message.status === "stopped") {
      setExtracting(false);
    }
  }
});

startBtn.addEventListener("click", () => {
  setStatus("scrolling");
  setExtracting(true);
  progressBar.style.width = "0%";
  progressBar.classList.remove("done");
  progressSection.classList.remove("visible");
  downloadBtn.disabled = true;
  extractedData = [];
  updateResultCount(0);
  errorMsg.classList.remove("visible");

  chrome.runtime.sendMessage({ type: "clear-data" });
  chrome.runtime.sendMessage({ type: "start-extraction" }, (response) => {
    if (chrome.runtime.lastError) {
      showError("Cannot connect. Make sure you're on Google Maps.");
      setStatus("error");
      setExtracting(false);
      return;
    }
    if (response && response.error) {
      showError(response.error);
      setStatus("error");
      setExtracting(false);
    }
  });
});

stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "stop-extraction" });
  setStatus("stopped");
  setExtracting(false);
});

downloadBtn.addEventListener("click", () => {
  if (extractedData.length === 0) return;

  const headers = [
    "Name",
    "Address",
    "Phone",
    "Website",
    "Rating",
    "Reviews",
    "Category",
    "Hours",
  ];

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
});

// Check if there's existing data on panel open
chrome.runtime.sendMessage({ type: "get-data" }, (response) => {
  if (response && response.data && response.data.length > 0) {
    extractedData = response.data;
    updateResultCount(extractedData.length);
    downloadBtn.disabled = false;
    setStatus("done");
    progressBar.classList.add("done");
    setProgress(extractedData.length, extractedData.length);
  }
});
