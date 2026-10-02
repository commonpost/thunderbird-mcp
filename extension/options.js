// `browser` is declared as a global in eslint.config.mjs for the
// extension/ file group. Per-file /* global browser */ triggered
// no-redeclare.
"use strict";

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const serverPort = document.getElementById("serverPort");
const connFile = document.getElementById("connFile");
const buildInfo = document.getElementById("buildInfo");
const originalExtensionRow = document.getElementById("originalExtensionRow");
const startErrorRow = document.getElementById("startErrorRow");
const startErrorText = document.getElementById("startErrorText");
const retryStartBtn = document.getElementById("retryStartBtn");
const retryStartStatus = document.getElementById("retryStartStatus");
const accountList = document.getElementById("accountList");
const saveBtn = document.getElementById("saveBtn");
const saveStatus = document.getElementById("saveStatus");

const toolList = document.getElementById("toolList");
const saveToolsBtn = document.getElementById("saveToolsBtn");
const saveToolsStatus = document.getElementById("saveToolsStatus");

const currentAuthTokenInput = document.getElementById("currentAuthToken");
const copyAuthTokenBtn = document.getElementById("copyAuthTokenBtn");
const copyAuthTokenStatus = document.getElementById("copyAuthTokenStatus");
const useStableAuthTokenCheckbox = document.getElementById("useStableAuthToken");
const stableAuthTokenControls = document.getElementById("stableAuthTokenControls");
const stableAuthTokenInput = document.getElementById("stableAuthToken");
const generateStableAuthTokenBtn = document.getElementById("generateStableAuthTokenBtn");
const regenerateStableAuthTokenBtn = document.getElementById("regenerateStableAuthTokenBtn");
const stableAuthTokenStatus = document.getElementById("stableAuthTokenStatus");

let currentAccounts = [];
let currentTools = [];
let getMessagesLimitInput = null;
let getMessagesLimitStatus = null;

// CRUD labels for sub-group headers
const CRUD_LABELS = { read: "Read", create: "Create", update: "Update", delete: "Delete" };

function validateGetMessagesLimitInput() {
  if (!getMessagesLimitInput) return undefined;
  const min = Number(getMessagesLimitInput.dataset.min || "1");
  const max = Number(getMessagesLimitInput.dataset.max || "20");
  const rawValue = getMessagesLimitInput.value.trim();
  const value = Number(rawValue);
  const valid = /^\d+$/.test(rawValue) && Number.isInteger(value) && value >= min && value <= max;
  if (!valid) {
    getMessagesLimitInput.setAttribute("aria-invalid", "true");
    if (getMessagesLimitStatus) {
      getMessagesLimitStatus.textContent = `Enter an integer from ${min} to ${max}.`;
    }
    return null;
  }
  getMessagesLimitInput.removeAttribute("aria-invalid");
  if (getMessagesLimitStatus) {
    getMessagesLimitStatus.textContent = "";
  }
  return value;
}

async function loadServerInfo() {
  try {
    const info = await browser.commonpostMcp.getServerInfo();
    if (info.running) {
      statusDot.className = "status-dot running";
      statusText.textContent = "Running";
      serverPort.textContent = info.port || "--";
      connFile.textContent = info.connectionFile || "--";
    } else if (info.startError) {
      // A failed start used to be shown as "Running" (#179): show the error.
      statusDot.className = "status-dot stopped";
      statusText.textContent = "Start failed";
      serverPort.textContent = "--";
      connFile.textContent = "--";
    } else {
      statusDot.className = "status-dot stopped";
      statusText.textContent = "Not running";
      serverPort.textContent = "--";
      connFile.textContent = "--";
    }
    originalExtensionRow.hidden = !info.originalExtensionActive;
    if (!info.running) {
      // Offered whenever the server is not bound (failed or never started).
      startErrorText.textContent = info.startError
        ? info.startError + (info.startErrorAt ? " (" + info.startErrorAt.replace("T", " ").replace(/\.\d+Z$/, " UTC") + ")" : "")
        : "Server is not running.";
      startErrorRow.hidden = false;
    } else {
      startErrorRow.hidden = true;
      startErrorText.textContent = "";
    }
    if (info.buildVersion) {
      // Parse git describe: "v0.2.0-7-g1461f1a+dirty" → tag, commits, hash, dirty
      const m = info.buildVersion.match(/^(v[\d.]+)(?:-(\d+)-g([0-9a-f]+))?(\+dirty)?$/);
      let display;
      if (m) {
        const [, tag, commits, hash, dirty] = m;
        display = tag;
        if (commits && commits !== "0") display += ` +${commits}`;
        display += ` (${hash || tag})`;
        if (dirty) {
          display += " +dirty";
          if (info.buildDate) {
            display += " " + info.buildDate.replace("T", " ").replace(/\.\d+Z$/, " UTC");
          }
        }
      } else {
        display = info.buildVersion;
      }
      buildInfo.textContent = display;
    } else {
      buildInfo.textContent = "--";
    }
  } catch (e) {
    statusDot.className = "status-dot stopped";
    statusText.textContent = "Error: " + e.message;
  }
}

