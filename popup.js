const statusEl = document.getElementById("status");
const progressSection = document.getElementById("progressSection");
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");
const resultCount = document.getElementById("resultCount");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const downloadBtn = document.getElementById("downloadBtn");
const errorMsg = document.getElementById("errorMsg");

let extractedData = [];

function setStatus(status) {
  const labels = {
    idle: "Idle",
    scrolling: "Scrolling results...",
    extracting: "Extracting data...",
    done: "Done",
    error: "Error - ensure you're on Google Maps with search results",
    stopped: "Stopped",
  };

  statusEl.textContent = labels[status] || status;
  statusEl.className = "status-value " + status;
}

function setProgress(count, total) {
  if (total > 0) {
    progressSection.style.display = "block";
    const pct = Math.round((count / total) * 100);
    progressBar.style.width = pct + "%";
    progressText.textContent = count + " / " + total;
  }
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.style.display = "block";
  setTimeout(() => {
    errorMsg.style.display = "none";
  }, 5000);
}

function setExtracting(active) {
  startBtn.disabled = active;
  stopBtn.disabled = !active;
}

// Listen for progress messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "progress") {
    setStatus(message.status);

    if (message.status === "scrolling") {
      resultCount.textContent = message.count || 0;
      progressSection.style.display = "none";
    }

    if (message.status === "extracting") {
      setProgress(message.count, message.total);
      resultCount.textContent = message.total || 0;
    }

    if (message.status === "done") {
      setExtracting(false);
      resultCount.textContent = message.count || 0;
      // Fetch data from background
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
  progressSection.style.display = "none";
  downloadBtn.disabled = true;
  extractedData = [];
  resultCount.textContent = "0";

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

// Check if there's existing data on popup open
chrome.runtime.sendMessage({ type: "get-data" }, (response) => {
  if (response && response.data && response.data.length > 0) {
    extractedData = response.data;
    resultCount.textContent = extractedData.length;
    downloadBtn.disabled = false;
    setStatus("done");
  }
});
