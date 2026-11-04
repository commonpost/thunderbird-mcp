// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
// Throw-away profile of the inspection image (setup.sh, start.sh), from the end-to-end lab's: a Local Folders
// account only, no first-run windows, nothing that reaches the network on its own, and the add-on of the checkout
// installed unsigned. Never use it for real mail.
/* global user_pref */
user_pref("mail.accountmanager.accounts", "account1");
user_pref("mail.accountmanager.localfoldersserver", "server1");
user_pref("mail.account.account1.server", "server1");
user_pref("mail.server.server1.type", "none");
user_pref("mail.server.server1.hostname", "Local Folders");
user_pref("mail.server.server1.userName", "nobody");
user_pref("mail.server.server1.name", "Local Folders");
user_pref("mail.server.server1.directory-rel", "[ProfD]Mail/Local Folders");

// --- First run, start pages, prompts.
user_pref("mail.provider.suppress_dialog_on_startup", true);
user_pref("mail.shell.checkDefaultClient", false);
user_pref("mailnews.start_page.enabled", false);
user_pref("mailnews.start_page.url", "about:blank");
user_pref("mailnews.start_page.override_url", "");
user_pref("mail.rights.version", 1);
user_pref("mail.inappnotifications.enabled", false);
user_pref("app.donation.eoy.version.viewed", 999);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("mail.winsearch.firstRunDone", true);
user_pref("mail.spotlight.firstRunDone", true);
user_pref("mail.openpgp.enable", false);
user_pref("mail.cloud_files.enabled", false);
user_pref("mail.tabs.firstTab.startupPage", "");
user_pref("toolkit.startup.max_resumed_crashes", -1);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("mailnews.database.global.indexer.enabled", false);
user_pref("calendar.integration.notify", false);
user_pref("calendar.timezone.useSystemTimezone", true);
user_pref("ui.systemUsesDarkTheme", 0);

// --- Updates, telemetry, remote services: all off.
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("app.update.disabledForTesting", true);
user_pref("app.update.checkInstallTime", false);
user_pref("app.update.staging.enabled", false);
user_pref("app.normandy.enabled", false);
user_pref("app.shield.optoutstudies.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("datareporting.policy.firstRunURL", "");
user_pref("toolkit.telemetry.enabled", false);
user_pref("toolkit.telemetry.unified", false);
user_pref("toolkit.telemetry.archive.enabled", false);
user_pref("toolkit.telemetry.server", "data:,");
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("toolkit.crashreporter.enabled", false);
user_pref("browser.crashReports.unsubmittedCheck.enabled", false);
user_pref("extensions.update.enabled", false);
user_pref("extensions.update.autoUpdateDefault", false);
user_pref("extensions.getAddons.cache.enabled", false);
user_pref("extensions.systemAddon.update.enabled", false);
user_pref("extensions.blocklist.enabled", false);
user_pref("services.settings.server", "data:,");
user_pref("browser.safebrowsing.malware.enabled", false);
user_pref("browser.safebrowsing.phishing.enabled", false);
user_pref("browser.safebrowsing.downloads.enabled", false);
user_pref("browser.safebrowsing.provider.google4.updateURL", "");
user_pref("browser.safebrowsing.provider.mozilla.updateURL", "");
user_pref("network.captive-portal-service.enabled", false);
user_pref("network.connectivity-service.enabled", false);
user_pref("captivedetect.canonicalURL", "");
user_pref("network.dns.disablePrefetch", true);
user_pref("network.prefetch-next", false);
user_pref("network.predictor.enabled", false);
user_pref("network.manage-offline-status", false);
user_pref("offline.autoDetect", false);
user_pref("security.OCSP.enabled", 0);
user_pref("security.remote_settings.crlite_filters.enabled", false);
user_pref("security.remote_settings.intermediates.enabled", false);
user_pref("media.gmp-manager.url", "data:,");
user_pref("media.gmp-gmpopenh264.enabled", false);
user_pref("geo.enabled", false);
user_pref("browser.region.update.enabled", false);
user_pref("browser.region.network.url", "");
user_pref("browser.search.region", "US");
user_pref("mailnews.auto_config_url", "");
user_pref("mailnews.auto_config.fetchFromISP.enabled", false);
user_pref("mailnews.auto_config.guess.enabled", false);
user_pref("mailnews.mx_service_url", "");
user_pref("mail.instrumentation.postUrl", "");

// --- Extension under test: installed as <profile>/extensions/<id>.xpi, enabled without interaction, unsigned.
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.startupScanScopes", 1);
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.experiments.enabled", true);
user_pref("extensions.installDistroAddons", false);