function updateStableAuthTokenControls() {
  stableAuthTokenControls.hidden = !useStableAuthTokenCheckbox.checked;
}

function setStableAuthTokenBusy(busy) {
  useStableAuthTokenCheckbox.disabled = busy;
  stableAuthTokenInput.disabled = busy;
  generateStableAuthTokenBtn.disabled = busy;
  regenerateStableAuthTokenBtn.disabled = busy;
}

function setStableAuthTokenStatus(message, error = false) {
  stableAuthTokenStatus.textContent = message;
  stableAuthTokenStatus.className = error ? "save-status error" : "save-status";
}

async function requestGeneratedAuthToken() {
  const result = await browser.commonpostMcp.generateAuthToken();
  if (result.error) {
    throw new Error(result.error);
  }
  if (!result.authToken) {
    throw new Error("Generated token was empty");
  }
  return result.authToken;
}

async function saveStableAuthTokenValue(value, successMessage = "Saved.") {
  const stableAuthToken = value.trim();
  setStableAuthTokenStatus("Saving...");
  const result = await browser.commonpostMcp.setStableAuthToken(stableAuthToken);
  if (result.error) {
    setStableAuthTokenStatus(result.error, true);
    return false;
  }
  stableAuthTokenInput.value = result.stableAuthToken || "";
  setStableAuthTokenStatus(successMessage);
  return true;
}

async function updateStoredStableAuthToken(value, successMessage) {
  setStableAuthTokenBusy(true);
  try {
    await saveStableAuthTokenValue(value, successMessage);
  } catch (e) {
    setStableAuthTokenStatus("Error: " + e.message, true);
  }
  setStableAuthTokenBusy(false);
  updateStableAuthTokenControls();
}

async function generateAndStoreStableAuthToken(successMessage) {
  setStableAuthTokenBusy(true);
  try {
    const token = await requestGeneratedAuthToken();
    stableAuthTokenInput.value = token;
    await saveStableAuthTokenValue(token, successMessage);
  } catch (e) {
    setStableAuthTokenStatus("Error: " + e.message, true);
  }
  setStableAuthTokenBusy(false);
  updateStableAuthTokenControls();
}

async function loadAuthenticationConfig() {
  try {
    const [current, stable] = await Promise.all([
      browser.commonpostMcp.getCurrentAuthToken(),
      browser.commonpostMcp.getStableAuthToken(),
    ]);
    currentAuthTokenInput.value = current.authToken || "";
    copyAuthTokenBtn.disabled = !currentAuthTokenInput.value;
    copyAuthTokenStatus.textContent = "";
    copyAuthTokenStatus.className = "save-status";

    stableAuthTokenInput.value = stable.stableAuthToken || "";
    useStableAuthTokenCheckbox.checked = !!stableAuthTokenInput.value;
    updateStableAuthTokenControls();
    setStableAuthTokenStatus("");
  } catch (e) {
    copyAuthTokenStatus.textContent = "Error loading token: " + e.message;
    copyAuthTokenStatus.className = "save-status error";
    setStableAuthTokenStatus("Error loading setting: " + e.message, true);
  }
}

