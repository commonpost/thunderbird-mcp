// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
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
const toolDetails = document.getElementById("toolDetails");
const toolSummary = document.getElementById("toolSummary");
const saveToolsBtn = document.getElementById("saveToolsBtn");
const saveToolsStatus = document.getElementById("saveToolsStatus");
const newToolsNote = document.getElementById("newToolsNote");

const currentAuthTokenInput = document.getElementById("currentAuthToken");
const copyAuthTokenBtn = document.getElementById("copyAuthTokenBtn");
const copyAuthTokenStatus = document.getElementById("copyAuthTokenStatus");
const useStableAuthTokenCheckbox = document.getElementById("useStableAuthToken");
const stableAuthTokenControls = document.getElementById("stableAuthTokenControls");
const stableAuthTokenInput = document.getElementById("stableAuthToken");
const generateStableAuthTokenBtn = document.getElementById("generateStableAuthTokenBtn");
const regenerateStableAuthTokenBtn = document.getElementById("regenerateStableAuthTokenBtn");
const stableAuthTokenStatus = document.getElementById("stableAuthTokenStatus");

// --- Language ---
// The page shows Thunderbird's language when _locales has it, English otherwise. The English text stays in
// options.html and in the fallbacks below, so the page reads the same without browser.i18n (tests).
const i18n = (typeof browser !== "undefined" && browser.i18n) ? browser.i18n : null;

// The message `key` of _locales/<lang>/messages.json, with its $1-$9 `substitutions`, or `fallback` (the English text).
function t(key, substitutions, fallback) {
  if (!i18n || !key) return fallback;
  try {
    const text = substitutions == null
      ? i18n.getMessage(key)
      : i18n.getMessage(key, substitutions.map((value) => String(value)));
    return text || fallback;
  } catch (e) {
    console.error("commonpost-mcp options:", "getMessage failed:", key, e);
    return fallback;
  }
}

// A message holding code or a link: `fallback` is the English as a list of parts (text, { code } or an element),
// and the message has one placeholder per part that is not text, in the same order. Returns the parts in the
// language of the page, for bridgeRich.
const PART_MARK = "\u0001";
function tParts(key, fallback) {
  const parts = fallback.filter((part) => typeof part !== "string");
  const text = t(key, parts.map((_, i) => `${PART_MARK}${i}${PART_MARK}`), "");
  if (!text) return fallback;
  return text.split(PART_MARK).map((piece, i) => (i % 2 ? parts[Number(piece)] : piece)).filter((piece) => piece !== "" && piece !== undefined);
}

// "en" when the page is in English (also without browser.i18n), else the language of _locales in use.
const pageLanguage = t("pageLanguage", null, "en");

// Labels sent by the add-on (group names, tool titles) are English: another language replaces them by id.
function addonLabel(key, english) {
  return pageLanguage === "en" ? english : t(key, null, english);
}

function errorText(e) {
  return t("errorWithMessage", [e.message], `Error: ${e.message}`);
}

// Elements of options.html with data-i18n (text), data-i18n-placeholder or data-i18n-aria-label get their message.
function localizePage() {
  if (!i18n) return;
  const attributes = [["data-i18n-placeholder", "placeholder"], ["data-i18n-aria-label", "aria-label"]];
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const text = t(el.getAttribute("data-i18n"), null, "");
    if (text) el.textContent = text;
  }
  for (const [marker, attribute] of attributes) {
    for (const el of document.querySelectorAll(`[${marker}]`)) {
      const text = t(el.getAttribute(marker), null, "");
      if (text) el.setAttribute(attribute, text);
    }
  }
  if (document.documentElement) document.documentElement.lang = pageLanguage;
}

localizePage();

let currentAccounts = [];
let currentTools = [];
let getMessagesLimitInput = null;
let getMessagesLimitStatus = null;

// CRUD labels for sub-group headers
// Thunderbird's account types as a user knows them; Local Folders has the type "none".
const ACCOUNT_TYPE_LABELS = { none: "local", pop3: "POP3", imap: "IMAP", nntp: "news", rss: "feeds", ews: "Exchange", owl: "Exchange" };

const ACCOUNT_TYPE_MESSAGES = { none: "accountTypeLocal", nntp: "accountTypeNews", rss: "accountTypeFeeds" };

const CRUD_LABELS = { read: "Read", create: "Create", update: "Change", delete: "Delete" };
const CRUD_MESSAGES = { read: "crudRead", create: "crudCreate", update: "crudUpdate", delete: "crudDelete" };