copyAuthTokenBtn.addEventListener("click", async () => {
  copyAuthTokenStatus.textContent = "";
  copyAuthTokenStatus.className = "save-status";
  copyAuthTokenBtn.disabled = true;
  try {
    await navigator.clipboard.writeText(currentAuthTokenInput.value);
    copyAuthTokenStatus.textContent = "Copied.";
  } catch (e) {
    copyAuthTokenStatus.textContent = "Error: " + e.message;
    copyAuthTokenStatus.className = "save-status error";
  }
  copyAuthTokenBtn.disabled = !currentAuthTokenInput.value;
});

useStableAuthTokenCheckbox.addEventListener("change", async () => {
  updateStableAuthTokenControls();
  if (useStableAuthTokenCheckbox.checked) {
    if (!stableAuthTokenInput.value.trim()) {
      await generateAndStoreStableAuthToken("Generated and saved.");
    } else {
      await updateStoredStableAuthToken(stableAuthTokenInput.value, "Saved.");
    }
  } else {
    stableAuthTokenInput.value = "";
    await updateStoredStableAuthToken("", "Stable token cleared.");
  }
});

stableAuthTokenInput.addEventListener("change", async () => {
  if (!useStableAuthTokenCheckbox.checked) {
    return;
  }
  if (!stableAuthTokenInput.value.trim()) {
    await generateAndStoreStableAuthToken("Generated and saved.");
  } else {
    await updateStoredStableAuthToken(stableAuthTokenInput.value, "Saved.");
  }
});

generateStableAuthTokenBtn.addEventListener("click", async () => {
  await generateAndStoreStableAuthToken("Generated and saved.");
});

regenerateStableAuthTokenBtn.addEventListener("click", async () => {
  await generateAndStoreStableAuthToken("Regenerated and saved.");
});

let accountRestrictionInvalid = false;
let openAllConfirmed = false;

async function loadAccountAccess() {
  try {
    const data = await browser.commonpostMcp.getAccountAccessConfig();
    currentAccounts = data.accounts || [];
    accountRestrictionInvalid = data.mode === "invalid";
    openAllConfirmed = false;

    if (currentAccounts.length === 0) {
      accountList.innerHTML = "<li>No accounts found.</li>";
      return;
    }

    accountList.innerHTML = "";
    for (const acct of currentAccounts) {
      const li = document.createElement("li");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = "acct-" + acct.id;
      checkbox.value = acct.id;
      checkbox.checked = acct.allowed;
      checkbox.addEventListener("change", onAccountChange);

      const label = document.createElement("label");
      label.htmlFor = checkbox.id;
      label.textContent = acct.name;

      const typeSpan = document.createElement("span");
      typeSpan.className = "account-type";
      typeSpan.textContent = acct.type;
      label.appendChild(typeSpan);

      li.appendChild(checkbox);
      li.appendChild(label);
      accountList.appendChild(li);
    }

    saveBtn.disabled = false;
    if (accountRestrictionInvalid) {
      saveStatus.textContent = "The saved account restriction could not be read: every account is blocked until you save a new choice.";
      saveStatus.className = "save-status error";
    } else {
      saveStatus.textContent = "";
    }
  } catch (e) {
    accountList.innerHTML = "";
    const li = document.createElement("li");
    li.textContent = "Error loading accounts: " + e.message;
    accountList.appendChild(li);
  }
}

function onAccountChange() {
  openAllConfirmed = false;
  if (!accountRestrictionInvalid) saveStatus.textContent = "";
}

saveBtn.addEventListener("click", async () => {
  saveBtn.disabled = true;
  saveStatus.textContent = "";
  saveStatus.className = "save-status";

  const checkboxes = accountList.querySelectorAll('input[type="checkbox"]');
  const checked = [];
  let allChecked = true;
  for (const cb of checkboxes) {
    if (cb.checked) {
      checked.push(cb.value);
    } else {
      allChecked = false;
    }
  }

  // An empty selection is not "allow all": refuse it rather than open everything.
  if (checked.length === 0) {
    saveStatus.textContent = "Select at least one account.";
    saveStatus.className = "save-status error";
    saveBtn.disabled = false;
    return;
  }
  // After an unreadable restriction, opening every account takes a second click.
  if (allChecked && accountRestrictionInvalid && !openAllConfirmed) {
    openAllConfirmed = true;
    saveStatus.textContent = "The saved restriction was unreadable and everything is blocked. Click Save again to allow every account.";
    saveStatus.className = "save-status error";
    saveBtn.disabled = false;
    return;
  }

  // If all are checked, send empty array (= allow all)
  const allowedIds = allChecked ? [] : checked;

  try {
    const result = await browser.commonpostMcp.setAccountAccess(allowedIds);
    if (result.error) {
      saveStatus.textContent = result.error;
      saveStatus.className = "save-status error";
    } else {
      saveStatus.textContent = "Saved.";
      // Reload to reflect updated state
      await loadAccountAccess();
    }
  } catch (e) {
    saveStatus.textContent = "Error: " + e.message;
    saveStatus.className = "save-status error";
  }
  saveBtn.disabled = false;
});

async function loadToolAccess() {
  try {
    const data = await browser.commonpostMcp.getToolAccessConfig();
    currentTools = data.tools || [];
    const groupLabels = data.groups || {};

    if (currentTools.length === 0) {
      toolList.innerHTML = "<li>No tools found.</li>";
      return;
    }

    toolList.innerHTML = "";
    getMessagesLimitInput = null;
    getMessagesLimitStatus = null;

    // Tools arrive pre-sorted by group then CRUD order from the server.
    // Build grouped structure from tool metadata.
    let currentGroup = null;
    let currentCrud = null;

    for (const tool of currentTools) {
      const group = tool.group || "other";
      const crud = tool.crud || "other";

      // New group header
      if (group !== currentGroup) {
        currentGroup = group;
        currentCrud = null;
        const header = document.createElement("li");
        header.className = "tool-group-header";
        header.textContent = groupLabels[group] || group.charAt(0).toUpperCase() + group.slice(1);
        toolList.appendChild(header);
      }

      // New CRUD sub-header within group
      if (crud !== currentCrud) {
        currentCrud = crud;
        const subHeader = document.createElement("li");
        subHeader.className = "tool-crud-header";
        subHeader.textContent = CRUD_LABELS[crud] || crud.charAt(0).toUpperCase() + crud.slice(1);
        toolList.appendChild(subHeader);
      }

      const li = document.createElement("li");
      if (tool.name === "getMessages") {
        li.className = "tool-with-option";
      }
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = "tool-" + tool.name;
      checkbox.value = tool.name;
      checkbox.checked = tool.enabled;
      if (tool.undisableable) {
        checkbox.disabled = true;
      }
      checkbox.addEventListener("change", () => {
        saveToolsStatus.textContent = "";
        if (tool.name === "getMessages" && getMessagesLimitInput) {
          getMessagesLimitInput.disabled = !checkbox.checked;
          if (checkbox.checked) {
            validateGetMessagesLimitInput();
          } else {
            getMessagesLimitInput.removeAttribute("aria-invalid");
            if (getMessagesLimitStatus) getMessagesLimitStatus.textContent = "";
          }
        }
      });

      const label = document.createElement("label");
      label.htmlFor = checkbox.id;
      label.textContent = tool.name;
      if (tool.undisableable) {
        const lockSpan = document.createElement("span");
        lockSpan.className = "account-type";
        lockSpan.textContent = "required";
        label.appendChild(lockSpan);
      }

      li.appendChild(checkbox);
      li.appendChild(label);
      if (tool.name === "getMessages") {
        const option = document.createElement("div");
        option.className = "tool-option";

        const limitLabel = document.createElement("label");
        limitLabel.htmlFor = "getMessagesLimit";
        limitLabel.textContent = "Max messages per call";

        getMessagesLimitInput = document.createElement("input");
        getMessagesLimitInput.type = "text";
        getMessagesLimitInput.inputMode = "numeric";
        getMessagesLimitInput.id = "getMessagesLimit";
        getMessagesLimitInput.dataset.min = String(tool.getMessagesLimitMin || data.getMessagesLimitMin || 1);
        getMessagesLimitInput.dataset.max = String(tool.getMessagesLimitMax || data.getMessagesLimitMax || 20);
        getMessagesLimitInput.value = String(tool.getMessagesLimit || data.getMessagesLimit || 10);
        getMessagesLimitInput.disabled = !checkbox.checked;
        getMessagesLimitInput.addEventListener("input", () => {
          saveToolsStatus.textContent = "";
          validateGetMessagesLimitInput();
        });

        const rangeNote = document.createElement("span");
        rangeNote.className = "range-note";
        rangeNote.textContent = `1-${getMessagesLimitInput.dataset.max}`;

        getMessagesLimitStatus = document.createElement("div");
        getMessagesLimitStatus.className = "tool-limit-error";

        option.appendChild(limitLabel);
        option.appendChild(getMessagesLimitInput);
        option.appendChild(rangeNote);
        li.appendChild(option);
        li.appendChild(getMessagesLimitStatus);
      }
      toolList.appendChild(li);
    }

    saveToolsBtn.disabled = false;
    saveToolsStatus.textContent = "";
  } catch (e) {
    toolList.innerHTML = "";
    const li = document.createElement("li");
    li.textContent = "Error loading tools: " + e.message;
    toolList.appendChild(li);
  }
}