// "all 42 on" or "38 of 42 on", next to "Choose tools one by one", so a closed list still tells its state.
function updateToolSummary() {
  const boxes = [...toolList.querySelectorAll('input[type="checkbox"]')];
  if (boxes.length === 0) {
    toolSummary.textContent = "";
    return;
  }
  const on = boxes.filter((cb) => cb.checked).length;
  toolSummary.textContent = on === boxes.length
    ? t("toolSummaryAll", [on], `(all ${on} on)`)
    : t("toolSummarySome", [on, boxes.length], `(${on} of ${boxes.length} on)`);
}

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
      getMessagesLimitStatus.textContent = t("limitRange", [min, max], `Enter an integer from ${min} to ${max}.`);
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
      statusText.textContent = t("statusRunning", null, "Running");
      serverPort.textContent = info.port || "--";
      connFile.textContent = info.connectionFile || "--";
    } else if (info.startError) {
      // A failed start used to be shown as "Running" (#179): show the error.
      statusDot.className = "status-dot stopped";
      statusText.textContent = t("statusStartFailed", null, "Start failed");
      serverPort.textContent = "--";
      connFile.textContent = "--";
    } else {
      statusDot.className = "status-dot stopped";
      statusText.textContent = t("statusNotRunning", null, "Not running");
      serverPort.textContent = "--";
      connFile.textContent = "--";
    }
    originalExtensionRow.hidden = !info.originalExtensionActive;
    if (!info.running) {
      // Offered whenever the server is not bound (failed or never started).
      startErrorText.textContent = info.startError
        ? info.startError + (info.startErrorAt ? " (" + info.startErrorAt.replace("T", " ").replace(/\.\d+Z$/, " UTC") + ")" : "")
        : t("serverNotRunning", null, "Server is not running.");
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
    statusText.textContent = errorText(e);
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
    throw new Error(t("generatedTokenEmpty", null, "Generated token was empty"));
  }
  return result.authToken;
}

async function saveStableAuthTokenValue(value, successMessage = t("saved", null, "Saved.")) {
  const stableAuthToken = value.trim();
  setStableAuthTokenStatus(t("saving", null, "Saving..."));
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
    setStableAuthTokenStatus(errorText(e), true);
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
    setStableAuthTokenStatus(errorText(e), true);
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
    copyAuthTokenStatus.textContent = t("errorLoadingToken", [e.message], `Error loading token: ${e.message}`);
    copyAuthTokenStatus.className = "save-status error";
    setStableAuthTokenStatus(t("errorLoadingSetting", [e.message], `Error loading setting: ${e.message}`), true);
  }
}

copyAuthTokenBtn.addEventListener("click", async () => {
  copyAuthTokenStatus.textContent = "";
  copyAuthTokenStatus.className = "save-status";
  copyAuthTokenBtn.disabled = true;
  try {
    await navigator.clipboard.writeText(currentAuthTokenInput.value);
    copyAuthTokenStatus.textContent = t("copied", null, "Copied.");
  } catch (e) {
    copyAuthTokenStatus.textContent = errorText(e);
    copyAuthTokenStatus.className = "save-status error";
  }
  copyAuthTokenBtn.disabled = !currentAuthTokenInput.value;
});

useStableAuthTokenCheckbox.addEventListener("change", async () => {
  updateStableAuthTokenControls();
  if (useStableAuthTokenCheckbox.checked) {
    if (!stableAuthTokenInput.value.trim()) {
      await generateAndStoreStableAuthToken(t("generatedAndSaved", null, "Generated and saved."));
    } else {
      await updateStoredStableAuthToken(stableAuthTokenInput.value, t("saved", null, "Saved."));
    }
  } else {
    stableAuthTokenInput.value = "";
    await updateStoredStableAuthToken("", t("stableTokenCleared", null, "Stable token cleared."));
  }
});

stableAuthTokenInput.addEventListener("change", async () => {
  if (!useStableAuthTokenCheckbox.checked) {
    return;
  }
  if (!stableAuthTokenInput.value.trim()) {
    await generateAndStoreStableAuthToken(t("generatedAndSaved", null, "Generated and saved."));
  } else {
    await updateStoredStableAuthToken(stableAuthTokenInput.value, t("saved", null, "Saved."));
  }
});