saveToolsBtn.addEventListener("click", async () => {
  saveToolsBtn.disabled = true;
  saveToolsStatus.textContent = "";
  saveToolsStatus.className = "save-status";

  const checkboxes = toolList.querySelectorAll('input[type="checkbox"]');
  const disabled = [];
  for (const cb of checkboxes) {
    if (!cb.checked && !cb.disabled) {
      disabled.push(cb.value);
    }
  }
  let getMessagesLimit;
  if (getMessagesLimitInput) {
    getMessagesLimit = validateGetMessagesLimitInput();
    if (getMessagesLimit === null) {
      saveToolsStatus.textContent = "Fix the highlighted getMessages limit before saving.";
      saveToolsStatus.className = "save-status error";
      saveToolsBtn.disabled = false;
      return;
    }
  }

  try {
    const result = await browser.commonpostMcp.setToolAccess(disabled, getMessagesLimit);
    if (result.error) {
      saveToolsStatus.textContent = result.error;
      saveToolsStatus.className = "save-status error";
    } else {
      saveToolsStatus.textContent = "Saved.";
      await loadToolAccess();
    }
  } catch (e) {
    saveToolsStatus.textContent = "Error: " + e.message;
    saveToolsStatus.className = "save-status error";
  }
  saveToolsBtn.disabled = false;
});

const blockSkipReviewCheckbox = document.getElementById("blockSkipReview");
const saveSkipReviewBtn = document.getElementById("saveSkipReviewBtn");
const saveSkipReviewStatus = document.getElementById("saveSkipReviewStatus");

async function loadSkipReviewPref() {
  try {
    const { blockSkipReview } = await browser.commonpostMcp.getBlockSkipReview();
    blockSkipReviewCheckbox.checked = !!blockSkipReview;
    saveSkipReviewBtn.disabled = false;
    saveSkipReviewStatus.textContent = "";
  } catch (e) {
    saveSkipReviewStatus.textContent = "Error loading setting: " + e.message;
    saveSkipReviewStatus.className = "save-status error";
  }
}

saveSkipReviewBtn.addEventListener("click", async () => {
  saveSkipReviewBtn.disabled = true;
  saveSkipReviewStatus.textContent = "Saving...";
  saveSkipReviewStatus.className = "save-status";
  try {
    const result = await browser.commonpostMcp.setBlockSkipReview(blockSkipReviewCheckbox.checked);
    if (result.error) {
      saveSkipReviewStatus.textContent = result.error;
      saveSkipReviewStatus.className = "save-status error";
    } else {
      saveSkipReviewStatus.textContent = "Saved.";
    }
  } catch (e) {
    saveSkipReviewStatus.textContent = "Error: " + e.message;
    saveSkipReviewStatus.className = "save-status error";
  }
  saveSkipReviewBtn.disabled = false;
});

// --- Filter rules that send mail ---
// One boolean preference (blockFilterForwardReply): true = "block" (default),
// false = "confirm" (the user is asked in a Thunderbird dialog each time).
const filterSendRulePolicyRadios = document.querySelectorAll('input[name="filterSendRulePolicy"]');
const saveFilterSendRulePolicyBtn = document.getElementById("saveFilterSendRulePolicyBtn");
const saveFilterSendRulePolicyStatus = document.getElementById("saveFilterSendRulePolicyStatus");

async function loadFilterSendRulePolicy() {
  try {
    const { blockFilterForwardReply } = await browser.commonpostMcp.getBlockFilterForwardReply();
    const policy = blockFilterForwardReply === false ? "confirm" : "block";
    for (const radio of filterSendRulePolicyRadios) {
      radio.checked = radio.value === policy;
    }
    saveFilterSendRulePolicyBtn.disabled = false;
    saveFilterSendRulePolicyStatus.textContent = "";
  } catch (e) {
    saveFilterSendRulePolicyStatus.textContent = "Error loading setting: " + e.message;
    saveFilterSendRulePolicyStatus.className = "save-status error";
  }
}

saveFilterSendRulePolicyBtn.addEventListener("click", async () => {
  const chosen = Array.from(filterSendRulePolicyRadios).find((radio) => radio.checked);
  if (!chosen) {
    saveFilterSendRulePolicyStatus.textContent = "Choose one of the two options.";
    saveFilterSendRulePolicyStatus.className = "save-status error";
    return;
  }
  saveFilterSendRulePolicyBtn.disabled = true;
  saveFilterSendRulePolicyStatus.textContent = "Saving...";
  saveFilterSendRulePolicyStatus.className = "save-status";
  try {
    const result = await browser.commonpostMcp.setBlockFilterForwardReply(chosen.value === "block");
    if (result.error) {
      saveFilterSendRulePolicyStatus.textContent = result.error;
      saveFilterSendRulePolicyStatus.className = "save-status error";
    } else {
      saveFilterSendRulePolicyStatus.textContent = "Saved.";
    }
  } catch (e) {
    saveFilterSendRulePolicyStatus.textContent = "Error: " + e.message;
    saveFilterSendRulePolicyStatus.className = "save-status error";
  }
  saveFilterSendRulePolicyBtn.disabled = false;
});

// --- Encrypted messages ---
const allowEncryptedContentCheckbox = document.getElementById("allowEncryptedContent");
const saveEncryptedContentBtn = document.getElementById("saveEncryptedContentBtn");
const saveEncryptedContentStatus = document.getElementById("saveEncryptedContentStatus");

async function loadEncryptedContentPref() {
  try {
    const { allowEncryptedContent } = await browser.commonpostMcp.getAllowEncryptedContent();
    allowEncryptedContentCheckbox.checked = allowEncryptedContent === true;
    saveEncryptedContentBtn.disabled = false;
    saveEncryptedContentStatus.textContent = "";
  } catch (e) {
    saveEncryptedContentStatus.textContent = "Error loading setting: " + e.message;
    saveEncryptedContentStatus.className = "save-status error";
  }
}

saveEncryptedContentBtn.addEventListener("click", async () => {
  saveEncryptedContentBtn.disabled = true;
  saveEncryptedContentStatus.textContent = "Saving...";
  saveEncryptedContentStatus.className = "save-status";
  try {
    const result = await browser.commonpostMcp.setAllowEncryptedContent(allowEncryptedContentCheckbox.checked);
    if (result.error) {
      saveEncryptedContentStatus.textContent = result.error;
      saveEncryptedContentStatus.className = "save-status error";
    } else {
      saveEncryptedContentStatus.textContent = "Saved.";
    }
  } catch (e) {
    saveEncryptedContentStatus.textContent = "Error: " + e.message;
    saveEncryptedContentStatus.className = "save-status error";
  }
  saveEncryptedContentBtn.disabled = false;
});

loadServerInfo().catch(e => console.error("commonpost-mcp options:", "loadServerInfo failed:", e));
loadFilterSendRulePolicy().catch(e => console.error("commonpost-mcp options:", "loadFilterSendRulePolicy failed:", e));
loadEncryptedContentPref().catch(e => console.error("commonpost-mcp options:", "loadEncryptedContentPref failed:", e));
loadAuthenticationConfig().catch(e => console.error("commonpost-mcp options:", "loadAuthenticationConfig failed:", e));
loadAccountAccess().catch(e => console.error("commonpost-mcp options:", "loadAccountAccess failed:", e));
loadToolAccess().catch(e => console.error("commonpost-mcp options:", "loadToolAccess failed:", e));
loadSkipReviewPref().catch(e => console.error("commonpost-mcp options:", "loadSkipReviewPref failed:", e));