generateStableAuthTokenBtn.addEventListener("click", async () => {
  await generateAndStoreStableAuthToken(t("generatedAndSaved", null, "Generated and saved."));
});

regenerateStableAuthTokenBtn.addEventListener("click", async () => {
  await generateAndStoreStableAuthToken(t("regeneratedAndSaved", null, "Regenerated and saved."));
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
      const empty = document.createElement("li");
      empty.textContent = t("noAccounts", null, "No accounts found.");
      accountList.replaceChildren(empty);
      return;
    }

    accountList.replaceChildren();
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
      typeSpan.textContent = t(ACCOUNT_TYPE_MESSAGES[acct.type], null, ACCOUNT_TYPE_LABELS[acct.type] || acct.type);
      label.appendChild(typeSpan);

      li.appendChild(checkbox);
      li.appendChild(label);
      accountList.appendChild(li);
    }

    saveBtn.disabled = false;
    if (accountRestrictionInvalid) {
      saveStatus.textContent = t("accountRestrictionUnreadable", null, "The saved account restriction could not be read: every account is blocked until you save a new choice.");
      saveStatus.className = "save-status error";
    } else {
      saveStatus.textContent = "";
    }
  } catch (e) {
    const li = document.createElement("li");
    li.textContent = t("errorLoadingAccounts", [e.message], `Error loading accounts: ${e.message}`);
    accountList.replaceChildren(li);
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
    saveStatus.textContent = t("selectOneAccount", null, "Select at least one account.");
    saveStatus.className = "save-status error";
    saveBtn.disabled = false;
    return;
  }
  // After an unreadable restriction, opening every account takes a second click.
  if (allChecked && accountRestrictionInvalid && !openAllConfirmed) {
    openAllConfirmed = true;
    saveStatus.textContent = t("confirmOpenAll", null, "The saved restriction was unreadable and everything is blocked. Click Save again to allow every account.");
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
      // Reload to reflect updated state; the reload clears the status line, so confirm after it
      await loadAccountAccess();
      if (!saveStatus.textContent) saveStatus.textContent = t("saved", null, "Saved.");
    }
  } catch (e) {
    saveStatus.textContent = errorText(e);
    saveStatus.className = "save-status error";
  }
  saveBtn.disabled = false;
});