const listenAllCheckbox = document.getElementById("listenAll");
const listenAllWarning = document.getElementById("listenAllWarning");
const saveListenAllBtn = document.getElementById("saveListenAllBtn");
const saveListenAllStatus = document.getElementById("saveListenAllStatus");

async function loadListenAllPref() {
  try {
    const { listenAll } = await browser.commonpostMcp.getListenAll();
    listenAllCheckbox.checked = !!listenAll;
    listenAllWarning.style.display = listenAllCheckbox.checked ? "block" : "none";
    saveListenAllBtn.disabled = false;
    saveListenAllStatus.textContent = "";
  } catch (e) {
    saveListenAllStatus.textContent = "Error loading setting: " + e.message;
    saveListenAllStatus.className = "save-status error";
  }
}

listenAllCheckbox.addEventListener("change", () => {
  listenAllWarning.style.display = listenAllCheckbox.checked ? "block" : "none";
});

saveListenAllBtn.addEventListener("click", async () => {
  saveListenAllBtn.disabled = true;
  saveListenAllStatus.textContent = "Saving...";
  saveListenAllStatus.className = "save-status";
  try {
    const result = await browser.commonpostMcp.setListenAll(listenAllCheckbox.checked);
    if (result.error) {
      saveListenAllStatus.textContent = result.error;
      saveListenAllStatus.className = "save-status error";
    } else {
      saveListenAllStatus.textContent = "Saved.";
      await loadServerInfo();
    }
  } catch (e) {
    saveListenAllStatus.textContent = "Error: " + e.message;
    saveListenAllStatus.className = "save-status error";
  }
  saveListenAllBtn.disabled = false;
});

loadListenAllPref();

// --- Retry a failed start (#179) ---
retryStartBtn.addEventListener("click", async () => {
  retryStartBtn.disabled = true;
  retryStartStatus.textContent = "Starting...";
  retryStartStatus.className = "save-status";
  try {
    const result = await browser.commonpostMcp.retryStart();
    if (result && result.success) {
      retryStartStatus.textContent = result.alreadyRunning ? "Already running." : "Started.";
    } else {
      retryStartStatus.textContent = "Failed: " + ((result && result.error) || "unknown error");
      retryStartStatus.className = "save-status error";
    }
  } catch (e) {
    retryStartStatus.textContent = "Error: " + e.message;
    retryStartStatus.className = "save-status error";
  }
  retryStartBtn.disabled = false;
  await loadServerInfo();
  // The session token and connection file change on a successful start.
  loadAuthenticationConfig().catch(e => console.error("commonpost-mcp options:", "loadAuthenticationConfig failed:", e));
});

// --- Bridge (the MCP bridges that connected since Thunderbird started) ---
const bridgeThresholds = document.getElementById("bridgeThresholds");
const bridgeEmpty = document.getElementById("bridgeEmpty");
const bridgeList = document.getElementById("bridgeList");
const bridgeRefreshBtn = document.getElementById("bridgeRefreshBtn");
const bridgeRefreshStatus = document.getElementById("bridgeRefreshStatus");

// Checked again here: only a release page of this repository is ever linked.
const BRIDGE_RELEASE_URL_PATTERN = /^https:\/\/github\.com\/commonpost\/thunderbird-mcp\/releases\/(tag\/v\d{1,6}\.\d{1,6}\.\d{1,6}|latest)$/;
const BRIDGE_PACKAGING_LABELS = {
  mcpb: ".mcpb bundle (Claude Desktop)",
  file: "mcp-bridge.cjs file",
};
const BRIDGE_STATE_LABELS = {
  "up-to-date": "Up to date.",
  "newer-available": "Newer version available: this bridge works, the update is optional.",
  "update-recommended": "Update recommended.",
  "unversioned": "Update recommended: this bridge does not report a readable version.",
  "development": "Development build: not checked.",
  "refused": "Refused: older than the security floor of this add-on (no tool works with it).",
  "newer-than-add-on": "Newer than this add-on: in Add-ons and Themes, choose Check for Updates in the gear menu, then restart Thunderbird.",
};
const BRIDGE_ADVICE_LABELS = {
  mcpb: "Download the .mcpb bundle from the release page and install it in Claude Desktop again: open the file with Claude Desktop, or use Settings > Extensions > Advanced settings > Install Extension.",
  other: "Download mcp-bridge.cjs from the release page and put it in place of the copy your MCP client runs (its path is in the MCP configuration of the client; in Claude Code: claude mcp get <server name>), then restart the client or reconnect the server.",
};

function bridgeVersionLabel(bridge) {
  if (bridge.version === null) {
    return bridge.packaging === "none" ? "not reported (bridge 0.11 or older, or another HTTP client)" : "unreadable";
  }
  return bridge.version === "0.0.0" ? "development build (0.0.0)" : bridge.version;
}

function bridgeLine(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div;
}

const BRIDGE_VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

function validBridgeVersion(version) {
  return typeof version === "string" && BRIDGE_VERSION_PATTERN.test(version) ? version : null;
}

function bridgeStatusLabel(bridge, currentBridgeVersion) {
  const current = validBridgeVersion(currentBridgeVersion);
  if (bridge.state === "newer-available" && current) {
    return `Newer version available (${current}): this bridge works, the update is optional.`;
  }
  return BRIDGE_STATE_LABELS[bridge.state] || bridge.state;
}

function renderBridge(bridge, currentBridgeVersion) {
  const li = document.createElement("li");
  li.appendChild(bridgeLine("Version: " + bridgeVersionLabel(bridge)));
  li.appendChild(bridgeLine("Installed as: " + (BRIDGE_PACKAGING_LABELS[bridge.packaging] || "unknown")));
  if (bridge.profile) {
    li.appendChild(bridgeLine("Profile: " + bridge.profile));
  } else if (bridge.profileInvalid) {
    li.appendChild(bridgeLine("Profile: invalid (ignored)"));
  }
  li.appendChild(bridgeLine("Last seen: " + new Date(bridge.lastSeen).toLocaleString()));
  li.appendChild(bridgeLine("Status: " + bridgeStatusLabel(bridge, currentBridgeVersion)));
  const needsUpdate = ["newer-available", "update-recommended", "unversioned", "refused"].includes(bridge.state);
  if (needsUpdate) {
    li.appendChild(bridgeLine(bridge.packaging === "mcpb" ? BRIDGE_ADVICE_LABELS.mcpb : BRIDGE_ADVICE_LABELS.other));
  }
  if ((needsUpdate || bridge.state === "newer-than-add-on") && BRIDGE_RELEASE_URL_PATTERN.test(bridge.releaseUrl)) {
    const line = bridgeLine("Release page: ");
    const link = document.createElement("a");
    link.href = bridge.releaseUrl;
    link.textContent = bridge.releaseUrl;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      browser.windows.openDefaultBrowser(bridge.releaseUrl).catch((e) => console.error("commonpost-mcp options:", "openDefaultBrowser failed:", e));
    });
    line.appendChild(link);
    li.appendChild(line);
  }
  return li;
}

async function loadBridgeStatus() {
  try {
    const status = await browser.commonpostMcp.getBridgeStatus();
    let text = status.extensionVersion
      ? `This add-on (version ${status.extensionVersion}) recommends bridge ${status.minBridgeVersion} or newer.`
      : `This add-on recommends bridge ${status.minBridgeVersion} or newer.`;
    if (status.securityFloor !== "0.0.0") {
      text += ` It refuses bridges older than ${status.securityFloor}.`;
    }
    const current = validBridgeVersion(status.currentBridgeVersion);
    if (current) text += ` The bridge published with it is ${current}.`;
    bridgeThresholds.textContent = text;
    bridgeList.replaceChildren(...status.bridges.map((bridge) => renderBridge(bridge, status.currentBridgeVersion)));
    bridgeEmpty.hidden = status.bridges.length > 0;
    bridgeRefreshStatus.textContent = "";
    bridgeRefreshStatus.className = "save-status";
  } catch (e) {
    bridgeRefreshStatus.textContent = "Error: " + e.message;
    bridgeRefreshStatus.className = "save-status error";
  }
}

bridgeRefreshBtn.addEventListener("click", () => {
  loadBridgeStatus().catch(e => console.error("commonpost-mcp options:", "loadBridgeStatus failed:", e));
});
loadBridgeStatus().catch(e => console.error("commonpost-mcp options:", "loadBridgeStatus failed:", e));