async function loadToolAccess() {
  try {
    const data = await browser.commonpostMcp.getToolAccessConfig();
    currentTools = data.tools || [];
    const groupLabels = data.groups || {};
    const newTools = Array.isArray(data.newTools) ? data.newTools : [];
    newToolsNote.textContent = newTools.length
      ? t("newToolsNote", [newTools.join(", ")], `Added by an update and disabled because you restricted the tools: ${newTools.join(", ")}. Check and save to enable.`)
      : "";
    newToolsNote.hidden = newTools.length === 0;
    // Tools that wait for the user's choice are shown, not folded away.
    if (newTools.length) toolDetails.open = true;

    if (currentTools.length === 0) {
      const empty = document.createElement("li");
      empty.textContent = t("noTools", null, "No tools found.");
      toolList.replaceChildren(empty);
      return;
    }

    toolList.replaceChildren();
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
        header.textContent = addonLabel("toolGroup_" + group, groupLabels[group] || group.charAt(0).toUpperCase() + group.slice(1));
        toolList.appendChild(header);
      }

      // New CRUD sub-header within group
      if (crud !== currentCrud) {
        currentCrud = crud;
        const subHeader = document.createElement("li");
        subHeader.className = "tool-crud-header";
        subHeader.textContent = t(CRUD_MESSAGES[crud], null, CRUD_LABELS[crud] || crud.charAt(0).toUpperCase() + crud.slice(1));
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
        updateToolSummary();
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
      // The tool's title in words, then its name as clients see it.
      label.textContent = tool.title ? addonLabel("toolTitle_" + tool.name, tool.title) : tool.name;
      if (tool.title) {
        const nameSpan = document.createElement("code");
        nameSpan.className = "tool-name";
        nameSpan.textContent = tool.name;
        label.append(" ", nameSpan);
      }
      if (tool.undisableable) {
        const lockSpan = document.createElement("span");
        lockSpan.className = "account-type";
        lockSpan.textContent = t("toolRequired", null, "required");
        label.appendChild(lockSpan);
      }
      if (tool.isNew) {
        const newSpan = document.createElement("span");
        newSpan.className = "account-type";
        newSpan.textContent = t("toolNew", null, "new");
        label.appendChild(newSpan);
      }

      li.appendChild(checkbox);
      li.appendChild(label);
      if (tool.name === "getMessages") {
        const option = document.createElement("div");
        option.className = "tool-option";

        const limitLabel = document.createElement("label");
        limitLabel.htmlFor = "getMessagesLimit";
        // headersOnly reads headers only, up to its own fixed limit
        limitLabel.textContent = t("getMessagesLimitLabel", null, "Max full messages per call");

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
    updateToolSummary();
  } catch (e) {
    const li = document.createElement("li");
    li.textContent = t("errorLoadingTools", [e.message], `Error loading tools: ${e.message}`);
    toolList.replaceChildren(li);
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
  // A disabled limit field (getMessages unchecked) is not sent: the stored limit stays as it is
  if (getMessagesLimitInput && !getMessagesLimitInput.disabled) {
    getMessagesLimit = validateGetMessagesLimitInput();
    if (getMessagesLimit === null) {
      saveToolsStatus.textContent = t("fixLimit", null, "Fix the highlighted getMessages limit before saving.");
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
      // The reload clears the status line, so confirm after it
      await loadToolAccess();
      if (!saveToolsStatus.textContent) saveToolsStatus.textContent = t("saved", null, "Saved.");
    }
  } catch (e) {
    saveToolsStatus.textContent = errorText(e);
    saveToolsStatus.className = "save-status error";
  }
  saveToolsBtn.disabled = false;
});

const blockSkipReviewCheckbox = document.getElementById("blockSkipReview");
const blockCalendarSkipReviewCheckbox = document.getElementById("blockCalendarSkipReview");
const saveSkipReviewBtn = document.getElementById("saveSkipReviewBtn");
const saveSkipReviewStatus = document.getElementById("saveSkipReviewStatus");

// Two blocks, saved together. Until it is set, the block for events and tasks
// follows the one for mail and shows its value; saving writes both, so each
// box then keeps what it shows.
async function loadSkipReviewPref() {
  try {
    const [{ blockSkipReview }, { blockCalendarSkipReview }] = await Promise.all([
      browser.commonpostMcp.getBlockSkipReview(),
      browser.commonpostMcp.getBlockCalendarSkipReview(),
    ]);
    blockSkipReviewCheckbox.checked = !!blockSkipReview;
    blockCalendarSkipReviewCheckbox.checked = !!blockCalendarSkipReview;
    saveSkipReviewBtn.disabled = false;
    saveSkipReviewStatus.textContent = "";
  } catch (e) {
    saveSkipReviewStatus.textContent = t("errorLoadingSetting", [e.message], `Error loading setting: ${e.message}`);
    saveSkipReviewStatus.className = "save-status error";
  }
}

saveSkipReviewBtn.addEventListener("click", async () => {
  saveSkipReviewBtn.disabled = true;
  saveSkipReviewStatus.textContent = t("saving", null, "Saving...");
  saveSkipReviewStatus.className = "save-status";
  try {
    // The block for events and tasks first: while it is not set it follows
    // the one for mail, so writing the mail block alone could lift it.
    let result = await browser.commonpostMcp.setBlockCalendarSkipReview(blockCalendarSkipReviewCheckbox.checked);
    if (!result.error) {
      result = await browser.commonpostMcp.setBlockSkipReview(blockSkipReviewCheckbox.checked);
    }
    if (result.error) {
      saveSkipReviewStatus.textContent = result.error;
      saveSkipReviewStatus.className = "save-status error";
    } else {
      saveSkipReviewStatus.textContent = t("saved", null, "Saved.");
    }
  } catch (e) {
    saveSkipReviewStatus.textContent = errorText(e);
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
    saveFilterSendRulePolicyStatus.textContent = t("errorLoadingSetting", [e.message], `Error loading setting: ${e.message}`);
    saveFilterSendRulePolicyStatus.className = "save-status error";
  }
}

saveFilterSendRulePolicyBtn.addEventListener("click", async () => {
  const chosen = Array.from(filterSendRulePolicyRadios).find((radio) => radio.checked);
  if (!chosen) {
    saveFilterSendRulePolicyStatus.textContent = t("chooseOneOption", null, "Choose one of the two options.");
    saveFilterSendRulePolicyStatus.className = "save-status error";
    return;
  }
  saveFilterSendRulePolicyBtn.disabled = true;
  saveFilterSendRulePolicyStatus.textContent = t("saving", null, "Saving...");
  saveFilterSendRulePolicyStatus.className = "save-status";
  try {
    const result = await browser.commonpostMcp.setBlockFilterForwardReply(chosen.value === "block");
    if (result.error) {
      saveFilterSendRulePolicyStatus.textContent = result.error;
      saveFilterSendRulePolicyStatus.className = "save-status error";
    } else {
      saveFilterSendRulePolicyStatus.textContent = t("saved", null, "Saved.");
    }
  } catch (e) {
    saveFilterSendRulePolicyStatus.textContent = errorText(e);
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
    saveEncryptedContentStatus.textContent = t("errorLoadingSetting", [e.message], `Error loading setting: ${e.message}`);
    saveEncryptedContentStatus.className = "save-status error";
  }
}

saveEncryptedContentBtn.addEventListener("click", async () => {
  saveEncryptedContentBtn.disabled = true;
  saveEncryptedContentStatus.textContent = t("saving", null, "Saving...");
  saveEncryptedContentStatus.className = "save-status";
  try {
    const result = await browser.commonpostMcp.setAllowEncryptedContent(allowEncryptedContentCheckbox.checked);
    if (result.error) {
      saveEncryptedContentStatus.textContent = result.error;
      saveEncryptedContentStatus.className = "save-status error";
    } else {
      saveEncryptedContentStatus.textContent = t("saved", null, "Saved.");
    }
  } catch (e) {
    saveEncryptedContentStatus.textContent = errorText(e);
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
    saveListenAllStatus.textContent = t("errorLoadingSetting", [e.message], `Error loading setting: ${e.message}`);
    saveListenAllStatus.className = "save-status error";
  }
}

listenAllCheckbox.addEventListener("change", () => {
  listenAllWarning.style.display = listenAllCheckbox.checked ? "block" : "none";
});

saveListenAllBtn.addEventListener("click", async () => {
  saveListenAllBtn.disabled = true;
  saveListenAllStatus.textContent = t("saving", null, "Saving...");
  saveListenAllStatus.className = "save-status";
  try {
    const result = await browser.commonpostMcp.setListenAll(listenAllCheckbox.checked);
    if (result.error) {
      saveListenAllStatus.textContent = result.error;
      saveListenAllStatus.className = "save-status error";
    } else {
      saveListenAllStatus.textContent = t("saved", null, "Saved.");
      await loadServerInfo();
    }
  } catch (e) {
    saveListenAllStatus.textContent = errorText(e);
    saveListenAllStatus.className = "save-status error";
  }
  saveListenAllBtn.disabled = false;
});

loadListenAllPref();

// --- Retry a failed start (#179) ---
retryStartBtn.addEventListener("click", async () => {
  retryStartBtn.disabled = true;
  retryStartStatus.textContent = t("starting", null, "Starting...");
  retryStartStatus.className = "save-status";
  try {
    const result = await browser.commonpostMcp.retryStart();
    if (result && result.success) {
      retryStartStatus.textContent = result.alreadyRunning
        ? t("alreadyRunning", null, "Already running.")
        : t("started", null, "Started.");
    } else {
      const reason = (result && result.error) || t("unknownError", null, "unknown error");
      retryStartStatus.textContent = t("retryFailed", [reason], `Failed: ${reason}`);
      retryStartStatus.className = "save-status error";
    }
  } catch (e) {
    retryStartStatus.textContent = errorText(e);
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
const BRIDGE_PACKAGING_MESSAGES = {
  mcpb: "bridgePackagingMcpb",
  file: "bridgePackagingFile",
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
const BRIDGE_STATE_MESSAGES = {
  "up-to-date": "bridgeStateUpToDate",
  "newer-available": "bridgeStateNewerAvailable",
  "update-recommended": "bridgeStateUpdateRecommended",
  "unversioned": "bridgeStateUnversioned",
  "development": "bridgeStateDevelopment",
  "refused": "bridgeStateRefused",
  "newer-than-add-on": "bridgeStateNewerThanAddOn",
};
// How to update, step by step, with a direct link to the file: a user sent to the release page has to pick one file
// out of seven and still find where it goes. A step is a message key and its English as a list of parts: text,
// or { code } for a command or a name (see tParts).
const BRIDGE_UPDATE_STEPS = {
  mcpb: [
    { key: "bridgeStepMcpbOpen", text: ["Open the downloaded file with Claude Desktop: it replaces the installed bundle. If it does not open there (Windows), use Settings > Extensions > Advanced settings > Install Extension."] },
  ],
  file: [
    {
      key: "bridgeStepFileReplace",
      text: ["Put the downloaded file in place of the ", { code: "mcp-bridge.cjs" }, " that your MCP client starts: same name, same folder."],
      where: [
        { key: "bridgeWhereClaudeCode", text: ["Claude Code: ", { code: "claude mcp list" }, " names the server, ", { code: "claude mcp get <name>" }, " shows the path."] },
        { key: "bridgeWhereOtherClients", text: ["Other clients: the path is in the arguments of the server, in the MCP configuration of the client."] },
      ],
    },
    { key: "bridgeStepRestart", text: ["Restart the MCP client, or reconnect the server (in Claude Code: ", { code: "/mcp" }, ")."] },
  ],
};
const BRIDGE_PLUGIN_NOTE = ["Claude Code with the Commonpost plugin: nothing to download. Run ", { code: "/plugin marketplace update commonpost" }, ", then ", { code: "/reload-plugins" }, "."];

// Parts: text, { code } or an element (a link).
function bridgeRich(el, parts) {
  for (const part of parts) {
    if (typeof part === "string") {
      el.append(part);
    } else if (part.nodeType) {
      el.append(part);
    } else {
      const code = document.createElement("code");
      code.textContent = part.code;
      el.append(code);
    }
  }
  return el;
}

// A direct link to the file of the release the add-on points at: the .mcpb is named after the bridge version it
// carries, mcp-bridge.cjs after nothing. Built only from a release URL that passed BRIDGE_RELEASE_URL_PATTERN.
function bridgeDownload(bridge, currentBridgeVersion) {
  const m = /\/releases\/(?:tag\/(v\d{1,6}\.\d{1,6}\.\d{1,6})|latest)$/.exec(bridge.releaseUrl);
  if (!m) return null;
  const base = "https://github.com/commonpost/thunderbird-mcp/releases/" + (m[1] ? `download/${m[1]}/` : "latest/download/");
  if (bridge.packaging !== "mcpb") return { name: "mcp-bridge.cjs", url: base + "mcp-bridge.cjs" };
  const current = validBridgeVersion(currentBridgeVersion);
  if (!current) return null;
  const name = `commonpost-mcp-v${current}.mcpb`;
  return { name, url: base + name };
}

function bridgeLink(url, text) {
  const link = document.createElement("a");
  link.href = url;
  link.textContent = text;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    browser.windows.openDefaultBrowser(url).catch((e) => console.error("commonpost-mcp options:", "openDefaultBrowser failed:", e));
  });
  return link;
}

function bridgeVersionLabel(bridge) {
  if (bridge.version === null) {
    return bridge.packaging === "none"
      ? t("bridgeVersionNotReported", null, "not reported (bridge 0.11 or older, or another HTTP client)")
      : t("bridgeVersionUnreadable", null, "unreadable");
  }
  return bridge.version === "0.0.0" ? t("bridgeVersionDevelopment", null, "development build (0.0.0)") : bridge.version;
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
    return t("bridgeStateNewerAvailableVersion", [current], `Newer version available (${current}): this bridge works, the update is optional.`);
  }
  return t(BRIDGE_STATE_MESSAGES[bridge.state], null, BRIDGE_STATE_LABELS[bridge.state] || bridge.state);
}

function renderBridge(bridge, currentBridgeVersion) {
  const li = document.createElement("li");
  li.className = "bridge-entry";
  const version = bridgeVersionLabel(bridge);
  li.appendChild(bridgeLine(t("bridgeLineVersion", [version], `Version: ${version}`)));
  const packaging = t(BRIDGE_PACKAGING_MESSAGES[bridge.packaging], null, BRIDGE_PACKAGING_LABELS[bridge.packaging])
    || t("bridgePackagingUnknown", null, "unknown");
  li.appendChild(bridgeLine(t("bridgeLineInstalledAs", [packaging], `Installed as: ${packaging}`)));
  if (bridge.profile) {
    li.appendChild(bridgeLine(t("bridgeLineProfile", [bridge.profile], `Profile: ${bridge.profile}`)));
  } else if (bridge.profileInvalid) {
    li.appendChild(bridgeLine(t("bridgeLineProfileInvalid", null, "Profile: invalid (ignored)")));
  }
  const lastSeen = new Date(bridge.lastSeen).toLocaleString();
  li.appendChild(bridgeLine(t("bridgeLineLastSeen", [lastSeen], `Last seen: ${lastSeen}`)));
  const status = bridgeStatusLabel(bridge, currentBridgeVersion);
  li.appendChild(bridgeLine(t("bridgeLineStatus", [status], `Status: ${status}`)));
  const needsUpdate = ["newer-available", "update-recommended", "unversioned", "refused"].includes(bridge.state);
  const releaseOk = BRIDGE_RELEASE_URL_PATTERN.test(bridge.releaseUrl);
  if (needsUpdate) {
    li.appendChild(bridgeLine(t("bridgeToUpdate", null, "To update this bridge:")));
    const steps = document.createElement("ol");
    steps.className = "bridge-steps";
    const download = releaseOk ? bridgeDownload(bridge, currentBridgeVersion) : null;
    const first = document.createElement("li");
    if (download) {
      bridgeRich(first, tParts("bridgeStepDownload", ["Download ", bridgeLink(download.url, download.name), "."]));
    } else {
      first.textContent = bridge.packaging === "mcpb"
        ? t("bridgeStepDownloadMcpbFromRelease", null, "Download the .mcpb bundle from the release of this add-on, on the Releases page of github.com/commonpost/thunderbird-mcp.")
        : t("bridgeStepDownloadFileFromRelease", null, "Download mcp-bridge.cjs from the release of this add-on, on the Releases page of github.com/commonpost/thunderbird-mcp.");
    }
    steps.appendChild(first);
    for (const step of BRIDGE_UPDATE_STEPS[bridge.packaging === "mcpb" ? "mcpb" : "file"]) {
      const item = bridgeRich(document.createElement("li"), tParts(step.key, step.text));
      if (step.where) {
        const where = document.createElement("ul");
        for (const place of step.where) where.appendChild(bridgeRich(document.createElement("li"), tParts(place.key, place.text)));
        item.appendChild(where);
      }
      steps.appendChild(item);
    }
    li.appendChild(steps);
    if (bridge.packaging !== "mcpb") li.appendChild(bridgeRich(bridgeLine(""), tParts("bridgePluginNote", BRIDGE_PLUGIN_NOTE)));
  }
  if ((needsUpdate || bridge.state === "newer-than-add-on") && releaseOk) {
    const line = bridgeLine((needsUpdate ? t("bridgeReleaseNotes", null, "Release notes:") : t("bridgeReleasePage", null, "Release page:")) + " ");
    line.appendChild(bridgeLink(bridge.releaseUrl, bridge.releaseUrl));
    li.appendChild(line);
  }
  return li;
}

async function loadBridgeStatus() {
  try {
    const status = await browser.commonpostMcp.getBridgeStatus();
    const sentences = [status.extensionVersion
      ? t("bridgeThresholdWithVersion", [status.extensionVersion, status.minBridgeVersion], `This add-on (version ${status.extensionVersion}) recommends bridge ${status.minBridgeVersion} or newer.`)
      : t("bridgeThreshold", [status.minBridgeVersion], `This add-on recommends bridge ${status.minBridgeVersion} or newer.`)];
    if (status.securityFloor !== "0.0.0") {
      sentences.push(t("bridgeThresholdFloor", [status.securityFloor], `It refuses bridges older than ${status.securityFloor}.`));
    }
    const current = validBridgeVersion(status.currentBridgeVersion);
    if (current) sentences.push(t("bridgeThresholdPublished", [current], `The bridge published with it is ${current}.`));
    bridgeThresholds.textContent = sentences.join(" ");
    bridgeList.replaceChildren(...status.bridges.map((bridge) => renderBridge(bridge, status.currentBridgeVersion)));
    bridgeEmpty.hidden = status.bridges.length > 0;
    bridgeRefreshStatus.textContent = "";
    bridgeRefreshStatus.className = "save-status";
  } catch (e) {
    bridgeRefreshStatus.textContent = errorText(e);
    bridgeRefreshStatus.className = "save-status error";
  }
}

bridgeRefreshBtn.addEventListener("click", () => {
  loadBridgeStatus().catch(e => console.error("commonpost-mcp options:", "loadBridgeStatus failed:", e));
});
loadBridgeStatus().catch(e => console.error("commonpost-mcp options:", "loadBridgeStatus failed:", e));
